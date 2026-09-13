import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import upstreamServerModule from "@slkiser/opencode-quota";
import serverModule from "./server.js";

test("server entry forwards the upstream default server module", () => {
  assert.strictEqual(serverModule, upstreamServerModule);
  assert.deepEqual(Object.keys(serverModule).sort(), ["id", "server"]);
  assert.equal(serverModule.id, "@slkiser/opencode-quota");
  assert.equal(typeof serverModule.server, "function");
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
