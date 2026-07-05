require("dotenv").config({ quiet: true });

const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");

const { query, initSchema, dialect } = require("./db");
const { encrypt, decrypt } = require("./crypto");
const { lookupPlayer } = require("./riot");
const { pushToDiscord } = require("./discord");

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.SESSION_SECRET || "dev-secret-change-me"],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: "lax",
  })
);

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

// ---------------- AUTH ----------------

app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ error: "Username required, password must be 8+ characters" });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id",
      [username.trim().toLowerCase(), passwordHash]
    );
    req.session.userId = rows[0].id;
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That username is taken" });
    console.error("[register] failed:", err);
    res.status(500).json({ error: `Registration failed: ${err.message}` });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await query("SELECT id, password_hash FROM users WHERE username = $1", [
      (username || "").trim().toLowerCase(),
    ]);
    if (rows.length === 0) return res.status(401).json({ error: "Invalid username or password" });

    const ok = await bcrypt.compare(password || "", rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password" });

    req.session.userId = rows[0].id;
    res.json({ ok: true });
  } catch (err) {
    console.error("[login] failed:", err);
    res.status(500).json({ error: `Login failed: ${err.message}` });
  }
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ loggedIn: Boolean(req.session.userId) });
});

// ---------------- CREDENTIALS (each friend's own Discord bot info) ----------------

app.get("/api/credentials", requireLogin, async (req, res) => {
  const { rows } = await query(
    "SELECT app_id, discord_user_id, platform, bot_token_encrypted IS NOT NULL AS has_token FROM credentials WHERE user_id = $1",
    [req.session.userId]
  );
  res.json(rows[0] || { app_id: "", discord_user_id: "", platform: "auto", has_token: false });
});

app.post("/api/credentials", requireLogin, async (req, res) => {
  try {
    const { botToken, appId, discordUserId, platform } = req.body;

    // Only re-encrypt and overwrite the token if the person actually typed a
    // new one — otherwise leave whatever's already stored untouched, so the
    // settings form doesn't have to re-display (or blank out) a secret.
    // Explicit null (not undefined): both pg and better-sqlite3 reject
    // undefined as a bind parameter.
    const botTokenEncrypted = botToken ? encrypt(botToken) : null;

    // The COALESCE fallback needs different syntax per backend: Postgres
    // references the pre-existing row via the table name, SQLite references
    // the incoming (possibly-null) value via `excluded` and the bare column
    // name for the existing one.
    const upsertSql =
      dialect === "pg"
        ? `INSERT INTO credentials (user_id, bot_token_encrypted, app_id, discord_user_id, platform)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET
             bot_token_encrypted = COALESCE($2, credentials.bot_token_encrypted),
             app_id = $3, discord_user_id = $4, platform = $5, updated_at = now()`
        : `INSERT INTO credentials (user_id, bot_token_encrypted, app_id, discord_user_id, platform)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT(user_id) DO UPDATE SET
             bot_token_encrypted = COALESCE(excluded.bot_token_encrypted, bot_token_encrypted),
             app_id = excluded.app_id, discord_user_id = excluded.discord_user_id,
             platform = excluded.platform, updated_at = datetime('now')`;

    await query(upsertSql, [req.session.userId, botTokenEncrypted, appId || null, discordUserId || null, platform || "auto"]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[credentials] save failed:", err);
    res.status(500).json({ error: `Could not save settings: ${err.message}` });
  }
});

// ---------------- LOOKUP (uses the shared site-wide Riot key) ----------------

app.post("/api/lookup", requireLogin, async (req, res) => {
  try {
    const { gameName, tagLine, platform } = req.body;
    if (!gameName || !tagLine) return res.status(400).json({ error: "Riot ID and tag are both required" });
    if (!RIOT_API_KEY) return res.status(500).json({ error: "Server has no Riot API key configured (set RIOT_API_KEY)" });

    const data = await lookupPlayer({
      apiKey: RIOT_API_KEY,
      gameName: gameName.trim(),
      tagLine: tagLine.trim().replace(/^#/, ""),
      platformPref: platform || "auto",
      skipSeasonBackfill: true, // fast preview; full backfill happens on push
    });

    res.json(data);
  } catch (err) {
    console.error("[lookup] failed:", err);
    res.status(502).json({ error: err.message || "Lookup failed" });
  }
});

// ---------------- PUSH (uses the logged-in friend's OWN Discord credentials) ----------------

app.post("/api/push", requireLogin, async (req, res) => {
  try {
    const { gameName, tagLine } = req.body;
    if (!gameName || !tagLine) return res.status(400).json({ error: "Riot ID and tag are both required" });
    if (!RIOT_API_KEY) return res.status(500).json({ error: "Server has no Riot API key configured (set RIOT_API_KEY)" });

    const { rows } = await query(
      "SELECT bot_token_encrypted, app_id, discord_user_id, platform FROM credentials WHERE user_id = $1",
      [req.session.userId]
    );
    const creds = rows[0];
    if (!creds || !creds.bot_token_encrypted || !creds.app_id || !creds.discord_user_id) {
      return res.status(400).json({ error: "Save your Discord bot token, app ID, and user ID in Settings first" });
    }

    const data = await lookupPlayer({
      apiKey: RIOT_API_KEY,
      gameName: gameName.trim(),
      tagLine: tagLine.trim().replace(/^#/, ""),
      platformPref: creds.platform || "auto",
      skipSeasonBackfill: false,
    });

    await pushToDiscord({
      botToken: decrypt(creds.bot_token_encrypted),
      appId: creds.app_id,
      discordUserId: creds.discord_user_id,
      dynamic: data.dynamic,
    });

    res.json({ ok: true, pushedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[push] failed:", err);
    res.status(502).json({ error: err.message || "Push failed" });
  }
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
      if (!RIOT_API_KEY) {
        console.log("[server] WARNING: RIOT_API_KEY is not set — lookups will fail until you set it (see .env.example).");
      }
    });
  })
  .catch((err) => {
    console.error("[server] Failed to initialize database schema:", err);
    process.exit(1);
  });
