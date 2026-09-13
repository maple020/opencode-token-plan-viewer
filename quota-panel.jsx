/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { queryQuotas } from "./quota.js";
import { ModelUsagePanel } from "./panel.jsx";

const desired = [
  { id: "openai", label: "Codex" },
  { id: "deepseek", label: "DeepSeek" },
];
const clean = (value, fallback) => typeof value === "string"
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || fallback : fallback;
const timestamp = (value) => typeof value === "number" && value >= 0 && Number.isFinite(new Date(value).getTime());
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value <= 100;
const resetDate = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function checkedAge(value, now) {
  if (!timestamp(value)) return "尚未成功检查";
  const minutes = Math.max(0, Math.floor((now - value) / 60000));
  return `上次检查 ${minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes}分钟前`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}小时前` : `${Math.floor(minutes / 1440)}天前`}`;
}

function QuotaWindow(props) {
  const remaining = () => props.window.remainingPercent;
  const color = () => !percent(remaining()) ? props.colors().muted : remaining() < 20
    ? props.colors().error : remaining() < 40 ? props.colors().warning : props.colors().good;
  const bar = () => {
    if (!percent(remaining())) return "──────────";
    const filled = Math.max(0, Math.round(remaining() / 10));
    return "━".repeat(filled) + "─".repeat(10 - filled);
  };
  return (
    <box gap={0} minWidth={0} flexShrink={0}>
      <text fg={props.colors().muted} width="100%" height={1} wrapMode="none" truncate>
        {clean(props.window.label, "额度窗口")}
      </text>
      <text fg={color()} height={1} wrapMode="none" flexShrink={0}>
        剩余 {bar()} {percent(remaining()) ? `${remaining() < 0 ? remaining() : Number(remaining().toFixed(1))}%` : "未知"}
      </text>
      <Show when={timestamp(props.window.resetAt)}>
        <text fg={props.colors().muted} height={1} wrapMode="none" flexShrink={0}>
          重置（本地） {resetDate.format(props.window.resetAt)}
        </text>
      </Show>
    </box>
  );
}

function QuotaProvider(props) {
  const provider = () => props.provider;
  const ok = () => provider().status === "ok";
  return (
    <box gap={0} minWidth={0} flexShrink={0}>
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <text fg={props.colors().text} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
          <b>{clean(provider().label, "未知提供商")}</b>
        </text>
        <Show when={provider().source === "local-estimate"}>
          <text fg={props.colors().warning} flexShrink={0}>本机估算</text>
        </Show>
      </box>
      <Show when={ok()}>
        <Index each={provider().windows ?? []}>{(window) => (
          <QuotaWindow window={window()} colors={props.colors} />
        )}</Index>
        <Index each={provider().balances ?? []}>{(balance) => (
          <text fg={props.colors().good} height={1} wrapMode="none" flexShrink={0}>
            余额 {clean(balance().currency, "币种未知")} {clean(balance().amount, "未知")}
          </text>
        )}</Index>
        <Show when={!provider().windows?.length && !provider().balances?.length}>
          <text fg={props.colors().muted}>剩余额度未知</text>
        </Show>
        <text fg={props.colors().muted} wrapMode="word">{checkedAge(provider().updatedAt, props.now())}</text>
      </Show>
      <Show when={provider().status === "needs-auth"}>
        <text fg={props.colors().warning}>需登录/配置</text>
        <text fg={props.colors().muted} wrapMode="word">
          请登录或配置提供商后刷新
        </text>
        <text fg={props.colors().muted} wrapMode="word">旧额度不保留，请核对账号</text>
      </Show>
      <Show when={provider().status === "error"}>
        <text fg={props.colors().warning} wrapMode="word">检查失败 · 剩余额度未知</text>
        <text fg={props.colors().muted} wrapMode="word">请稍后刷新重试</text>
      </Show>
      <Show when={!provider().status}>
        <text fg={props.colors().muted}>{props.loading() ? "正在检查…" : "尚无可用额度"}</text>
      </Show>
    </box>
  );
}

function RemainingQuotaPanel(props) {
  const [snapshot, setSnapshot] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let disposed = false;
  let busy = false;
  let lastStart = -Infinity;
  let controller;
  let timer;
  const colors = () => {
    const theme = props.api?.theme?.current;
    return {
      text: theme?.text ?? "#e5e7eb", muted: theme?.textMuted ?? "#9ca3af",
      accent: theme?.accent ?? theme?.primary ?? "#67e8cf",
      good: theme?.success ?? "#67e8cf", warning: theme?.warning ?? "#fbbf24",
      error: theme?.error ?? "#f87171",
    };
  };
  const providers = createMemo(() => {
    const loaded = snapshot()?.providers ?? [];
    return [...desired.map((item) => loaded.find((provider) => provider.id === item.id) ?? item),
      ...loaded.filter((provider) => !desired.some((item) => item.id === provider.id))];
  });
  async function refresh(force = false) {
    if (disposed || busy || Date.now() - lastStart < 1000) return;
    busy = true;
    lastStart = Date.now();
    controller = new AbortController();
    setLoading(true);
    try {
      const result = await queryQuotas(props.api, { signal: controller.signal, force });
      if (disposed) return;
      // Replace provider results rather than carrying values across auth/account changes.
      setSnapshot(result);
      setFailed(false);
    } catch {
      // Keep only this mounted instance's snapshot; never print raw API errors.
      if (!disposed) setFailed(true);
    } finally {
      busy = false;
      if (!disposed) {
        setNow(Date.now());
        setLoading(false);
      }
    }
  }
  const manualRefresh = () => refresh(true);
  const unregister = props.api?.keymap?.registerLayer({
    commands: [{ namespace: "palette", name: "token-checker.quota-refresh", title: "剩余额度：刷新",
      category: "剩余额度", run: manualRefresh }],
    bindings: [],
  });
  onMount(() => {
    void refresh();
    timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 60000);
  });
  onCleanup(() => {
    disposed = true;
    controller?.abort();
    clearInterval(timer);
    unregister?.();
  });
  return (
    <box gap={1} minWidth={0} flexShrink={0}>
      <box gap={0} minWidth={0} flexShrink={0}>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={colors().text}><b>剩余额度</b></text>
          <text fg={loading() ? colors().muted : colors().accent} flexShrink={0} onMouseDown={manualRefresh}>
            {loading() ? "[检查中]" : "[刷新]"}
          </text>
        </box>
        <text fg={colors().muted} wrapMode="word">提供商数据 · 可能有缓存</text>
        <Show when={failed()}>
          <text fg={colors().warning} wrapMode="word">
            {snapshot() ? "陈旧 · 检查失败，请核对当前账号" : "检查失败，请稍后刷新"}
          </text>
          <Show when={snapshot()}>
            <text fg={colors().muted} wrapMode="word">{checkedAge(snapshot().checkedAt, now())}</text>
          </Show>
        </Show>
      </box>
      <Index each={providers()}>{(provider) => (
        <QuotaProvider provider={provider()} colors={colors} loading={loading} now={now} />
      )}</Index>
    </box>
  );
}

// One slot owns the order; model scopes stay collapsed until explicitly opened.
export function TokenCheckerPanel(props) {
  return (
    <box gap={1} minWidth={0} flexShrink={0}>
      <RemainingQuotaPanel api={props.api} />
      <ModelUsagePanel api={props.api} sessionID={props.sessionID} />
    </box>
  );
}
