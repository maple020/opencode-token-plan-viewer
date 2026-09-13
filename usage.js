import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FINITE = "1.7976931348623157e308";
let cachedDatabasePath;

function validNumber(name) {
  return `${name}_type IN ('integer', 'real') AND ${name}_value >= 0 AND ${name}_value <= ${MAX_FINITE}`;
}

function bucket(name) {
  return `CASE WHEN ${validNumber(name)} THEN CAST(${name}_value AS REAL) ELSE 0.0 END AS ${name}`;
}

function usageSql(scoped) {
  const scope = scoped
    ? `WITH RECURSIVE tree(id) AS (
         SELECT id FROM session WHERE id = ?
         UNION
         SELECT s.id FROM session AS s JOIN tree ON s.parent_id = tree.id
       ),
       scoped AS (
         SELECT m.id, m.data
         FROM message AS m
         JOIN tree ON tree.id = m.session_id
       )`
    : `WITH scoped AS (
         SELECT id, data FROM message
       )`;

  return `${scope},
    parsed AS (
      SELECT
        id,
        json_extract(data, '$.role') AS role,
        json_extract(data, '$.providerID') AS provider,
        json_extract(data, '$.modelID') AS model,
        json_type(data, '$.cost') AS cost_type,
        json_extract(data, '$.cost') AS cost_value,
        json_type(data, '$.tokens.input') AS input_type,
        json_extract(data, '$.tokens.input') AS input_value,
        json_type(data, '$.tokens.output') AS output_type,
        json_extract(data, '$.tokens.output') AS output_value,
        json_type(data, '$.tokens.reasoning') AS reasoning_type,
        json_extract(data, '$.tokens.reasoning') AS reasoning_value,
        json_type(data, '$.tokens.cache.read') AS cache_read_type,
        json_extract(data, '$.tokens.cache.read') AS cache_read_value,
        json_type(data, '$.tokens.cache.write') AS cache_write_type,
        json_extract(data, '$.tokens.cache.write') AS cache_write_value
      FROM scoped
    ),
    normalized AS (
      SELECT
        id,
        provider,
        model,
        ${bucket("input")},
        ${bucket("output")},
        ${bucket("reasoning")},
        ${bucket("cache_read")},
        ${bucket("cache_write")},
        CASE WHEN ${validNumber("cost")} THEN 1 ELSE 0 END AS cost_valid,
        CASE WHEN ${validNumber("cost")} THEN CAST(cost_value AS REAL) ELSE 0.0 END AS cost
      FROM parsed
      WHERE role = 'assistant'
    )
    SELECT
      provider,
      model,
      COUNT(*) AS messages,
      TOTAL(input) AS input,
      TOTAL(output) AS output,
      TOTAL(reasoning) AS reasoning,
      TOTAL(cache_read) AS cache_read,
      TOTAL(cache_write) AS cache_write,
      CASE WHEN MIN(cost_valid) = 1 THEN TOTAL(cost) ELSE NULL END AS cost,
      MIN(id) AS first_id
    FROM normalized
    GROUP BY provider, model
    ORDER BY first_id`;
}

async function resolveDatabasePath(signal) {
  if (cachedDatabasePath !== undefined) return cachedDatabasePath;

  const { stdout } = await execFileAsync("opencode", ["db", "path"], {
    encoding: "utf8",
    maxBuffer: 4096,
    signal,
    timeout: 7500,
  });
  const path = stdout.trim();
  if (!path) throw new Error("opencode db path returned an empty path");
  cachedDatabasePath = path;
  return cachedDatabasePath;
}

async function openDatabase(path) {
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true });
  }

  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}

function validateSchema(db) {
  const required = {
    session: ["id", "parent_id"],
    message: ["id", "session_id", "data"],
  };

  for (const [table, columns] of Object.entries(required)) {
    const schema = db.prepare(`PRAGMA table_info("${table}")`).all();
    const byName = new Map(schema.map((column) => [column.name, column]));
    for (const column of columns) {
      if (!byName.has(column)) {
        throw new Error(`Unsupported OpenCode database schema: missing ${table}.${column}`);
      }
    }
    if (!byName.get("id").pk) {
      throw new Error(`Unsupported OpenCode database schema: ${table}.id is not a primary key`);
    }
  }
}

function aggregateNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid aggregate ${name}`);
  }
  return value;
}

function rate(values) {
  const denominator = values.input + values.cacheRead + values.cacheWrite;
  if (!Number.isFinite(denominator)) throw new RangeError("Token aggregate overflow");
  return denominator === 0 ? null : (values.cacheRead / denominator) * 100;
}

function tokenSum(row) {
  const total = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite;
  if (!Number.isFinite(total)) throw new RangeError("Token aggregate overflow");
  return total;
}

function mapRows(records) {
  const rows = records.map((record) => {
    const row = {
      provider: record.provider,
      model: record.model,
      messages: aggregateNumber(record.messages, "messages"),
      input: aggregateNumber(record.input, "input"),
      output: aggregateNumber(record.output, "output"),
      reasoning: aggregateNumber(record.reasoning, "reasoning"),
      cacheRead: aggregateNumber(record.cache_read, "cacheRead"),
      cacheWrite: aggregateNumber(record.cache_write, "cacheWrite"),
      cost: record.cost === null ? null : aggregateNumber(record.cost, "cost"),
      cacheHitRate: null,
    };
    row.cacheHitRate = rate(row);
    return row;
  });

  rows.sort((left, right) => tokenSum(right) - tokenSum(left));
  return rows;
}

function makeTotals(rows) {
  const totals = {
    messages: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitRate: null,
  };

  for (const row of rows) {
    for (const field of ["messages", "input", "output", "reasoning", "cacheRead", "cacheWrite"]) {
      totals[field] = aggregateNumber(totals[field] + row[field], field);
    }
    if (totals.cost !== null) {
      totals.cost = row.cost === null ? null : aggregateNumber(totals.cost + row.cost, "cost");
    }
  }

  totals.cacheHitRate = rate(totals);
  return totals;
}

export async function queryUsage(sessionID, options = {}) {
  if (sessionID !== null && (typeof sessionID !== "string" || sessionID.length === 0)) {
    throw new TypeError("sessionID must be null or a nonempty string");
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const { dbPath, signal } = options;
  if (dbPath !== undefined && (typeof dbPath !== "string" || dbPath.length === 0)) {
    throw new TypeError("options.dbPath must be a nonempty string");
  }

  signal?.throwIfAborted();
  const path = dbPath ?? (await resolveDatabasePath(signal));
  signal?.throwIfAborted();

  let db;
  let rows;
  try {
    db = await openDatabase(path);
    signal?.throwIfAborted();
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250;");
    validateSchema(db);
    // Native synchronous SQLite queries cannot be interrupted by AbortSignal.
    const records = db.prepare(usageSql(sessionID !== null)).all(...(sessionID === null ? [] : [sessionID]));
    rows = mapRows(records);
  } finally {
    db?.close();
  }

  return { rows, totals: makeTotals(rows), updatedAt: Date.now() };
}
