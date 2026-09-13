// Isolated UI check: bun test --preload @opentui/solid/preload ./panel.ui.test.js
import { test, expect } from "bun:test";
import { plugin } from "bun";
import { createComponent, createSignal } from "solid-js";
import { createElement, insertNode, setProp, testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";

const requests = [];
// Resolve a virtual backend even before usage.js exists; never read local history.
globalThis.__modelUsageUITestQuery = (id, { signal }) => new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject }));
plugin({ name: "isolated-model-usage-ui", setup(build) {
  build.onResolve({ filter: /^\.\/usage\.js$/ }, (args) => args.importer.endsWith("/panel.jsx")
    ? { path: "usage", namespace: "model-usage-ui-test" } : undefined);
  build.onLoad({ filter: /.*/, namespace: "model-usage-ui-test" }, () => ({
    contents: "export const queryUsage = (...args) => globalThis.__modelUsageUITestQuery(...args)", loader: "js",
  }));
} });
const { ModelUsagePanel } = await import("./panel.jsx");

test("native panel: scopes, models, stale failures, races and disposal", async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalNow = Date.now;
  const timers = new Map();
  let now = originalNow();
  Date.now = () => now;
  globalThis.setInterval = (fn, ms) => {
    if (ms !== 5000 && ms !== 60000) return originalInterval(fn, ms);
    const handle = { ms };
    timers.set(handle, fn);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    if (!timers.delete(handle)) originalClear(handle);
  };
  let ui;
  let disposed = false;
  let commands;
  let host;
  let panel;
  const descendants = (node) => [node, ...node.getChildren().flatMap(descendants)];
  const scrollboxes = (node) => descendants(node).filter((child) => child instanceof ScrollBoxRenderable);
  const [sessionID, setSessionID] = createSignal("first");
  const row = (model, extra = {}) => ({ provider: "local-provider", model, messages: 2,
    input: 100, output: 30, reasoning: 10, cacheRead: 200, cacheWrite: 100,
    cost: null, cacheHitRate: 50, ...extra });
  const result = (model, count = 1) => ({
    rows: Array.from({ length: count }, (_, i) => row(`${model}-${i}`, { reasoning: (count - i) * 10,
      cost: i === 0 ? 0 : null, cacheHitRate: i === 0 ? 0 : 50 })).reverse(),
    totals: row("total", { cost: 0, cacheHitRate: 37.5 }), updatedAt: now,
  });
  try {
    ui = await testRender(() => {
      host = createElement("scrollbox");
      setProp(host, "width", "100%");
      setProp(host, "height", "100%");
      setProp(host, "scrollX", false);
      panel = createComponent(ModelUsagePanel, {
        api: { keymap: { registerLayer(layer) { commands = layer.commands; return () => { disposed = true; }; } } },
        get sessionID() { return sessionID(); },
      });
      insertNode(host, panel);
      return host;
    }, { width: 38, height: 26 });
    const frame = async () => { await ui.renderOnce(); return ui.captureCharFrame(); };
    const run = (name) => commands.find((command) => command.name === `model-usage.${name}`).run();
    let text = await frame();
    expect(text).toContain("▸ 本会话 · 含子代理");
    expect(text).toContain("▸ 全部历史 · 本机");
    expect(requests).toHaveLength(0);
    expect(timers.size).toBe(0);
    run("refresh");
    await frame();
    expect(requests).toHaveLength(0);
    run("session");
    text = await frame();
    expect(text).toContain("▾ 本会话 · 含子代理");
    expect(text).toContain("▸ 全部历史 · 本机");
    expect([...timers.keys()].map((handle) => handle.ms)).toEqual([5000]);
    expect(requests.map((request) => request.id)).toEqual(["first"]);
    requests[0].resolve(result("model", 6));
    text = await frame();
    expect(text).toContain("模型用量");
    expect(text).toContain("本会话 · 含子代理");
    expect(text).toContain("440 Token · 2 消息");
    expect(text).toContain("缓存命中（汇总）37.5%");
    expect(text).toContain("缓存命中 ──────── 0.0%");
    for (let i = 0; i < 3; i++) expect(text).toContain(`model-${i}`);
    for (let i = 3; i < 6; i++) expect(text).not.toContain(`model-${i}`);
    expect(text.indexOf("model-0")).toBeLessThan(text.indexOf("model-1"));
    expect(text.indexOf("model-1")).toBeLessThan(text.indexOf("model-2"));
    expect(text).toContain("展开全部 6 个模型");
    expect(scrollboxes(host)).toEqual([host]);
    const collapsedHeight = panel.height;
    run("models");
    await frame();
    expect(scrollboxes(host)).toEqual([host]);
    expect(panel.height).toBe(collapsedHeight + 12);
    expect(host.scrollHeight).toBe(panel.height);
    expect(panel.height).toBeGreaterThan(host.height);
    for (let i = 0; i < 8; i++) await ui.mockMouse.scroll(10, 18, "down");
    text = await frame();
    expect(host.scrollTop).toBeGreaterThan(0);
    expect(text).toContain("model-5");
    expect(text).toContain("收起至前 3 个模型");
    for (let i = 0; i < 12; i++) await ui.mockMouse.scroll(10, 18, "up");
    expect(host.scrollTop).toBe(0);
    ui.resize(38, 65);
    text = await frame();
    for (let i = 0; i < 6; i++) expect(text).toContain(`model-${i}`);
    run("models");
    await frame();
    expect(panel.height).toBe(collapsedHeight);
    run("models");
    run("details");
    text = await frame();
    expect(text).toContain("记录成本 $0");
    expect(text).toContain("记录成本 未知");
    expect(text).toContain("非账单");
    const detailText = text.replace(/\s/g, "");
    expect(detailText).toContain("Token=输入+输出+推理+缓存读写");
    expect(detailText).toContain("缓存命中=缓存读/（输入+缓存读+缓存写）；汇总按总量计算");

    now += 5000;
    await ui.mockMouse.click(34, 4);
    run("refresh");
    expect(requests).toHaveLength(2);
    requests[1].reject(new Error("secret-token /private/path"));
    text = await frame();
    expect(text).toContain("陈旧");
    expect(text).toContain("model-0");
    expect(text).not.toContain("secret-token");

    now += 5000;
    run("refresh");
    const old = requests.at(-1);
    setSessionID("second");
    expect(await frame()).not.toContain("model-0");
    expect(old.signal.aborted).toBe(true);
    const next = requests.at(-1);
    expect(next.id).toBe("second");
    // Reasoning is separate: 515 tokens must rank above 440, despite smaller other buckets.
    next.resolve({
      rows: [row("new-0"), row("reasoning-0", { input: 10, output: 5, reasoning: 500, cacheRead: 0, cacheWrite: 0 })],
      totals: row("total", { input: 110, output: 35, reasoning: 510, messages: 4 }), updatedAt: now,
    });
    await frame();
    old.resolve(result("obsolete"));
    text = await frame();
    expect(text).toContain("new-0");
    expect(text).toContain("955 Token · 4 消息");
    expect(text).toContain("reasoning-0");
    expect(text.indexOf("reasoning-0")).toBeLessThan(text.indexOf("new-0"));
    expect(text).not.toContain("obsolete");
    ui.resize(26, 65);
    text = await frame();
    expect(text).toContain("new-0");
    expect(text).toContain("[刷新]");
    ui.resize(38, 65);

    now += 5000;
    run("refresh");
    const longModel = "模型🚀-very-long-model-name-with-version-2026-09";
    const huge = row(longModel, { provider: "本机", input: 238700000, output: 6400000,
      cacheRead: 1900000000, cacheHitRate: 88.8 });
    requests.at(-1).resolve({ rows: [huge], totals: huge, updatedAt: now });
    ui.resize(60, 65);
    for (const width of [38, 34, 30, 46, 30]) {
      // Resize the containing sidebar, not the terminal; labels track its actual cell width.
      setProp(host, "width", width);
      await ui.flush();
      text = await frame();
      const header = descendants(panel).find((node) => node.plainText?.includes(longModel));
      expect(header).toBeDefined();
      expect(header.parent.height).toBe(3);
      const lines = text.split("\n").slice(header.y, header.y + 3);
      expect(lines[0]).toContain("本机 · 模型🚀");
      expect(lines[0]).toMatch(/…|\.\.\./);
      expect(lines[1]).toContain(header.width >= 37 ? "输入 238.7M · 输出 6.4M · 缓存读 1.9B" : "入238.7M 出6.4M 读1.9B");
      expect(lines[2]).toContain("缓存命中");
      expect(lines[2]).toContain("88.8%");
      expect(header.parent.getChildren().map((node) => node.height)).toEqual([1, 1, 1]);
      expect(scrollboxes(host)).toEqual([host]);
      expect(host.scrollWidth).toBe(host.viewport.width);
    }
    setProp(host, "width", 18);
    await ui.flush();
    text = await frame();
    const emergencyHeader = descendants(panel).find((node) => node.plainText?.includes(longModel));
    const emergencyNumbers = text.split("\n")[emergencyHeader.y + 1].trim();
    expect(emergencyNumbers).toBe("入238.7M 出6.4M");
    expect(emergencyHeader.parent.height).toBe(3);
    setProp(host, "width", "100%");
    ui.resize(38, 65);

    expect(requests.every((request) => request.id !== null)).toBe(true);
    run("history");
    await frame();
    expect(requests.at(-1).id).toBe(null);
    requests.at(-1).resolve({ rows: [], totals: row("total", { input: 0, output: 0, reasoning: 0, cacheRead: 0,
      cacheWrite: 0, messages: 0, cacheHitRate: null }), updatedAt: now });
    text = await frame();
    expect(text).toContain("暂无模型用量记录");
    expect(text).toContain("0 Token · 0 消息");
    expect(text).toContain("缓存命中（汇总）未知");
    expect([...timers.keys()].map((handle) => handle.ms).sort()).toEqual([5000, 60000]);
    now += 60000;
    for (const tick of timers.values()) tick();
    const pending = requests.slice(-2);
    expect(pending.map((request) => request.id)).toEqual(["second", null]);
    run("session");
    run("history");
    await frame();
    expect(timers.size).toBe(0);
    expect(pending.every((request) => request.signal.aborted)).toBe(true);
    setSessionID(null);
    run("session");
    expect(await frame()).toContain("请先选择会话");
    expect(timers.size).toBe(0);

    ui.resize(26, 65);
    expect(await frame()).toContain("模型用量");
    run("history");
    await frame();
    const onUnmount = requests.at(-1);
    expect(onUnmount.id).toBe(null);
    ui.renderer.destroy();
    ui = null;
    expect(disposed).toBe(true);
    expect(onUnmount.signal.aborted).toBe(true);
    expect(timers.size).toBe(0);
  } finally {
    ui?.renderer.destroy();
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
    Date.now = originalNow;
    delete globalThis.__modelUsageUITestQuery;
  }
});
