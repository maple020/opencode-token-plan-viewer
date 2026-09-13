/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, Index, onCleanup, Show, untrack } from "solid-js";
import { queryUsage } from "./usage.js";

const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const number = (value) => valid(value) ? compact.format(value) : "未知";
function modelNumbers(row, width) {
  const values = [row.input, row.output, row.cacheRead].map(number);
  // Formatted numbers are ASCII; 未知 and the Chinese labels use two cells per character.
  const sizes = values.map((value) => value === "未知" ? 4 : value.length);
  if (sizes.reduce((sum, size) => sum + size, 0) + 23 <= width) {
    return `输入 ${values[0]} · 输出 ${values[1]} · 缓存读 ${values[2]}`;
  }
  const items = values.map((value, index) => `${["入", "出", "读"][index]}${value}`);
  let used = 0;
  return items.filter((_, index) => {
    used += sizes[index] + 2 + (index ? 1 : 0);
    return used <= width;
  }).join(" ");
}
const tokens = (row) => {
  const values = [row?.input, row?.output, row?.reasoning, row?.cacheRead, row?.cacheWrite];
  return values.every(valid) ? values.reduce((sum, value) => sum + value, 0) : null;
};
const label = (value, fallback) => typeof value === "string"
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || fallback : fallback;
const cost = (value) => !valid(value) ? "未知" : value === 0 ? "$0" : value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;
const age = (updatedAt, now) => {
  if (!valid(updatedAt)) return "更新时间未知";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  return seconds < 5 ? "刚刚更新" : seconds < 60 ? `${seconds}秒前更新`
    : seconds < 3600 ? `${Math.floor(seconds / 60)}分钟前更新`
    : seconds < 86400 ? `${Math.floor(seconds / 3600)}小时前更新`
    : `${Math.floor(seconds / 86400)}天前更新`;
};

function useUsageScope(key, interval, initiallyOpen) {
  const [open, setOpen] = createSignal(initiallyOpen);
  const [snapshot, setSnapshot] = createSignal(null);
  const [failed, setFailed] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [all, setAll] = createSignal(false);
  const [details, setDetails] = createSignal(false);
  let previousKey;
  let refresh = () => {};

  createEffect(() => {
    const id = key();
    const expanded = open();
    if (id !== previousKey) {
      previousKey = id;
      setSnapshot(null);
      setFailed(false);
      setAll(false);
      setDetails(false);
    }
    setLoading(false);
    refresh = () => {};
    // undefined means no selected session; null is exclusively all local history.
    if (!expanded || id === undefined) return;
    let disposed = false;
    let busy = false;
    let lastStart = -Infinity;
    let controller;
    const load = async () => {
      if (disposed || busy || Date.now() - lastStart < 1000) return;
      busy = true;
      lastStart = Date.now();
      controller = new AbortController();
      setLoading(true);
      try {
        const result = await queryUsage(id, { signal: controller.signal });
        if (disposed || key() !== id) return;
        setSnapshot({ key: id, result });
        setFailed(false);
      } catch {
        // Never surface backend messages: they can contain local paths or secrets.
        if (!disposed && key() === id) setFailed(true);
      } finally {
        busy = false;
        if (!disposed && key() === id) {
          setNow(Date.now());
          setLoading(false);
        }
      }
    };
    refresh = load;
    untrack(load);
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, interval);
    onCleanup(() => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
    });
  });

  return {
    open, all, details, failed, loading, now,
    available: () => key() !== undefined,
    data: () => snapshot()?.key === key() ? snapshot()?.result : null,
    toggle: () => setOpen((value) => !value),
    toggleAll: () => setAll((value) => !value),
    toggleDetails: () => setDetails((value) => !value),
    refresh: () => refresh(),
  };
}

function CacheHit(props) {
  const rate = () => valid(props.rate) && props.rate <= 100 ? props.rate : null;
  const bar = () => {
    if (rate() === null) return "────────";
    const filled = Math.round(rate() / 100 * 8);
    return "━".repeat(filled) + "─".repeat(8 - filled);
  };
  return (
    <text wrapMode="none" height={1} flexShrink={0} fg={props.colors().muted}>
      {props.summary ? "缓存命中（汇总）" : "缓存命中 "}
      <span fg={props.colors().accent}>{props.summary ? "" : `${bar()} `}</span>
      {rate() === null ? "未知" : `${rate().toFixed(1)}%`}
    </text>
  );
}

function ScopeView(props) {
  const scope = props.scope;
  const [modelWidth, setModelWidth] = createSignal(0);
  const rows = createMemo(() => [...(scope.data()?.rows ?? [])].sort((a, b) =>
    (tokens(b) ?? -1) - (tokens(a) ?? -1)));
  const visible = createMemo(() => scope.all() ? rows() : rows().slice(0, 3));
  return (
    <box gap={0} minWidth={0} flexShrink={0}>
      <text fg={props.colors().text} wrapMode="word" onMouseDown={scope.toggle}>
        <b>{scope.open() ? "▾ " : "▸ "}{props.title}</b>
      </text>
      <Show when={scope.open()}>
        <box paddingLeft={1} gap={0} minWidth={0} flexShrink={0}>
          <Show when={scope.available()} fallback={<text fg={props.colors().muted}>请先选择会话</text>}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <text fg={scope.failed() ? props.colors().warning : props.colors().muted} wrapMode="word" flexShrink={1}>
                {scope.failed() ? (scope.data() ? "陈旧 · " : "读取失败 · ") : ""}
                {scope.data() ? age(scope.data().updatedAt, scope.now()) : scope.loading() ? "正在读取…" : "尚未更新"}
              </text>
              <text fg={scope.loading() ? props.colors().muted : props.colors().accent} flexShrink={0} onMouseDown={scope.refresh}>
                {scope.loading() ? "[读取中]" : "[刷新]"}
              </text>
            </box>
            <Show when={scope.failed()}>
              <text fg={props.colors().warning} wrapMode="word">本机记录暂不可用，可重试</text>
            </Show>
            <Show when={scope.data()}>
              <text fg={props.colors().text} wrapMode="word">
                <b>{number(tokens(scope.data()?.totals))}</b> Token · {number(scope.data()?.totals?.messages)} 消息
              </text>
              <CacheHit summary rate={scope.data()?.totals?.cacheHitRate} colors={props.colors} />
              <Show when={rows().length > 0} fallback={<text fg={props.colors().muted}>暂无模型用量记录</text>}>
                <box gap={1} paddingTop={1} width="100%" minWidth={0} flexShrink={0}
                  onSizeChange={function () { setModelWidth(this.width); }}>
                  <Index each={visible()}>{(row) => (
                    <box gap={0} minWidth={0} flexShrink={0}>
                      <text fg={props.colors().text} width="100%" wrapMode="none" truncate height={1} flexShrink={0}>
                        <span fg={props.colors().muted}>{label(row().provider, "未知提供商")} · </span>
                        <b>{label(row().model, "未知模型")}</b>
                      </text>
                      <text fg={props.colors().muted} wrapMode="none" height={1} flexShrink={0}>
                        {modelNumbers(row(), modelWidth())}
                      </text>
                      <CacheHit rate={row().cacheHitRate} colors={props.colors} />
                      <Show when={scope.details()}>
                        <text fg={props.colors().muted} wrapMode="word">
                          推理 {number(row().reasoning)} · 缓存写 {number(row().cacheWrite)}
                        </text>
                        <text fg={props.colors().muted} wrapMode="word">
                          {number(row().messages)} 消息 · 记录成本 {cost(row().cost)}
                        </text>
                      </Show>
                    </box>
                  )}</Index>
                </box>
                <Show when={rows().length > 3}>
                  <text fg={props.colors().accent} wrapMode="word" onMouseDown={scope.toggleAll}>
                    {scope.all() ? "[收起至前 3 个模型]" : `[展开全部 ${rows().length} 个模型]`}
                  </text>
                </Show>
                <text fg={props.colors().accent} onMouseDown={scope.toggleDetails}>
                  {scope.details() ? "[收起明细]" : "[查看明细]"}
                </text>
                <Show when={scope.details()}>
                  <text fg={props.colors().muted} wrapMode="word">
                    合计记录成本 {cost(scope.data()?.totals?.cost)} · 非账单
                  </text>
                  <text fg={props.colors().muted} wrapMode="word">入 / 出 / 读 = 输入 / 输出 / 缓存读。Token = 输入 + 输出 + 推理 + 缓存读写；按 Token 排序。缓存命中 = 缓存读 /（输入 + 缓存读 + 缓存写）；汇总按总量计算</text>
                </Show>
              </Show>
            </Show>
          </Show>
        </box>
      </Show>
    </box>
  );
}

// The wrapper owns slot registration (order 920); this component owns only its UI lifecycle.
export function ModelUsagePanel(props) {
  const colors = () => {
    const theme = props.api?.theme?.current;
    return {
      text: theme?.text ?? "#e5e7eb",
      muted: theme?.textMuted ?? "#9ca3af",
      accent: theme?.accent ?? theme?.primary ?? "#67e8cf",
      warning: theme?.warning ?? "#fbbf24",
    };
  };
  const current = useUsageScope(() => typeof props.sessionID === "string" && props.sessionID.trim()
    ? props.sessionID : undefined, 5000, false);
  const history = useUsageScope(() => null, 60000, false);
  const forOpen = (action) => () => {
    for (const scope of [current, history]) if (scope.open()) scope[action]();
  };
  // Palette commands do not intercept typing or override host key bindings.
  const dispose = props.api?.keymap?.registerLayer({
    commands: [
      ["refresh", "刷新已展开范围", forOpen("refresh")],
      ["session", "展开 / 收起本会话", current.toggle],
      ["history", "展开 / 收起全部历史", history.toggle],
      ["models", "切换已展开范围的全部模型", forOpen("toggleAll")],
      ["details", "切换已展开范围的明细", forOpen("toggleDetails")],
    ].map(([name, title, run]) => ({
      namespace: "palette", name: `model-usage.${name}`, title: `模型用量：${title}`,
      category: "模型用量", run,
    })),
    bindings: [],
  });
  onCleanup(() => dispose?.());
  return (
    <box gap={1} minWidth={0} flexShrink={0}>
      <box gap={0}>
        <text fg={colors().text}><b>模型用量</b></text>
        <text fg={colors().muted} wrapMode="word">本机记录 · 非剩余额度</text>
      </box>
      <ScopeView title="本会话 · 含子代理" scope={current} colors={colors} />
      <ScopeView title="全部历史 · 本机" scope={history} colors={colors} />
    </box>
  );
}
