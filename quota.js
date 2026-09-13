const DESIRED_PROVIDERS = [
  { id: "openai", label: "Codex" },
  { id: "deepseek", label: "DeepSeek" },
];

const MESSAGES = {
  "needs-auth": "需要登录或配置凭据",
  error: "检查失败，请稍后重试",
};

let defaultDependencies;

function abortError() {
  const error = new Error("操作已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function cleanText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return text || fallback;
}

function providerLabel(id, entries) {
  const grouped = entries.find((entry) => cleanText(entry?.group));
  if (grouped) return cleanText(grouped.group, id);
  return id.split(/[-_]/u).filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") || "未知提供商";
}

function uniqueId(value, seen, fallback) {
  const base = cleanText(value, fallback).replace(/[\s_]+/gu, "-").toLowerCase();
  let id = base;
  for (let suffix = 2; seen.has(id); suffix++) id = `${base}-${suffix}`;
  seen.add(id);
  return id;
}

function resetAt(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapWindows(entries) {
  const seen = new Set();
  return entries.flatMap((entry, index) => {
    if (typeof entry?.percentRemaining !== "number" || !Number.isFinite(entry.percentRemaining)) return [];
    const metric = entry.semantic?.metric;
    const semanticId = metric?.kind === "window" ? metric.window : undefined;
    const label = cleanText(entry.label, cleanText(entry.name, semanticId || `窗口 ${index + 1}`))
      .replace(/[:：]\s*$/u, "");
    return [{
      id: uniqueId(semanticId || entry.name, seen, `window-${index + 1}`),
      label,
      remainingPercent: entry.percentRemaining,
      resetAt: resetAt(entry.resetTimeIso),
    }];
  });
}

function validDecimal(value) {
  return typeof value === "string"
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value);
}

function mapBalances(entries) {
  const seen = new Set();
  return entries.flatMap((entry, index) => {
    if (entry?.kind !== "quantity"
      || entry.semantic?.metric?.kind !== "component"
      || entry.semantic.metric.component !== "total_balance"
      || entry.quantity?.unit?.kind !== "currency"
      || !validDecimal(entry.quantity.decimal)) return [];
    const currency = cleanText(entry.quantity.unit.code);
    if (!/^[a-z0-9._-]{1,16}$/iu.test(currency)) return [];
    return [{
      id: uniqueId(entry.name, seen, `balance-${index + 1}`),
      currency,
      amount: entry.quantity.decimal,
    }];
  });
}

function sourceFrom(entries) {
  return entries.length > 0
    && entries.every((entry) => entry?.accounting?.acquisitionMethod === "local_estimation")
    ? "local-estimate" : "remote";
}

function needsAuth(result) {
  const details = new Map((Array.isArray(result?.statusDetails) ? result.statusDetails : [])
    .filter((detail) => typeof detail?.key === "string" && typeof detail?.value === "string")
    .map((detail) => [detail.key.toLowerCase(), detail.value.toLowerCase()]));
  if (["auth_configured", "api_key_configured"].some((key) => details.get(key) === "false")) return true;
  if (["expired", "revoked", "invalid"].includes(details.get("token_status"))) return true;
  if (["missing", "unconfigured", "needs-auth"].includes(details.get("auth_state"))) return true;
  return (Array.isArray(result?.diagnostics) ? result.diagnostics : []).some((diagnostic) =>
    diagnostic?.outcome === "missing_credential" || diagnostic?.httpStatus === 401 || diagnostic?.httpStatus === 403);
}

function mapProviderResult(id, result, checkedAt, desiredLabel) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const windows = mapWindows(entries);
  const balances = mapBalances(entries);
  const status = windows.length || balances.length ? "ok" : needsAuth(result) ? "needs-auth" : "error";
  return {
    id,
    label: desiredLabel || providerLabel(id, entries),
    source: sourceFrom(entries),
    status,
    ...(status === "ok" ? { updatedAt: checkedAt, windows, balances }
      : { message: MESSAGES[status], updatedAt: null, windows: [], balances: [] }),
  };
}

function placeholder(provider, status) {
  return {
    ...provider,
    source: "remote",
    status,
    message: MESSAGES[status],
    updatedAt: null,
    windows: [],
    balances: [],
  };
}

async function loadDefaultDependencies() {
  if (!defaultDependencies) {
    const entry = import.meta.resolve("@slkiser/opencode-quota");
    defaultDependencies = Promise.all([
      import(new URL("./lib/tui-runtime.js", entry)),
      import(new URL("./lib/quota-runtime-context.js", entry)),
      import(new URL("./lib/quota-render-data.js", entry)),
    ]).then(([tuiRuntime, runtimeContext, renderData]) => ({
      createTuiQuotaClient: tuiRuntime.createTuiQuotaClient,
      getTuiRuntimeRootHints: tuiRuntime.getTuiRuntimeRootHints,
      resolveQuotaRuntimeContext: runtimeContext.resolveQuotaRuntimeContext,
      collectQuotaRenderData: renderData.collectQuotaRenderData,
    }));
  }
  return defaultDependencies;
}

async function dependencies(overrides) {
  if (overrides
    && ["createTuiQuotaClient", "getTuiRuntimeRootHints", "resolveQuotaRuntimeContext",
      "collectQuotaRenderData"].every((key) => typeof overrides[key] === "function")) {
    return overrides;
  }
  return { ...await loadDefaultDependencies(), ...overrides };
}

async function collectUpstream(api, deps, signal, force) {
  throwIfAborted(signal);
  const client = deps.createTuiQuotaClient(api);
  const roots = deps.getTuiRuntimeRootHints(api);
  const runtime = await deps.resolveQuotaRuntimeContext({ client, roots });
  throwIfAborted(signal);
  const result = await deps.collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config: { ...runtime.config, onlyCurrentModel: false, showSessionTokens: false },
    configMeta: runtime.configMeta,
    providers: runtime.providers,
    surfaceExplicitProviderIssues: true,
    formatStyle: "allWindows",
    includeAllWindowsData: true,
    bypassProviderCache: force === true,
  });
  throwIfAborted(signal);
  return result;
}

function time(now) {
  const value = typeof now === "function" ? now() : (now ?? Date.now());
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

export async function queryQuotas(api, options = {}) {
  const signal = options?.signal;
  throwIfAborted(signal);
  const deps = await dependencies(options?.dependencies);
  throwIfAborted(signal);

  const [upstream] = await Promise.allSettled([collectUpstream(api, deps, signal, options?.force)]);
  throwIfAborted(signal);

  const checkedAt = time(options?.now);
  const output = upstream.status === "fulfilled" && upstream.value && typeof upstream.value === "object"
    ? upstream.value : null;
  const results = new Map((Array.isArray(output?.providerResults) ? output.providerResults : [])
    .filter((item) => typeof item?.providerId === "string" && item.providerId.trim())
    .map((item) => [item.providerId.trim(), item.result]));
  const availability = new Map((Array.isArray(output?.availability) ? output.availability : [])
    .filter((item) => typeof item?.provider?.id === "string")
    .map((item) => [item.provider.id, item]));
  const active = new Set((Array.isArray(output?.active) ? output.active : [])
    .map((provider) => provider?.id).filter((id) => typeof id === "string" && id));

  const missingStatus = (id) => upstream.status === "rejected" || availability.get(id)?.error || active.has(id)
    || availability.get(id)?.ok ? "error" : "needs-auth";
  const openai = results.has("openai")
    ? mapProviderResult("openai", results.get("openai"), checkedAt, "Codex")
    : placeholder(DESIRED_PROVIDERS[0], missingStatus("openai"));
  const deepseek = results.has("deepseek")
    ? mapProviderResult("deepseek", results.get("deepseek"), checkedAt, "DeepSeek")
    : placeholder(DESIRED_PROVIDERS[1], missingStatus("deepseek"));

  const extraIds = [...new Set([
    ...results.keys(),
    ...active,
    ...(Array.isArray(output?.availability) ? output.availability
      .filter((item) => item?.ok).map((item) => item.provider?.id) : []),
  ])].filter((id) => typeof id === "string" && !DESIRED_PROVIDERS.some((provider) => provider.id === id));
  const extras = extraIds.map((id) => results.has(id)
    ? mapProviderResult(cleanText(id, "unknown-provider"), results.get(id), checkedAt)
    : placeholder({ id: cleanText(id, "unknown-provider"), label: providerLabel(id, []) }, "error"));

  return { providers: [openai, deepseek, ...extras], checkedAt };
}
