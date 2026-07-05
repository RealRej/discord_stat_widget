// Storage layer with two backends:
//   - Postgres (via DATABASE_URL) — used once you deploy and hook up Supabase.
//   - Local SQLite file — used automatically when DATABASE_URL isn't set, so
//     `npm install && npm start` works immediately on your own machine with
//     no external database, no signup, nothing.
//
// Everything else in the app talks to `query(sql, params)` using Postgres-style
// $1, $2... placeholders; this module translates them for SQLite under the hood.

const path = require("path");
const fs = require("fs");

const usingPostgres = Boolean(process.env.DATABASE_URL);
const dialect = usingPostgres ? "pg" : "sqlite";

let pgPool = null;
let sqliteDb = null;

if (usingPostgres) {
  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
} else {
  // better-sqlite3 is an optional dependency (it needs to compile native
  // code, which can fail on some hosts) — only required when it's actually
  // needed, i.e. no DATABASE_URL was provided.
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    throw new Error(
      "No DATABASE_URL is set, and the local SQLite fallback isn't available in this environment. " +
      "Set the DATABASE_URL environment variable (see README) — this is expected on hosting platforms like Render, " +
      "which should always be given a real database."
    );
  }
  const dataDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new Database(path.join(dataDir, "local.db"));
  sqliteDb.pragma("journal_mode = WAL");
  console.log(`[db] No DATABASE_URL set — using local SQLite file at ${path.join(dataDir, "local.db")}`);
  console.log("[db] That's fine for running on your own machine. Set DATABASE_URL (see README) once you deploy so data isn't tied to one computer.");
}

function translate(sql, params) {
  const newParams = [];
  const newSql = sql.replace(/\$(\d+)/g, (_, n) => {
    newParams.push(params[Number(n) - 1] ?? null);
    return "?";
  });
  return { sql: newSql, params: newParams };
}

async function query(sql, params = []) {
  if (usingPostgres) {
    return pgPool.query(sql, params);
  }

  const { sql: sqliteSql, params: sqliteParams } = translate(sql, params);
  const boundParams = sqliteParams.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
  try {
    const stmt = sqliteDb.prepare(sqliteSql);
    if (stmt.reader) {
      return { rows: stmt.all(...boundParams) };
    }
    const info = stmt.run(...boundParams);
    return { rows: [], lastInsertRowid: info.lastInsertRowid, changes: info.changes };
  } catch (err) {
    // Normalize SQLite's unique-constraint error to look like Postgres's
    // 23505 so route handlers can check one thing regardless of backend.
    if (/UNIQUE constraint failed/i.test(err.message)) {
      err.code = "23505";
    }
    throw err;
  }
}

// Adds a column to an already-existing table if it's missing, without
// disturbing the table if the column is already there. Needed because
// CREATE TABLE IF NOT EXISTS silently does nothing for tables that already
// exist from a previous deploy — schema changes otherwise never reach a
// database that was set up before this column was introduced.
async function ensureColumn(table, column, definition) {
  if (usingPostgres) {
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    return;
  }
  try {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

async function initSchema() {
  const timestampCol = usingPostgres ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (datetime('now'))";
  const idCol = usingPostgres ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id ${idCol},
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at ${timestampCol}
    );
  `);

  // If this table already existed from before is_admin was introduced,
  // CREATE TABLE IF NOT EXISTS above is a no-op and the column never gets
  // added — so retroactively add it here. Safe to run on every startup.
  await ensureColumn("users", "is_admin", "BOOLEAN NOT NULL DEFAULT FALSE");

  await query(`
    CREATE TABLE IF NOT EXISTS credentials (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bot_token_encrypted TEXT,
      app_id TEXT,
      discord_user_id TEXT,
      platform TEXT NOT NULL DEFAULT 'auto',
      updated_at ${timestampCol}
    );
  `);

  // client_secret is needed to exchange an OAuth2 authorization code for a
  // token (see server/oauth.js). discord_linked tracks whether that one-time
  // "Connect my Discord account" step has been completed successfully.
  await ensureColumn("credentials", "client_secret_encrypted", "TEXT");
  await ensureColumn("credentials", "discord_linked", "BOOLEAN NOT NULL DEFAULT FALSE");

  await query(`
    CREATE TABLE IF NOT EXISTS season_cache (
      puuid TEXT NOT NULL,
      queue_id INTEGER NOT NULL,
      season_start_iso TEXT NOT NULL,
      processed_match_ids TEXT NOT NULL DEFAULT '[]',
      champions TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (puuid, queue_id)
    );
  `);

  console.log(`[db] Schema ready (${dialect})`);
}

module.exports = { query, initSchema, dialect };
