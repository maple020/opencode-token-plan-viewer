// Isolated native check: bun test --preload @opentui/solid/preload quota-panel.ui.test.js
import { expect, test } from "bun:test";
import { plugin } from "bun";
import { createComponent, createSignal } from "solid-js";
import { createElement, insertNode, setProp, testRender } from "@opentui/solid";
import { RGBA, ScrollBoxRenderable } from "@opentui/core";

const quotaCalls = [];
const usageCalls = [];
globalThis.__quotaPanelTestQuery = (api, options) => new Promise((resolve, reject) => quotaCalls.push({ api, ...options, resolve, reject }));
globalThis.__quotaPanelTestUsage = (id, options) => new Promise(() => usageCalls.push({ id, ...options }));
plugin({ name: "isolated-quota-panel", setup(build) {
  build.onResolve({ filter: /^\.\/(quota|usage)\.js$/ }, (args) => /\/(quota-panel|panel)\.jsx$/.test(args.importer)
    ? { path: args.path, namespace: "quota-panel-test" } : undefined);
  build.onLoad({ filter: /.*/, namespace: "quota-panel-test" }, (args) => ({
    contents: args.path === "./quota.js"
      ? "export const queryQuotas = (...args) => globalThis.__quotaPanelTestQuery(...args)"
      : "export const queryUsage = (...args) => globalThis.__quotaPanelTestUsage(...args)", loader: "js",
  }));
} });
const { TokenCheckerPanel } = await import("./quota-panel.jsx");

test("combined native quota panel: placeholders, balances, stale/auth states, widths and cleanup", async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const timers = new Map();
  globalThis.setInterval = (fn, ms) => {
    if (ms !== 60000 && ms !== 5000) return originalInterval(fn, ms);
    const handle = { ms };
    timers.set(handle, fn);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    if (!timers.delete(handle)) originalClear(handle);
  };
  const layers = [];
  let disposedLayers = 0;
  const api = { keymap: { registerLayer(layer) {
    layers.push(layer);
    return () => { disposedLayers++; };
  } } };
  const [sessionID, setSessionID] = createSignal("session-first");
  const descendants = (node) => [node, ...node.getChildren().flatMap(descendants)];
  const data = () => ({ checkedAt: now, providers: [
    { id: "openai", label: "Codex", source: "remote", status: "ok", updatedAt: now,
      windows: [{ id: "weekly", label: "每周", remainingPercent: 90, resetAt: now + 3600000 }], balances: [] },
    { id: "deepseek", label: "DeepSeek", source: "remote", status: "ok", updatedAt: now,
      windows: [], balances: [{ currency: "CNY", amount: "30.50" }] },
  ] });
  let ui;
  let host;
  let panel;
  try {
    ui = await testRender(() => {
      host = createElement("scrollbox");
      setProp(host, "width", "100%");
      setProp(host, "height", "100%");
      setProp(host, "scrollX", false);
      panel = createComponent(TokenCheckerPanel, { api, get sessionID() { return sessionID(); } });
      insertNode(host, panel);
      return host;
    }, { width: 38, height: 70 });
    const frame = async () => { await ui.flush(); return ui.captureCharFrame(); };
    const command = (name) => layers.flatMap((layer) => layer.commands).find((item) => item.name === name).run();
    const refresh = () => { now += 2000; command("token-checker.quota-refresh"); return quotaCalls.at(-1); };
    let text = await frame();
    expect(text).toContain("剩余额度");
    expect(text.indexOf("剩余额度")).toBeLessThan(text.indexOf("模型用量"));
    for (const name of ["Codex", "DeepSeek"]) expect(text).toContain(name);
    expect(text).toContain("正在检查");
    expect(text).toContain("▸ 本会话 · 含子代理");
    expect(text).toContain("▸ 全部历史 · 本机");
    expect(usageCalls).toHaveLength(0);
    expect(quotaCalls).toHaveLength(1);
    expect(quotaCalls[0].api).toBe(api);
    expect(quotaCalls[0].force).toBe(false);
    expect([...timers.keys()].map((handle) => handle.ms)).toEqual([60000]);

    quotaCalls[0].reject(new Error("SECRET /private/credentials"));
    text = await frame();
    expect(text).toContain("检查失败");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("0%");
    for (const name of ["Codex", "DeepSeek"]) expect(text).toContain(name);
    now += 2000;
    await ui.mockMouse.click(34, 0);
    command("token-checker.quota-refresh");
    expect(quotaCalls).toHaveLength(2);
    expect(quotaCalls[1].force).toBe(true);
    const good = data();
    quotaCalls[1].resolve(good);
    text = await frame();
    expect(text).toContain("剩余 ━━━━━━━━━─ 90%");
    expect(text).toContain("余额 CNY 30.50");
    expect(text).toContain("上次检查 刚刚");
    expect(text).toContain("重置（本地）");
    expect(text.slice(text.indexOf("DeepSeek"), text.indexOf("模型用量"))).not.toContain("%");
    expect(usageCalls).toHaveLength(0);

    ui.resize(60, 70);
    for (const width of [38, 34, 30]) {
      setProp(host, "width", width);
      text = await frame();
      expect(text).toContain("余额 CNY 30.50");
      const numericRows = descendants(panel).filter((node) => /^(剩余 |余额 |重置（本地）)/.test(node.plainText ?? ""));
      expect(numericRows).toHaveLength(3);
      expect(numericRows.every((node) => node.height === 1)).toBe(true);
      expect(descendants(host).filter((node) => node instanceof ScrollBoxRenderable)).toEqual([host]);
      expect(host.scrollWidth).toBe(host.viewport.width);
    }
    setProp(host, "width", "100%");
    ui.resize(38, 70);

    refresh().reject(new Error("raw auth path should not appear"));
    text = await frame();
    expect(text).toContain("陈旧");
    expect(text.replace(/\s/g, "")).toContain("请核对当前账号");
    expect(text).toContain("90%");
    expect(text).toContain("30.50");
    expect(text).not.toContain("raw auth");

    const individualError = data();
    individualError.providers[0].status = "error";
    individualError.providers[0].message = "SECRET";
    refresh().resolve(individualError);
    text = await frame();
    expect(text).toContain("检查失败 · 剩余额度未知");
    expect(text).not.toContain("90%");
    expect(text).toContain("30.50");
    expect(text).not.toContain("SECRET");

    const authAndZeros = data();
    authAndZeros.providers[0].windows[0].remainingPercent = 0;
    authAndZeros.providers[1].balances[0].amount = "0.00";
    authAndZeros.providers.push({ id: "auth-provider", label: "其他需认证提供商", source: "remote", status: "needs-auth",
      updatedAt: null, windows: [], balances: [] });
    authAndZeros.providers.push({ id: "estimate", label: "其他提供商", source: "local-estimate", status: "ok", updatedAt: null,
      windows: [{ id: "unknown", label: "未知窗口", remainingPercent: null, resetAt: null },
        { id: "low", label: "估算窗口", remainingPercent: 30, resetAt: null }], balances: [] });
    refresh().resolve(authAndZeros);
    text = await frame();
    expect(text).toContain("剩余 ────────── 0%");
    expect(text).toContain("余额 CNY 0.00");
    expect(text).toContain("需登录/配置");
    expect(text.replace(/\s/g, "")).toContain("请登录或配置提供商后刷新");
    expect(text).toContain("旧额度不保留，请核对账号");
    expect(text).toContain("本机估算");
    expect(text).toContain("剩余 ────────── 未知");
    expect(text).toContain("尚未成功检查");
    const zero = descendants(panel).find((node) => node.plainText === "剩余 ────────── 0%");
    const low = descendants(panel).find((node) => node.plainText?.endsWith(" 30%"));
    expect(zero.fg.equals(RGBA.fromHex("#f87171"))).toBe(true);
    expect(low.fg.equals(RGBA.fromHex("#fbbf24"))).toBe(true);

    refresh().reject(new Error("another global failure"));
    text = await frame();
    expect(text).toContain("陈旧");
    expect(text).toContain("需登录/配置");

    for (const remaining of [-12.5, -0.01, 101, undefined, NaN, Infinity]) {
      const edge = data();
      edge.providers[0].windows[0].remainingPercent = remaining;
      edge.providers[0].windows[0].resetAt = Number.MAX_VALUE;
      edge.providers[0].updatedAt = Number.MAX_VALUE;
      refresh().resolve(edge);
      text = await frame();
      expect(text).toContain(`剩余 ────────── ${remaining < 0 ? `${remaining}%` : "未知"}`);
      expect(text).not.toContain("重置（本地）");
      expect(text).toContain("尚未成功检查");
      expect(text).toContain("模型用量");
      if (remaining < 0) {
        const exhausted = descendants(panel).find((node) => node.plainText?.endsWith(` ${remaining}%`));
        expect(exhausted.fg.equals(RGBA.fromHex("#f87171"))).toBe(true);
      }
    }

    const allErrors = data();
    allErrors.providers.forEach((provider) => { provider.status = "error"; });
    refresh().resolve(allErrors);
    text = await frame();
    for (const name of ["剩余额度", "Codex", "DeepSeek", "模型用量"]) expect(text).toContain(name);
    expect(text).not.toContain("90%");
    expect(text).not.toContain("30.50");
    expect(usageCalls).toHaveLength(0);

    now += 60000;
    for (const tick of timers.values()) tick();
    const pending = quotaCalls.at(-1);
    expect(pending.force).toBe(false);
    setSessionID("session-second");
    command("model-usage.session");
    await frame();
    expect(usageCalls.map((call) => call.id)).toEqual(["session-second"]);
    expect(timers.size).toBe(2);
    ui.renderer.destroy();
    ui = null;
    expect(pending.signal.aborted).toBe(true);
    expect(usageCalls[0].signal.aborted).toBe(true);
    expect(disposedLayers).toBe(2);
    expect(timers.size).toBe(0);
    const count = quotaCalls.length;
    pending.resolve(data());
    await Promise.resolve();
    command("token-checker.quota-refresh");
    expect(quotaCalls).toHaveLength(count);
  } finally {
    ui?.renderer.destroy();
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
    Date.now = originalNow;
    delete globalThis.__quotaPanelTestQuery;
    delete globalThis.__quotaPanelTestUsage;
  }
});
