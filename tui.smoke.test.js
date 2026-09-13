import { expect, test } from "bun:test";
import { plugin } from "bun";
import { testRender } from "@opentui/solid";

const queries = [];
globalThis.__modelUsageTuiSmokeQuery = async (sessionID) => {
  queries.push(sessionID);
  return {
    rows: [{
      provider: "fixture-provider",
      model: "fixture-model",
      messages: 1,
      input: 15,
      output: 4,
      reasoning: 3,
      cacheRead: 20,
      cacheWrite: 8,
      cost: 0,
      cacheHitRate: 20 / 43 * 100,
    }],
    totals: {
      messages: 1,
      input: 15,
      output: 4,
      reasoning: 3,
      cacheRead: 20,
      cacheWrite: 8,
      cost: 0,
      cacheHitRate: 20 / 43 * 100,
    },
    updatedAt: Date.now(),
  };
};

plugin({
  name: "isolated-model-usage-tui-smoke",
  setup(build) {
    build.onResolve({ filter: /^\.\/usage\.js$/ }, (args) => args.importer.endsWith("/panel.jsx")
      ? { path: "usage", namespace: "model-usage-tui-smoke" }
      : undefined);
    build.onLoad({ filter: /.*/, namespace: "model-usage-tui-smoke" }, () => ({
      contents: "export const queryUsage = (...args) => globalThis.__modelUsageTuiSmokeQuery(...args)",
      loader: "js",
    }));
  },
});

const entry = await import("./tui.jsx");

test("full TUI entry registers upstream quota and renders the companion slot", async () => {
  const registrations = [];
  const disposeCallbacks = [];
  const keymapLayers = [];
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
      current: { text: "#ffffff", textMuted: "#999999", accent: "#00ffff", warning: "#ffff00" },
    },
    kv: { get: (_key, fallback) => fallback, set: () => {} },
    event: { on: () => () => {} },
  };

  let ui;
  try {
    expect(entry.default.id).toBe("local-opencode-model-usage");
    await entry.default.tui(api, undefined, { id: "tui-smoke" });
    expect(registrations.map(({ order }) => order)).toEqual([910, 90, 920]);

    const companion = registrations.find(({ order }) => order === 920);
    ui = await testRender(
      () => companion.slots.sidebar_content({}, { session_id: "fixture-session" }),
      { width: 44, height: 24 },
    );
    await Bun.sleep(0);
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    expect(frame).toContain("模型用量");
    expect(frame).toContain("fixture-model");
    expect(frame).toContain("50 Token · 1 消息");
    expect(queries).toEqual(["fixture-session"]);
    expect(keymapLayers.flatMap(({ commands }) => commands).some(
      ({ name }) => name === "model-usage.refresh",
    )).toBe(true);
  } finally {
    ui?.renderer.destroy();
    lifecycleController.abort();
    for (const dispose of disposeCallbacks.reverse()) await dispose();
    delete globalThis.__modelUsageTuiSmokeQuery;
  }
});
