import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryUsage } from "./usage.js";

const TEMP_ROOT = process.env.OPENCODE_TEST_TMPDIR || tmpdir();

async function openWritable(path) {
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { create: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}

async function fixture(t, setup, schema = `
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data JSON NOT NULL);
  CREATE INDEX message_session_idx ON message(session_id);
`) {
  await access(TEMP_ROOT);
  const directory = await mkdtemp(join(TEMP_ROOT, "model-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "usage.db");
  const db = await openWritable(path);
  try {
    db.exec(schema);
    await setup(db);
  } finally {
    db.close();
  }
  return path;
}

function addMessage(statement, id, sessionID, data) {
  statement.run(id, sessionID, typeof data === "string" ? data : JSON.stringify(data));
}

async function callCount(path) {
  try {
    return (await readFile(path, "utf8")).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function usageFixture(t) {
  return fixture(t, (db) => {
    const addSession = db.prepare("INSERT INTO session (id, parent_id) VALUES (?, ?)");
    for (const [id, parent] of [
      ["ancestor", null],
      ["root", "ancestor"],
      ["child", "root"],
      ["grandchild", "child"],
      ["unrelated", null],
      ["cycle-a", "cycle-b"],
      ["cycle-b", "cycle-a"],
    ]) {
      addSession.run(id, parent);
    }

    const add = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    addMessage(add, "m01", "root", {
      role: "assistant",
      providerID: "p1",
      modelID: "shared",
      cost: 1.25,
      tokens: { input: 10, output: 2, reasoning: 7, cache: { read: 60, write: 30 }, total: 0 },
    });
    addMessage(add, "m02", "child", {
      role: "assistant",
      providerID: "p1",
      modelID: "shared",
      cost: 0.75,
      tokens: { input: 270, output: 3, reasoning: 8, cache: { read: 0, write: 30 } },
    });
    addMessage(add, "m03", "grandchild", {
      role: "assistant",
      providerID: "p2",
      modelID: "shared",
      cost: 0,
      tokens: { input: 5, output: 1, reasoning: 4, cache: { read: 5, write: 0 }, total: 999999 },
    });
    addMessage(add, "m04", "root", {
      role: "assistant",
      providerID: "p3",
      modelID: "reasoning",
      tokens: { output: 2, reasoning: 9 },
    });
    addMessage(
      add,
      "m05",
      "child",
      '{"role":"assistant","providerID":"p4","modelID":"invalid","cost":0,"tokens":{"input":1e999,"output":-4,"reasoning":"9","cache":{"read":true,"write":null}}}',
    );
    addMessage(add, "m06", "root", {
      role: "user",
      providerID: "ignored",
      modelID: "ignored",
      tokens: { input: 1000000, output: 1000000, reasoning: 1000000, cache: { read: 1000000, write: 1000000 } },
    });
    addMessage(add, "m07", "ancestor", {
      role: "assistant",
      providerID: "excluded-ancestor",
      modelID: "model",
      cost: 1,
      tokens: { input: 1000 },
    });
    addMessage(add, "m08", "unrelated", {
      role: "assistant",
      providerID: "excluded-unrelated",
      modelID: "model",
      cost: 1,
      tokens: { input: 1000 },
    });
    addMessage(add, "m09", "cycle-a", {
      role: "assistant",
      providerID: "cycle",
      modelID: "model",
      cost: 1,
      tokens: { input: 1 },
    });
    addMessage(add, "m10", "cycle-b", {
      role: "assistant",
      providerID: "cycle",
      modelID: "model",
      cost: 1,
      tokens: { input: 1 },
    });
    for (const [id, provider] of [
      ["m11", "tie-first"],
      ["m12", "tie-second"],
    ]) {
      addMessage(add, id, "root", {
        role: "assistant",
        providerID: provider,
        modelID: "model",
        cost: 0,
        tokens: { input: 1 },
      });
    }
  });
}

test("aggregates a selected session and all recursive descendants", async (t) => {
  const dbPath = await usageFixture(t);
  const started = Date.now();
  const result = await queryUsage("root", { dbPath });

  assert.deepEqual(
    result.rows.map(({ provider, model }) => [provider, model]),
    [
      ["p1", "shared"],
      ["p2", "shared"],
      ["p3", "reasoning"],
      ["tie-first", "model"],
      ["tie-second", "model"],
      ["p4", "invalid"],
    ],
  );
  assert.deepEqual(Object.keys(result.rows[0]), [
    "provider",
    "model",
    "messages",
    "input",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
    "cost",
    "cacheHitRate",
  ]);

  assert.deepEqual(result.rows[0], {
    provider: "p1",
    model: "shared",
    messages: 2,
    input: 280,
    output: 5,
    reasoning: 15,
    cacheRead: 60,
    cacheWrite: 60,
    cost: 2,
    cacheHitRate: 15,
  });
  assert.deepEqual(result.rows[1], {
    provider: "p2",
    model: "shared",
    messages: 1,
    input: 5,
    output: 1,
    reasoning: 4,
    cacheRead: 5,
    cacheWrite: 0,
    cost: 0,
    cacheHitRate: 50,
  });
  assert.equal(result.rows[2].cost, null);
  assert.equal(result.rows[2].reasoning, 9);
  assert.equal(result.rows[2].output, 2);
  assert.equal(result.rows[2].cacheHitRate, null);
  assert.deepEqual(
    result.rows[5],
    {
      provider: "p4",
      model: "invalid",
      messages: 1,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      cacheHitRate: null,
    },
  );
  assert.deepEqual(result.totals, {
    messages: 7,
    input: 287,
    output: 8,
    reasoning: 28,
    cacheRead: 65,
    cacheWrite: 60,
    cost: null,
    cacheHitRate: (65 / 412) * 100,
  });
  assert.ok(Number.isInteger(result.updatedAt));
  assert.ok(result.updatedAt >= started && result.updatedAt <= Date.now());
});

test("null scope covers all sessions; recursive cycles terminate; nonexistent sessions are empty", async (t) => {
  const dbPath = await usageFixture(t);

  const all = await queryUsage(null, { dbPath });
  assert.equal(all.totals.messages, 11);
  assert.deepEqual(
    new Set(all.rows.map((row) => row.provider)),
    new Set(["p1", "p2", "p3", "p4", "tie-first", "tie-second", "excluded-ancestor", "excluded-unrelated", "cycle"]),
  );

  const cycle = await queryUsage("cycle-a", { dbPath });
  assert.equal(cycle.rows.length, 1);
  assert.equal(cycle.rows[0].messages, 2);
  assert.equal(cycle.totals.input, 2);

  const child = await queryUsage("child", { dbPath });
  assert.equal(child.totals.messages, 3);
  assert.equal(child.totals.input, 275);

  const missing = await queryUsage("does-not-exist", { dbPath });
  assert.deepEqual(missing.rows, []);
  assert.deepEqual(missing.totals, {
    messages: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitRate: null,
  });
});

test("rejects malformed JSON and unsupported schemas", async (t) => {
  const malformedPath = await fixture(t, (db) => {
    db.prepare("INSERT INTO session (id, parent_id) VALUES (?, ?)").run("root", null);
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("bad", "root", "{not-json");
  });
  await assert.rejects(queryUsage("root", { dbPath: malformedPath }), /malformed JSON/i);

  const schemaPath = await fixture(
    t,
    () => {},
    `
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data JSON);
    `,
  );
  await assert.rejects(queryUsage(null, { dbPath: schemaPath }), /missing session\.parent_id/);
});

test("honors aborts and leaves the database file unchanged", async (t) => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(queryUsage(null, { dbPath: "unused", signal: aborted.signal }), { name: "AbortError" });

  const dbPath = await usageFixture(t);
  const duringOpen = new AbortController();
  const pending = queryUsage(null, { dbPath, signal: duringOpen.signal });
  duringOpen.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const before = await readFile(dbPath);
  await chmod(dbPath, 0o444);
  try {
    await queryUsage("root", { dbPath });
  } finally {
    await chmod(dbPath, 0o644);
  }
  assert.deepEqual(await readFile(dbPath), before);
});

test("reports percent rates and propagates missing or invalid recorded costs", async (t) => {
  const dbPath = await fixture(t, (db) => {
    db.prepare("INSERT INTO session VALUES (?, ?)").run("root", null);
    const add = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
    addMessage(add, "rate", "root", {
      role: "assistant", providerID: "p", modelID: "rate", cost: 0,
      tokens: { input: 10, cache: { read: 60, write: 30 } },
    });
    for (const [index, cost] of [undefined, null, "2", -1, true].entries()) {
      for (const [suffix, value] of [["valid", 2], ["invalid", cost]]) {
        addMessage(add, `${index}-${suffix}`, "root", {
          role: "assistant", providerID: "p", modelID: `cost-${index}`, cost: value,
        });
      }
    }
    addMessage(add, "infinite", "root",
      '{"role":"assistant","providerID":"p","modelID":"infinite","cost":1e999}');
  });
  const result = await queryUsage("root", { dbPath });
  assert.equal(result.rows[0].cacheHitRate, 60);
  assert.equal(result.rows[0].cost, 0);
  assert.equal(result.totals.cacheHitRate, 60);
  assert.equal(result.totals.cost, null);
  for (const row of result.rows.slice(1)) assert.equal(row.cost, null);
});

test("caches only a successful default path and keeps aborts and custom paths independent", async (t) => {
  const defaultPath = await fixture(t, (db) => {
    db.prepare("INSERT INTO session VALUES (?, ?)").run("root", null);
    addMessage(db.prepare("INSERT INTO message VALUES (?, ?, ?)"), "one", "root", {
      role: "assistant", providerID: "default", modelID: "model", cost: 0,
    });
  });
  const customPath = await usageFixture(t);

  await access(TEMP_ROOT);
  const bin = await mkdtemp(join(TEMP_ROOT, "model-usage-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const counter = join(bin, "calls");
  await writeFile(join(bin, "opencode"), `#!/bin/sh
printf x >> "$OPENCODE_TEST_COUNT"
case "$OPENCODE_TEST_MODE" in
  sleep) /bin/sleep 2; exit 1 ;;
  fail) exit 7 ;;
  success) printf '%s\\n' "$OPENCODE_TEST_DB" ;;
  *) exit 8 ;;
esac
`, { mode: 0o755 });

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.OPENCODE_TEST_COUNT = counter;
  process.env.OPENCODE_TEST_DB = defaultPath;
  t.after(() => {
    process.env.PATH = oldPath;
    delete process.env.OPENCODE_TEST_COUNT;
    delete process.env.OPENCODE_TEST_DB;
    delete process.env.OPENCODE_TEST_MODE;
  });

  process.env.OPENCODE_TEST_MODE = "sleep";
  const controller = new AbortController();
  const pending = queryUsage(null, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const abortedCalls = await callCount(counter);

  process.env.OPENCODE_TEST_MODE = "fail";
  await assert.rejects(queryUsage(null));
  assert.equal(await callCount(counter), abortedCalls + 1);

  process.env.OPENCODE_TEST_MODE = "success";
  assert.equal((await queryUsage(null)).totals.messages, 1);
  assert.equal(await callCount(counter), abortedCalls + 2);

  process.env.OPENCODE_TEST_MODE = "fail";
  assert.equal((await queryUsage(null)).totals.messages, 1);
  assert.equal((await queryUsage(null, { dbPath: customPath })).totals.messages, 11);
  assert.equal(await callCount(counter), abortedCalls + 2);

  await assert.rejects(queryUsage(null, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(await callCount(counter), abortedCalls + 2);
});
