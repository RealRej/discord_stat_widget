require("dotenv").config({ quiet: true });

const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");

const { query, initSchema, dialect } = require("./db");
const { encrypt, decrypt } = require("./crypto");
const { lookupPlayer } = require("./riot");
const { pushToDiscord } = require("./discord");
const { fetchDiscordSelf } = require("./oauth");

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const app = express();
app.set("trust proxy", 1); // needed behind Render's proxy so req.protocol reports https correctly

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

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { rows } = await query("SELECT is_admin FROM users WHERE id = $1", [req.session.userId]);
    if (!rows[0] || !rows[0].is_admin) return res.status(403).json({ error: "Admins only" });
    next();
  } catch (err) {
    console.error("[requireAdmin] failed:", err);
    res.status(500).json({ error: `Admin check failed: ${err.message}` });
  }
}

// ---------------- ACTIVE REQUEST TRACKING (for cancellation, not limiting) ----
// No cap on concurrent users anymore — everyone can look things up or push at
// the same time. This registry exists only so a lookup/push can be cancelled,
// either by the person running it or by an admin, while it's in flight.

const activeRequests = new Map(); // userId -> { cancelled: boolean }

function registerActiveRequest(userId) {
  activeRequests.set(userId, { cancelled: false });
}
function isCancelled(userId) {
  return activeRequests.get(userId)?.cancelled === true;
}
function clearActiveRequest(userId) {
  activeRequests.delete(userId);
}

// ---------------- ADMIN SEEDING ----------------

async function seedAdminAccount() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  const normalized = username.trim().toLowerCase();
  const { rows } = await query("SELECT id FROM users WHERE username = $1", [normalized]);
  if (rows.length > 0) {
    console.log(`[admin] Account "${normalized}" already exists — leaving it untouched.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await query("INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3)", [
    normalized,
    passwordHash,
    true,
  ]);
  console.log(`[admin] Created admin account "${normalized}"`);
}

// ---------------- CREDENTIALS HELPER (shared by self-service + admin edit) ----------------

async function upsertCredentials(userId, { botToken, appId, discordUserId, platform }) {
  // Explicit null (not undefined): both pg and better-sqlite3 reject
  // undefined as a bind parameter. Blank botToken means "leave the existing
  // one alone" — handled by the COALESCE below. This deliberately does NOT
  // touch oauth_token_encrypted or discord_linked — those are managed
  // separately by /api/discord/verify-token, so editing e.g. just the
  // server preference here doesn't wipe out an already-verified connection.
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

  await query(upsertSql, [userId, botTokenEncrypted, appId || null, discordUserId || null, platform || "auto"]);
}

// ---------------- STREAMING HELPERS (newline-delimited JSON progress) ----------------

function startStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no", // ask any nginx-style proxy in front not to buffer this
  });
}
function sendChunk(res, obj) {
  res.write(JSON.stringify(obj) + "\n");
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
  if (req.session.userId) clearActiveRequest(req.session.userId);
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const { rows } = await query("SELECT is_admin FROM users WHERE id = $1", [req.session.userId]);
    res.json({ loggedIn: true, isAdmin: Boolean(rows[0] && rows[0].is_admin) });
  } catch (err) {
    console.error("[/api/me] failed:", err);
    res.status(500).json({ error: `Session check failed: ${err.message}` });
  }
});

// ---------------- CREDENTIALS (each friend's own Discord bot info) ----------------

app.get("/api/credentials", requireLogin, async (req, res) => {
  const { rows } = await query(
    `SELECT app_id, discord_user_id, platform, discord_linked,
            bot_token_encrypted IS NOT NULL AS has_token,
            oauth_token_encrypted IS NOT NULL AS has_oauth_token
     FROM credentials WHERE user_id = $1`,
    [req.session.userId]
  );
  res.json(
    rows[0]
      ? { ...rows[0], discord_linked: Boolean(rows[0].discord_linked), has_oauth_token: Boolean(rows[0].has_oauth_token) }
      : { app_id: "", discord_user_id: "", platform: "auto", has_token: false, has_oauth_token: false, discord_linked: false }
  );
});

app.post("/api/credentials", requireLogin, async (req, res) => {
  try {
    await upsertCredentials(req.session.userId, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[credentials] save failed:", err);
    res.status(500).json({ error: `Could not save settings: ${err.message}` });
  }
});

// ---------------- DISCORD ACCOUNT CONNECTION (manually-pasted OAuth2 token) ----------------

app.post("/api/discord/verify-token", requireLogin, async (req, res) => {
  try {
    const { oauthToken } = req.body;
    if (!oauthToken) {
      return res.status(400).json({ error: "Paste your OAuth2 access token first." });
    }

    const discordSelf = await fetchDiscordSelf(oauthToken);

    const { rows } = await query("SELECT discord_user_id FROM credentials WHERE user_id = $1", [req.session.userId]);
    const savedDiscordUserId = rows[0] && rows[0].discord_user_id;
    if (savedDiscordUserId && savedDiscordUserId !== discordSelf.id) {
      return res.status(400).json({
        error: `That token belongs to Discord account ${discordSelf.id}, but the Discord User ID saved above is ${savedDiscordUserId}. Fix the User ID field to match, or get a token for the right account.`,
      });
    }

    await query(
      `UPDATE credentials SET oauth_token_encrypted = $1, discord_linked = ${dialect === "pg" ? "TRUE" : "1"} WHERE user_id = $2`,
      [encrypt(oauthToken), req.session.userId]
    );

    res.json({ ok: true, discordUsername: discordSelf.username });
  } catch (err) {
    console.error("[discord verify-token] failed:", err);
    res.status(502).json({ error: `Discord rejected that token: ${err.message}` });
  }
});

// ---------------- LOOKUP / PUSH (streamed progress) ----------------

app.post("/api/lookup/stream", requireLogin, async (req, res) => {
  const { gameName, tagLine, platform } = req.body;
  if (!gameName || !tagLine) return res.status(400).json({ error: "Riot ID and tag are both required" });
  if (!RIOT_API_KEY) return res.status(500).json({ error: "Server has no Riot API key configured (set RIOT_API_KEY)" });

  registerActiveRequest(req.session.userId);
  startStream(res);
  try {
    const data = await lookupPlayer({
      apiKey: RIOT_API_KEY,
      gameName: gameName.trim(),
      tagLine: tagLine.trim().replace(/^#/, ""),
      platformPref: platform || "auto",
      onProgress: (message, percent) => sendChunk(res, { type: "progress", message, percent }),
      shouldCancel: () => isCancelled(req.session.userId),
    });
    sendChunk(res, { type: "result", data });
  } catch (err) {
    if (err.cancelled) {
      sendChunk(res, { type: "cancelled" });
    } else {
      console.error("[lookup/stream] failed:", err);
      sendChunk(res, { type: "error", message: err.message || "Lookup failed" });
    }
  } finally {
    clearActiveRequest(req.session.userId);
    res.end();
  }
});

// Shared by both the self-service push and the admin "push on someone's
// behalf" action — the only real difference between them is whose
// credentials get used and whose activity gets tracked for cancellation.
async function runPushStream(res, { targetUserId, gameName, tagLine, creds }) {
  registerActiveRequest(targetUserId);
  startStream(res);
  try {
    const data = await lookupPlayer({
      apiKey: RIOT_API_KEY,
      gameName: gameName.trim(),
      tagLine: tagLine.trim().replace(/^#/, ""),
      platformPref: creds.platform || "auto",
      onProgress: (message, percent) => sendChunk(res, { type: "progress", message, percent }),
      shouldCancel: () => isCancelled(targetUserId),
    });

    sendChunk(res, { type: "progress", message: "Pushing to Discord...", percent: 99 });
    await pushToDiscord({
      botToken: decrypt(creds.bot_token_encrypted),
      appId: creds.app_id,
      discordUserId: creds.discord_user_id,
      dynamic: data.dynamic,
    });

    // Remember which Riot account is now shown on this person's Discord
    // profile, so the admin panel can display it.
    const [riotGameName, riotTagLine] = data.riotId.split("#");
    await query("UPDATE credentials SET riot_game_name = $1, riot_tag_line = $2 WHERE user_id = $3", [
      riotGameName,
      riotTagLine,
      targetUserId,
    ]);

    sendChunk(res, { type: "result", data, pushedAt: new Date().toISOString() });
  } catch (err) {
    if (err.cancelled) {
      sendChunk(res, { type: "cancelled" });
    } else {
      console.error("[push/stream] failed:", err);
      sendChunk(res, { type: "error", message: err.message || "Push failed" });
    }
  } finally {
    clearActiveRequest(targetUserId);
    res.end();
  }
}

app.post("/api/push/stream", requireLogin, async (req, res) => {
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

  await runPushStream(res, { targetUserId: req.session.userId, gameName, tagLine, creds });
});

app.post("/api/lookup/cancel", requireLogin, (req, res) => {
  const entry = activeRequests.get(req.session.userId);
  if (!entry) return res.status(404).json({ error: "Nothing is currently running." });
  entry.cancelled = true;
  res.json({ ok: true });
});

// ---------------- ADMIN ----------------

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const { rows } = await query(`
    SELECT u.id, u.username, u.is_admin, u.created_at,
           c.riot_game_name, c.riot_tag_line,
           (c.bot_token_encrypted IS NOT NULL AND c.app_id IS NOT NULL AND c.discord_user_id IS NOT NULL) AS discord_configured
    FROM users u
    LEFT JOIN credentials c ON c.user_id = u.id
    ORDER BY u.id ASC
  `);
  res.json({
    users: rows.map((r) => ({
      ...r,
      is_admin: Boolean(r.is_admin),
      discord_configured: Boolean(r.discord_configured),
      active: activeRequests.has(r.id),
      riotId: r.riot_game_name ? `${r.riot_game_name}#${r.riot_tag_line}` : null,
    })),
  });
});

app.post("/api/admin/users/:id/push/stream", requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  const { gameName, tagLine } = req.body;
  if (!gameName || !tagLine) return res.status(400).json({ error: "Riot ID and tag are both required" });
  if (!RIOT_API_KEY) return res.status(500).json({ error: "Server has no Riot API key configured (set RIOT_API_KEY)" });

  const { rows } = await query(
    "SELECT bot_token_encrypted, app_id, discord_user_id, platform FROM credentials WHERE user_id = $1",
    [targetId]
  );
  const creds = rows[0];
  if (!creds || !creds.bot_token_encrypted || !creds.app_id || !creds.discord_user_id) {
    return res.status(400).json({ error: "That person hasn't saved their Discord bot token, app ID, and user ID yet." });
  }

  await runPushStream(res, { targetUserId: targetId, gameName, tagLine, creds });
});

app.post("/api/admin/cancel/:id", requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const entry = activeRequests.get(targetId);
  if (!entry) return res.status(404).json({ error: "That person doesn't have anything running right now." });
  entry.cancelled = true;
  res.json({ ok: true });
});

// Lets the admin view (not the secret token itself, just the non-secret
// fields) and edit ANY user's Discord credentials — for fixing typos or
// setting things up on a friend's behalf without needing their password.
app.get("/api/admin/users/:id/credentials", requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  const { rows } = await query(
    `SELECT app_id, discord_user_id, platform, discord_linked,
            bot_token_encrypted IS NOT NULL AS has_token,
            oauth_token_encrypted IS NOT NULL AS has_oauth_token
     FROM credentials WHERE user_id = $1`,
    [targetId]
  );
  res.json(
    rows[0]
      ? { ...rows[0], discord_linked: Boolean(rows[0].discord_linked), has_oauth_token: Boolean(rows[0].has_oauth_token) }
      : { app_id: "", discord_user_id: "", platform: "auto", has_token: false, has_oauth_token: false, discord_linked: false }
  );
});

app.post("/api/admin/users/:id/credentials", requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    await upsertCredentials(targetId, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin credentials] save failed:", err);
    res.status(500).json({ error: `Could not save settings: ${err.message}` });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.session.userId) {
      return res.status(400).json({ error: "You can't delete your own account from here." });
    }
    await query("DELETE FROM credentials WHERE user_id = $1", [targetId]);
    const result = await query("DELETE FROM users WHERE id = $1", [targetId]);
    clearActiveRequest(targetId);
    res.json({ ok: true, deleted: result.changes !== 0 });
  } catch (err) {
    console.error("[admin delete user] failed:", err);
    res.status(500).json({ error: `Delete failed: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(seedAdminAccount)
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
      if (!RIOT_API_KEY) {
        console.log("[server] WARNING: RIOT_API_KEY is not set — lookups will fail until you set it (see .env.example).");
      }
    });

    // Node's defaults (5s keepAliveTimeout, 60s headersTimeout) are too
    // short for a proxy setup like Render's, especially for our long-lived
    // streaming lookup/push requests — Render's own troubleshooting docs
    // specifically recommend this fix for "intermittent timeouts or
    // Connection reset by peer" on Node services. headersTimeout must be
    // set higher than keepAliveTimeout.
    server.keepAliveTimeout = 300000; // 5 minutes
    server.headersTimeout = 310000;
  })
  .catch((err) => {
    console.error("[server] Failed to initialize database schema:", err);
    process.exit(1);
  });
