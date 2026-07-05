require("dotenv").config({ quiet: true });

const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { query, initSchema, dialect } = require("./db");
const { encrypt, decrypt } = require("./crypto");
const { lookupPlayer } = require("./riot");
const { pushToDiscord } = require("./discord");
const { buildAuthorizeUrl, fetchDiscordSelf } = require("./oauth");

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

// ---------------- SINGLE-USER SLOT (Riot's rate limit is per API key, so two
// people running lookups at once would fight over it — this keeps lookups to
// one non-admin person at a time. Admins are exempt since there's only one
// of you and you may need to fix something while a friend is using it.) ----

let activeSlot = null; // { userId, username, lastSeen }
const SLOT_TIMEOUT_MS = 5 * 60 * 1000; // safety net in case a request never reaches its `finally`

function releaseSlotIfOwned(userId) {
  if (activeSlot && activeSlot.userId === userId) activeSlot = null;
}

async function requireSlot(req, res, next) {
  try {
    const { rows } = await query("SELECT is_admin, username FROM users WHERE id = $1", [req.session.userId]);
    const me = rows[0];
    if (!me) return res.status(401).json({ error: "Not logged in" });

    if (me.is_admin) return next(); // admins never compete for the shared slot

    const now = Date.now();
    const slotIsFree = !activeSlot || now - activeSlot.lastSeen > SLOT_TIMEOUT_MS;
    const slotIsMine = activeSlot && activeSlot.userId === req.session.userId;

    if (slotIsFree || slotIsMine) {
      activeSlot = { userId: req.session.userId, username: me.username, lastSeen: now };
      return next();
    }

    const waitSeconds = Math.max(1, Math.ceil((SLOT_TIMEOUT_MS - (now - activeSlot.lastSeen)) / 1000));
    res.status(423).json({
      error: `Someone else is currently using lookups right now (only one person at a time, to stay within Riot's rate limit). Try again in about ${waitSeconds}s.`,
      retryAfterSeconds: waitSeconds,
    });
  } catch (err) {
    console.error("[requireSlot] failed:", err);
    res.status(500).json({ error: `Slot check failed: ${err.message}` });
  }
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

async function upsertCredentials(userId, { botToken, appId, discordUserId, platform, clientSecret }) {
  // Explicit null (not undefined): both pg and better-sqlite3 reject
  // undefined as a bind parameter. Blank botToken/clientSecret means "leave
  // the existing one alone" — handled by the COALESCE below. Any save here
  // resets discord_linked to false: if the app ID or secret just changed,
  // whatever "Connect my Discord" link existed before is no longer valid
  // for the new values, so it's safest to require reconnecting.
  const botTokenEncrypted = botToken ? encrypt(botToken) : null;
  const clientSecretEncrypted = clientSecret ? encrypt(clientSecret) : null;

  // The COALESCE fallback needs different syntax per backend: Postgres
  // references the pre-existing row via the table name, SQLite references
  // the incoming (possibly-null) value via `excluded` and the bare column
  // name for the existing one.
  const upsertSql =
    dialect === "pg"
      ? `INSERT INTO credentials (user_id, bot_token_encrypted, app_id, discord_user_id, platform, client_secret_encrypted, discord_linked)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET
           bot_token_encrypted = COALESCE($2, credentials.bot_token_encrypted),
           app_id = $3, discord_user_id = $4, platform = $5,
           client_secret_encrypted = COALESCE($6, credentials.client_secret_encrypted),
           discord_linked = FALSE, updated_at = now()`
      : `INSERT INTO credentials (user_id, bot_token_encrypted, app_id, discord_user_id, platform, client_secret_encrypted, discord_linked)
         VALUES ($1, $2, $3, $4, $5, $6, 0)
         ON CONFLICT(user_id) DO UPDATE SET
           bot_token_encrypted = COALESCE(excluded.bot_token_encrypted, bot_token_encrypted),
           app_id = excluded.app_id, discord_user_id = excluded.discord_user_id,
           platform = excluded.platform,
           client_secret_encrypted = COALESCE(excluded.client_secret_encrypted, client_secret_encrypted),
           discord_linked = 0, updated_at = datetime('now')`;

  await query(upsertSql, [userId, botTokenEncrypted, appId || null, discordUserId || null, platform || "auto", clientSecretEncrypted]);
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
  if (req.session.userId) releaseSlotIfOwned(req.session.userId);
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
            client_secret_encrypted IS NOT NULL AS has_client_secret
     FROM credentials WHERE user_id = $1`,
    [req.session.userId]
  );
  res.json(
    rows[0]
      ? { ...rows[0], discord_linked: Boolean(rows[0].discord_linked), has_client_secret: Boolean(rows[0].has_client_secret) }
      : { app_id: "", discord_user_id: "", platform: "auto", has_token: false, has_client_secret: false, discord_linked: false }
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

// ---------------- DISCORD ACCOUNT CONNECTION (OAuth2, implicit grant) ----------------

function getSiteUrl(req) {
  return process.env.SITE_URL || `${req.protocol}://${req.get("host")}`;
}

app.get("/api/discord/authorize", requireLogin, async (req, res) => {
  try {
    const { rows } = await query("SELECT app_id FROM credentials WHERE user_id = $1", [req.session.userId]);
    const appId = rows[0] && rows[0].app_id;
    if (!appId) {
      return res.status(400).json({ error: "Save your Application ID in Settings before connecting your Discord account." });
    }

    const state = crypto.randomBytes(24).toString("hex");
    req.session.discordOauthState = state;

    const redirectUri = `${getSiteUrl(req)}/discord-callback.html`;
    res.redirect(buildAuthorizeUrl({ clientId: appId, redirectUri, state }));
  } catch (err) {
    console.error("[discord authorize] failed:", err);
    res.status(500).json({ error: `Could not start the Discord connection: ${err.message}` });
  }
});

app.post("/api/discord/callback", requireLogin, async (req, res) => {
  try {
    const { accessToken, state } = req.body;
    if (!accessToken || !state) {
      return res.status(400).json({ error: "Missing access token or state from Discord's response." });
    }
    if (state !== req.session.discordOauthState) {
      return res.status(400).json({ error: "This connection request expired or doesn't match — click Connect again." });
    }
    req.session.discordOauthState = null;

    const discordSelf = await fetchDiscordSelf(accessToken);

    const { rows } = await query("SELECT discord_user_id FROM credentials WHERE user_id = $1", [req.session.userId]);
    const savedDiscordUserId = rows[0] && rows[0].discord_user_id;
    if (savedDiscordUserId && savedDiscordUserId !== discordSelf.id) {
      return res.status(400).json({
        error: `You authorized as Discord account ${discordSelf.id}, but the Discord User ID saved in Settings is ${savedDiscordUserId}. Fix the User ID field to match, then connect again.`,
      });
    }

    await query(
      dialect === "pg" ? "UPDATE credentials SET discord_linked = TRUE WHERE user_id = $1" : "UPDATE credentials SET discord_linked = 1 WHERE user_id = $1",
      [req.session.userId]
    );

    res.json({ ok: true, discordUsername: discordSelf.username });
  } catch (err) {
    console.error("[discord callback] failed:", err);
    res.status(500).json({ error: `Could not complete the connection: ${err.message}` });
  }
});

// ---------------- LOOKUP / PUSH (streamed progress; shared slot lock) ----------------

app.post("/api/lookup/stream", requireLogin, requireSlot, async (req, res) => {
  const { gameName, tagLine, platform } = req.body;
  if (!gameName || !tagLine) return res.status(400).json({ error: "Riot ID and tag are both required" });
  if (!RIOT_API_KEY) return res.status(500).json({ error: "Server has no Riot API key configured (set RIOT_API_KEY)" });

  startStream(res);
  try {
    const data = await lookupPlayer({
      apiKey: RIOT_API_KEY,
      gameName: gameName.trim(),
      tagLine: tagLine.trim().replace(/^#/, ""),
      platformPref: platform || "auto",
      onProgress: (message, percent) => {
        if (activeSlot && activeSlot.userId === req.session.userId) activeSlot.lastSeen = Date.now();
        sendChunk(res, { type: "progress", message, percent });
      },
    });
    sendChunk(res, { type: "result", data });
  } catch (err) {
    console.error("[lookup/stream] failed:", err);
    sendChunk(res, { type: "error", message: err.message || "Lookup failed" });
  } finally {
    releaseSlotIfOwned(req.session.userId);
    res.end();
  }
});

app.post("/api/push/stream", requireLogin, requireSlot, async (req, res) => {
  const { gameName, tagLine } = req.body;
  if (!gameName || !tagLine) return res.status(400).json({ error: "Riot ID and tag are both required" });
  if (!RIOT_API_KEY) return res.status(500).json({ error: "Server has no Riot API key configured (set RIOT_API_KEY)" });

  const { rows } = await query(
    "SELECT bot_token_encrypted, app_id, discord_user_id, platform FROM credentials WHERE user_id = $1",
    [req.session.userId]
  );
  const creds = rows[0];
  if (!creds || !creds.bot_token_encrypted || !creds.app_id || !creds.discord_user_id) {
    releaseSlotIfOwned(req.session.userId);
    return res.status(400).json({ error: "Save your Discord bot token, app ID, and user ID in Settings first" });
  }

  startStream(res);
  try {
    const data = await lookupPlayer({
      apiKey: RIOT_API_KEY,
      gameName: gameName.trim(),
      tagLine: tagLine.trim().replace(/^#/, ""),
      platformPref: creds.platform || "auto",
      onProgress: (message, percent) => {
        if (activeSlot && activeSlot.userId === req.session.userId) activeSlot.lastSeen = Date.now();
        sendChunk(res, { type: "progress", message, percent });
      },
    });

    sendChunk(res, { type: "progress", message: "Pushing to Discord...", percent: 99 });
    await pushToDiscord({
      botToken: decrypt(creds.bot_token_encrypted),
      appId: creds.app_id,
      discordUserId: creds.discord_user_id,
      dynamic: data.dynamic,
    });

    sendChunk(res, { type: "result", data, pushedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[push/stream] failed:", err);
    sendChunk(res, { type: "error", message: err.message || "Push failed" });
  } finally {
    releaseSlotIfOwned(req.session.userId);
    res.end();
  }
});

// ---------------- ADMIN ----------------

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const { rows } = await query(`
    SELECT u.id, u.username, u.is_admin, u.created_at,
           (c.bot_token_encrypted IS NOT NULL AND c.app_id IS NOT NULL AND c.discord_user_id IS NOT NULL) AS discord_configured
    FROM users u
    LEFT JOIN credentials c ON c.user_id = u.id
    ORDER BY u.id ASC
  `);
  res.json({ users: rows.map((r) => ({ ...r, is_admin: Boolean(r.is_admin), discord_configured: Boolean(r.discord_configured) })) });
});

// Lets the admin view (not the secret token itself, just the non-secret
// fields) and edit ANY user's Discord credentials — for fixing typos or
// setting things up on a friend's behalf without needing their password.
app.get("/api/admin/users/:id/credentials", requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  const { rows } = await query(
    `SELECT app_id, discord_user_id, platform, discord_linked,
            bot_token_encrypted IS NOT NULL AS has_token,
            client_secret_encrypted IS NOT NULL AS has_client_secret
     FROM credentials WHERE user_id = $1`,
    [targetId]
  );
  res.json(
    rows[0]
      ? { ...rows[0], discord_linked: Boolean(rows[0].discord_linked), has_client_secret: Boolean(rows[0].has_client_secret) }
      : { app_id: "", discord_user_id: "", platform: "auto", has_token: false, has_client_secret: false, discord_linked: false }
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
    releaseSlotIfOwned(targetId);
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
