import { expect, test } from "bun:test";
import { plugin } from "bun";
import { testRender } from "@opentui/solid";

const quotaCalls = [];
const usageCalls = [];
globalThis.__tokenCheckerTuiQuota = (api, options) => new Promise((resolve, reject) => {
  quotaCalls.push({ api, ...options, resolve, reject });
});
globalThis.__tokenCheckerTuiUsage = (id, options) => new Promise((resolve, reject) => {
  usageCalls.push({ id, ...options, resolve, reject });
});

plugin({
  name: "isolated-token-checker-tui-smoke",
  setup(build) {
    build.onResolve({ filter: /^\.\/(quota|usage)\.js$/ }, (args) =>
      /\/(quota-panel|panel)\.jsx$/u.test(args.importer)
        ? { path: args.path, namespace: "token-checker-tui-smoke" }
        : undefined);
    build.onLoad({ filter: /.*/, namespace: "token-checker-tui-smoke" }, (args) => ({
      contents: args.path === "./quota.js"
        ? "export const queryQuotas = (...args) => globalThis.__tokenCheckerTuiQuota(...args)"
        : "export const queryUsage = (...args) => globalThis.__tokenCheckerTuiUsage(...args)",
      loader: "js",
    }));
  },
});

const entry = await import("./tui.jsx");

test("actual TUI entry owns one combined sidebar through pending, partial and unavailable states", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const registrations = [];
  const keymapLayers = [];
  const disposeCallbacks = [];
  const lifecycleController = new AbortController();
  const slots = {
    register(registration) {
      expect(this).toBe(slots);
      registrations.push(registration);
      return `slot-${registrations.length}`;
    },
  };
  const api = {
    slots,
    lifecycle: {
      signal: lifecycleController.signal,
      onDispose(callback) {
        disposeCallbacks.push(callback);
        return () => {};
      },
    },
    keymap: {
      registerLayer(layer) {
        keymapLayers.push(layer);
        return () => {};
      },
    },
    state: {
      path: { worktree: process.cwd(), directory: process.cwd() },
      provider: [],
      session: { get: () => undefined, messages: () => [], status: () => ({ type: "idle" }) },
    },
    client: {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({ data: { providers: [] } }),
      },
    },
    theme: {
      current: {
        text: "#ffffff", textMuted: "#999999", accent: "#00ffff",
        success: "#00ff99", warning: "#ffff00", error: "#ff0000",
      },
    },
    kv: { get: (_key, fallback) => fallback, set: () => {} },
    event: { on: () => () => {} },
  };

  const partial = () => ({
    checkedAt: now,
    providers: [
      {
        id: "openai", label: "Codex", source: "remote", status: "ok", updatedAt: now,
        windows: [{ id: "weekly", label: "Weekly", remainingPercent: 90, resetAt: now + 3_600_000 }],
        balances: [],
      },
      {
        id: "deepseek", label: "DeepSeek", source: "remote", status: "ok", updatedAt: now,
        windows: [], balances: [{ id: "cny", currency: "CNY", amount: "30.50" }],
      },
      {
        id: "anthropic", label: "Anthropic", source: "remote",
        status: "needs-auth", message: "需要登录或配置凭据", updatedAt: null, windows: [], balances: [],
      },
    ],
  });
  const unavailable = () => ({
    checkedAt: now,
    providers: [
      { id: "openai", label: "Codex", source: "remote", status: "needs-auth", updatedAt: null, windows: [], balances: [] },
      { id: "deepseek", label: "DeepSeek", source: "remote", status: "error", updatedAt: null, windows: [], balances: [] },
    ],
  });

  let ui;
  try {
    expect(entry.default.id).toBe("local-opencode-model-usage");
    await entry.default.tui(api, undefined, { id: "tui-smoke" });
    expect(registrations).toHaveLength(1);
    expect(registrations[0].order).toBe(910);
    expect(Object.keys(registrations[0].slots)).toEqual(["sidebar_content"]);

    ui = await testRender(
      () => registrations[0].slots.sidebar_content({}, { session_id: "fixture-session" }),
      { width: 44, height: 60 },
    );
    const frame = async () => {
      await ui.flush();
      return ui.captureCharFrame();
    };
    const quotaRefresh = () => keymapLayers.flatMap(({ commands }) => commands)
      .find(({ name }) => name === "token-checker.quota-refresh").run();

    let text = await frame();
    expect(quotaCalls).toHaveLength(1);
    expect(quotaCalls[0].api).toBe(api);
    expect(quotaCalls[0].force).toBe(false);
    expect(text).toContain("剩余额度");
    expect(text.indexOf("剩余额度")).toBeLessThan(text.indexOf("模型用量"));
    expect(text).toContain("正在检查");
    expect(text).toContain("▸ 本会话 · 含子代理");
    expect(text).toContain("▸ 全部历史 · 本机");
    expect(usageCalls).toHaveLength(0);

    quotaCalls[0].resolve(partial());
    text = await frame();
    expect(text).toContain("剩余 ━━━━━━━━━─ 90%");
    expect(text).toContain("余额 CNY 30.50");
    expect(text).toContain("Anthropic");
    expect(text).toContain("需登录/配置");
    expect(text.indexOf("90%")).toBeLessThan(text.indexOf("模型用量"));
    expect(usageCalls).toHaveLength(0);

    now += 2_000;
    quotaRefresh();
    expect(quotaCalls).toHaveLength(2);
    expect(quotaCalls[1].force).toBe(true);
    quotaCalls[1].reject(new Error("SECRET /private/credentials"));
    text = await frame();
    expect(text).toContain("剩余额度");
    expect(text).toContain("陈旧");
    expect(text).toContain("90%");
    expect(text).not.toContain("SECRET");

    now += 2_000;
    quotaRefresh();
    expect(quotaCalls).toHaveLength(3);
    quotaCalls[2].resolve(unavailable());
    text = await frame();
    for (const label of ["剩余额度", "Codex", "DeepSeek", "模型用量"]) {
      expect(text).toContain(label);
    }
    expect(text.indexOf("剩余额度")).toBeLessThan(text.indexOf("模型用量"));
    expect(text).not.toContain("90%");
    expect(text).not.toContain("30.50");
    expect(usageCalls).toHaveLength(0);
  } finally {
    ui?.renderer.destroy();
    lifecycleController.abort();
    for (const dispose of disposeCallbacks.reverse()) await dispose();
    Date.now = originalNow;
    delete globalThis.__tokenCheckerTuiQuota;
    delete globalThis.__tokenCheckerTuiUsage;
  }
});
