import assert from "node:assert/strict";
import test from "node:test";
import { queryQuotas } from "./quota.js";

const NOW = 1_789_000_000_000;

const emptyRender = (extra = {}) => ({
  selection: {}, availability: [], active: [], providerResults: [], data: null, ...extra,
});

function fixtureDependencies({ render = emptyRender(), onCollect, onRuntime } = {}) {
  const client = { fixture: "client" };
  const roots = { fixture: "roots" };
  const runtime = {
    client,
    roots,
    config: { enabled: true, minIntervalMs: 60_000, onlyCurrentModel: true, showSessionTokens: true },
    configMeta: { settingSources: {} },
    providers: [{ id: "openai" }, { id: "deepseek" }],
    resolveRuntimeProviderIds: () => [],
  };
  return {
    createTuiQuotaClient(api) {
      assert.equal(api.fixture, "api");
      return client;
    },
    getTuiRuntimeRootHints(api) {
      assert.equal(api.fixture, "api");
      return roots;
    },
    async resolveQuotaRuntimeContext(params) {
      onRuntime?.(params);
      return runtime;
    },
    async collectQuotaRenderData(params) {
      onCollect?.(params);
      return typeof render === "function" ? render() : render;
    },
  };
}

const accounting = (acquisitionMethod = "remote_api") => ({
  resultType: "rate_limit", acquisitionMethod, ownership: "maintained", authority: "provider_reported",
});

test("maps real normalized Codex windows and exact DeepSeek total-balance decimals", async () => {
  let collected;
  let runtimeInput;
  const render = emptyRender({
    availability: [
      { provider: { id: "openai" }, ok: true },
      { provider: { id: "deepseek" }, ok: true },
      { provider: { id: "anthropic" }, ok: true },
    ],
    active: [{ id: "openai" }, { id: "deepseek" }, { id: "anthropic" }],
    providerResults: [
      {
        providerId: "openai",
        result: {
          attempted: true,
          errors: [],
          entries: [{
            accounting: accounting(), name: "Codex Weekly", group: "OpenAI (Codex)", label: "Weekly:",
            semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
            percentRemaining: 90, resetTimeIso: "2026-09-20T02:17:16Z",
          }],
        },
      },
      {
        providerId: "deepseek",
        result: {
          attempted: true,
          errors: [],
          entries: [
            {
              kind: "quantity", accounting: { ...accounting(), resultType: "balance" },
              name: "deepseek-cny-total-balance", group: "DeepSeek",
              semantic: { metric: { kind: "component", component: "total_balance" }, prominence: "primary" },
              quantity: { decimal: "30.50", unit: { kind: "currency", code: "CNY" } },
            },
            {
              kind: "quantity", accounting: { ...accounting(), resultType: "balance" },
              name: "deepseek-cny-granted-balance", group: "DeepSeek",
              semantic: { metric: { kind: "component", component: "granted_balance" }, prominence: "supplementary" },
              quantity: { decimal: "99.99", unit: { kind: "currency", code: "CNY" } },
            },
          ],
        },
      },
      {
        providerId: "anthropic",
        result: {
          attempted: true, errors: [], entries: [{
            accounting: accounting(), name: "Claude 5h", group: "Anthropic", label: "5h:",
            percentRemaining: 75, resetTimeIso: "invalid",
          }],
        },
      },
    ],
  });
  const dependencies = fixtureDependencies({
    render,
    onCollect(value) { collected = value; },
    onRuntime(value) { runtimeInput = value; },
  });

  const result = await queryQuotas({ fixture: "api" }, { dependencies, force: true, now: () => NOW });
  assert.deepEqual(result.providers.map(({ id }) => id), [
    "openai", "deepseek", "anthropic",
  ]);
  assert.deepEqual(result.providers[0], {
    id: "openai", label: "Codex", source: "remote", status: "ok", updatedAt: NOW,
    windows: [{
      id: "week", label: "Weekly", remainingPercent: 90,
      resetAt: Date.parse("2026-09-20T02:17:16Z"),
    }],
    balances: [],
  });
  assert.deepEqual(result.providers[1].balances, [
    { id: "deepseek-cny-total-balance", currency: "CNY", amount: "30.50" },
  ]);
  assert.equal(result.providers[2].windows[0].resetAt, null);
  assert.equal(result.checkedAt, NOW);
  assert.deepEqual(runtimeInput, { client: collected.client, roots: { fixture: "roots" } });
  assert.equal(collected.config.onlyCurrentModel, false);
  assert.equal(collected.config.showSessionTokens, false);
  assert.equal(collected.config.minIntervalMs, 60_000);
  assert.equal(collected.surfaceExplicitProviderIssues, true);
  assert.equal(collected.formatStyle, "allWindows");
  assert.equal(collected.includeAllWindowsData, true);
  assert.equal(collected.bypassProviderCache, true);
});

test("keeps the two desired providers visible when every upstream source is unavailable", async () => {
  const render = emptyRender({
    availability: [
      { provider: { id: "openai" }, ok: false },
      { provider: { id: "deepseek" }, ok: false },
      { provider: { id: "anthropic" }, ok: false },
    ],
  });
  const result = await queryQuotas({ fixture: "api" }, {
    dependencies: fixtureDependencies({ render }), now: NOW,
  });
  assert.deepEqual(result.providers.map(({ id, status }) => [id, status]), [
    ["openai", "needs-auth"],
    ["deepseek", "needs-auth"],
  ]);
  assert.ok(result.providers.every((provider) => provider.updatedAt === null
    && provider.windows.length === 0 && provider.balances.length === 0));
});

test("classifies missing Codex auth separately from sanitized provider failures", async () => {
  const secret = "Bearer private-token /Users/private/auth.json";
  const render = emptyRender({
    availability: [
      { provider: { id: "openai" }, ok: false },
      { provider: { id: "deepseek" }, ok: true },
    ],
    active: [{ id: "deepseek" }],
    providerResults: [{
      providerId: "deepseek",
      result: {
        attempted: true, entries: [], errors: [{ label: "DeepSeek", message: secret }],
        statusDetails: [{ key: "api_key_configured", value: "true" }],
      },
    }],
  });
  const result = await queryQuotas({ fixture: "api" }, {
    dependencies: fixtureDependencies({ render }), now: NOW,
  });
  assert.equal(result.providers[0].status, "needs-auth");
  assert.equal(result.providers[1].status, "error");
  assert.equal(result.providers[1].message, "检查失败，请稍后重试");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("returns sanitized error placeholders when collection fails", async () => {
  const dependencies = fixtureDependencies({ render: () => { throw new Error("token=/private/secret"); } });
  const result = await queryQuotas({ fixture: "api" }, { dependencies, now: NOW });
  assert.deepEqual(result.providers.map(({ id, status }) => [id, status]), [
    ["openai", "error"], ["deepseek", "error"],
  ]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("ignores malformed percentages without clamping valid zero or over-use", async () => {
  const render = emptyRender({
    active: [{ id: "openai" }],
    providerResults: [{
      providerId: "openai",
      result: {
        attempted: true, errors: [], entries: [
          { accounting: accounting(), name: "null", percentRemaining: null },
          { accounting: accounting(), name: "string", percentRemaining: "0" },
          { accounting: accounting(), name: "nan", percentRemaining: Number.NaN },
          { accounting: accounting(), name: "zero", label: "Zero:", percentRemaining: 0 },
          { accounting: accounting(), name: "over", label: "Over:", percentRemaining: -12.5 },
        ],
      },
    }],
  });
  const result = await queryQuotas({ fixture: "api" }, {
    dependencies: fixtureDependencies({ render }), now: NOW,
  });
  assert.deepEqual(result.providers[0].windows.map(({ label, remainingPercent }) => [label, remainingPercent]), [
    ["Zero", 0], ["Over", -12.5],
  ]);
});

test("keeps local upstream estimates as extra providers", async () => {
  const render = emptyRender({
    availability: [{ provider: { id: "local-provider" }, ok: true }],
    active: [{ id: "local-provider" }],
    providerResults: [{
      providerId: "local-provider",
      result: {
        attempted: true, errors: [], entries: [{
          accounting: accounting("local_estimation"), name: "Local weekly", group: "Local Provider",
          label: "Weekly:", percentRemaining: 42,
        }],
      },
    }],
  });
  const result = await queryQuotas({ fixture: "api" }, {
    dependencies: fixtureDependencies({ render }), now: NOW,
  });
  const provider = result.providers.find(({ id }) => id === "local-provider");
  assert.equal(provider.source, "local-estimate");
  assert.equal(provider.windows[0].remainingPercent, 42);
});

test("honors caller cancellation before and after the upstream await", async () => {
  const before = AbortSignal.abort("private reason");
  let called = false;
  const dependencies = fixtureDependencies();
  dependencies.createTuiQuotaClient = () => { called = true; };
  await assert.rejects(
    queryQuotas({ fixture: "api" }, { dependencies, signal: before }),
    (error) => error.name === "AbortError" && !error.message.includes("private reason"),
  );
  assert.equal(called, false);

  const controller = new AbortController();
  let release;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const pendingDependencies = fixtureDependencies({ render: () => new Promise((resolve) => {
    release = resolve;
    started();
  }) });
  const pending = queryQuotas({ fixture: "api" }, {
    dependencies: pendingDependencies, signal: controller.signal, now: NOW,
  });
  await didStart;
  controller.abort("private reason");
  release(emptyRender());
  await assert.rejects(
    pending,
    (error) => error.name === "AbortError" && !error.message.includes("private reason"),
  );
});
