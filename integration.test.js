import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import upstreamServerModule from "@slkiser/opencode-quota";
import { createUpstreamTuiApi } from "./integration.js";
import serverModule from "./server.js";

test("server entry forwards the upstream default server module", () => {
  assert.strictEqual(serverModule, upstreamServerModule);
  assert.deepEqual(Object.keys(serverModule).sort(), ["id", "server"]);
  assert.equal(serverModule.id, "@slkiser/opencode-quota");
  assert.equal(typeof serverModule.server, "function");
});

test("TUI api forwards registrations and only reorders sidebar slots", () => {
  const calls = [];
  const handles = [{ id: "sidebar" }, { id: "other" }];
  const slots = {
    register(registration, marker) {
      assert.strictEqual(this, slots);
      calls.push({ registration, marker });
      return handles[calls.length - 1];
    },
    owner() {
      return this;
    },
  };
  const api = { value: 42 };
  Object.defineProperties(api, {
    slots: {
      enumerable: true,
      get() {
        assert.strictEqual(this, api);
        return slots;
      },
    },
    hidden: {
      configurable: true,
      enumerable: false,
      get() {
        assert.strictEqual(this, api);
        return this.value;
      },
    },
    owner: {
      configurable: true,
      value() {
        return this;
      },
    },
  });

  const forwarded = createUpstreamTuiApi(api);
  assert.notStrictEqual(forwarded, api);
  assert.strictEqual(forwarded.hidden, 42);
  assert.equal(Object.getOwnPropertyDescriptor(forwarded, "hidden").enumerable, false);
  assert.strictEqual(forwarded.owner(), api);
  assert.strictEqual(forwarded.slots.owner(), slots);

  const sidebarCallback = () => null;
  const sidebar = Object.freeze({
    order: 150,
    slots: Object.freeze({ sidebar_content: sidebarCallback }),
  });
  assert.strictEqual(forwarded.slots.register(sidebar, "sidebar-marker"), handles[0]);
  assert.notStrictEqual(calls[0].registration, sidebar);
  assert.equal(calls[0].registration.order, 910);
  assert.strictEqual(calls[0].registration.slots, sidebar.slots);
  assert.strictEqual(calls[0].registration.slots.sidebar_content, sidebarCallback);
  assert.equal(calls[0].marker, "sidebar-marker");
  assert.equal(sidebar.order, 150);

  const otherCallback = () => null;
  const other = { order: 90, slots: { home_bottom: otherCallback } };
  assert.strictEqual(forwarded.slots.register(other, "other-marker"), handles[1]);
  assert.strictEqual(calls[1].registration, other);
  assert.equal(calls[1].registration.order, 90);
  assert.strictEqual(calls[1].registration.slots.home_bottom, otherCallback);
  assert.equal(calls[1].marker, "other-marker");
  assert.strictEqual(api.slots, slots);
});

test("quota config example contains the bounded display settings", async () => {
  const config = JSON.parse(
    await readFile(new URL("./quota-toast.example.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(config, {
    enabled: true,
    enabledProviders: "auto",
    onlyCurrentModel: false,
    percentDisplayMode: "remaining",
    formatStyle: "allWindows",
    accountingDetail: "detailed",
    minIntervalMs: 60000,
    enableToast: false,
    tuiSidebarPanel: { enabled: true, formatStyle: "allWindows" },
    showSessionTokens: false,
    tuiCompactStatus: { enabled: false, homeBottom: false, sessionPrompt: false },
    tuiPromptBar: { enabled: false },
    maintainerAnnouncements: { enabled: false, home: false },
    resetNotifications: { enabled: false },
  });
});
