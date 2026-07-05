// Auth guard
fetch("/api/me")
  .then(r => r.json().then(d => ({ ok: r.ok, d })))
  .then(({ ok, d }) => {
    if (!ok) {
      console.error("Session check failed:", d.error);
      return;
    }
    if (!d.loggedIn) {
      window.location.href = "/index.html";
      return;
    }
    if (d.isAdmin) {
      document.getElementById("adminBadge").style.display = "inline-block";
      document.getElementById("adminPanel").style.display = "block";
      loadAdminUsers();
    }
  })
  .catch(err => console.error("Session check failed:", err));

document.getElementById("signOutBtn").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/index.html";
};

// ---------------- Streaming helper (newline-delimited JSON progress) ----------------
// Used by both lookup and push: posts a request, then reads the response body
// as it streams in, one JSON object per line — {type: "progress"|"result"|"error"}.

async function streamRequest(url, body, onProgress) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errMsg = "Request failed";
    try {
      const errBody = await res.json();
      errMsg = errBody.error || errMsg;
    } catch {
      // response wasn't JSON; keep the generic message
    }
    const err = new Error(errMsg);
    err.isBusy = res.status === 423;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // last entry may be a partial line — keep it for next chunk

    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "progress") {
        onProgress(msg.percent, msg.message);
      } else if (msg.type === "result") {
        finalPayload = msg;
      } else if (msg.type === "error") {
        throw new Error(msg.message);
      }
    }
  }

  if (!finalPayload) throw new Error("Connection closed before finishing — try again.");
  return finalPayload;
}

// ---------------- Progress bar ----------------

function showProgress(visible) {
  document.getElementById("progressWrap").style.display = visible ? "block" : "none";
  if (!visible) setProgress(0, "");
}
function setProgress(percent, message) {
  if (percent != null) {
    document.getElementById("progressFill").style.width = `${Math.max(3, Math.min(100, percent))}%`;
  }
  if (message) document.getElementById("progressLabel").textContent = message;
}

// ---------------- Settings ----------------

async function loadCredentials() {
  const res = await fetch("/api/credentials");
  const data = await res.json();
  document.getElementById("appId").value = data.app_id || "";
  document.getElementById("discordUserId").value = data.discord_user_id || "";
  document.getElementById("platformSelect").value = data.platform || "auto";
  const dot = document.getElementById("statusDot");
  dot.className = "status-dot " + (data.has_token && data.app_id && data.discord_user_id ? "on" : "off");

  const linkedDot = document.getElementById("linkedDot");
  linkedDot.className = "status-dot " + (data.discord_linked ? "on" : "off");
  document.getElementById("connectBtnLabel").textContent = data.discord_linked
    ? "Reconnect my Discord account"
    : "Connect my Discord account";
}
loadCredentials();

// After being redirected back from /discord-callback.html
(function handleDiscordRedirect() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("discord");
  if (!status) return;
  if (status === "linked") {
    showToast("Discord account connected.", "success");
  } else if (status === "error") {
    showToast(params.get("message") || "Discord connection failed.", "error");
  }
  window.history.replaceState({}, "", "/dashboard.html");
})();

document.getElementById("connectDiscordBtn").onclick = () => {
  window.location.href = "/api/discord/authorize";
};

document.getElementById("saveCredsBtn").onclick = async () => {
  const btn = document.getElementById("saveCredsBtn");
  const msg = document.getElementById("credsMsg");
  btn.disabled = true;
  msg.style.display = "none";

  try {
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: document.getElementById("appId").value.trim(),
        discordUserId: document.getElementById("discordUserId").value.trim(),
        botToken: document.getElementById("botToken").value.trim(),
        platform: document.getElementById("platformSelect").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");
    msg.textContent = "Saved. If you changed your Application ID, you'll need to reconnect your Discord account below.";
    msg.className = "msg success";
    document.getElementById("botToken").value = "";
    loadCredentials();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg error";
  } finally {
    btn.disabled = false;
  }
};

// ---------------- Lookup ----------------

let lastLookup = null;

document.getElementById("lookupBtn").onclick = async () => {
  const btn = document.getElementById("lookupBtn");
  const msg = document.getElementById("lookupMsg");
  const gameName = document.getElementById("gameName").value.trim();
  const tagLine = document.getElementById("tagLine").value.trim();
  const platform = document.getElementById("platformSelect").value;

  if (!gameName || !tagLine) {
    msg.textContent = "Enter both a Riot ID and a tag.";
    msg.className = "msg error";
    return;
  }

  btn.disabled = true;
  msg.style.display = "none";
  document.getElementById("cardResult").classList.remove("visible");
  showProgress(true);
  setProgress(3, "Starting — first-time lookups can take a while on active ranked accounts, later ones are much faster...");

  try {
    const final = await streamRequest(
      "/api/lookup/stream",
      { gameName, tagLine, platform },
      (percent, message) => setProgress(percent, message)
    );
    lastLookup = { gameName, tagLine };
    renderCard(final.data);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg error";
    if (err.isBusy) showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    showProgress(false);
  }
};

function renderCard(data) {
  const heroImg = document.getElementById("cardHeroBg");
  if (data.mainSplash) {
    heroImg.onerror = () => { heroImg.style.display = "none"; }; // fall back to plain navy if the CDN image fails
    heroImg.src = data.mainSplash;
    heroImg.style.display = "block";
  } else {
    heroImg.removeAttribute("src");
    heroImg.style.display = "none";
  }
  document.getElementById("rankIcon").src = data.rankIconUrl;
  document.getElementById("rankIcon2").src = data.rankIconUrl;
  document.getElementById("peakIcon").src = data.peakRankIconUrl;
  document.getElementById("roleIcon").src = data.roleIconUrl;
  document.getElementById("riotIdOut").textContent = data.riotId;
  document.getElementById("serverOut").textContent = data.serverLabel;
  document.getElementById("rankOut").textContent = data.rankText;
  document.getElementById("peakOut").textContent = data.peakRankText.replace(/^Peak:\s*/, "");
  document.getElementById("roleOut").textContent = data.mainRoleText;
  document.getElementById("wlOut").textContent = `${data.winLose} (${data.winRate})`;
  document.getElementById("historyOut").textContent = data.matchHistoryText;

  const champRow = document.getElementById("champRow");
  champRow.innerHTML = "";
  for (const c of data.champEntries) {
    const el = document.createElement("div");
    el.className = "champ-chip";
    el.innerHTML = `<img src="${c.icon}" alt="${c.champion}"><div class="name">${c.champion}</div><div class="sub">${c.line1}</div><div class="sub">${c.line2}</div>`;
    champRow.appendChild(el);
  }

  document.getElementById("cardResult").classList.add("visible");
}

document.getElementById("pushBtn").onclick = async () => {
  const btn = document.getElementById("pushBtn");
  const msg = document.getElementById("pushMsg");
  if (!lastLookup) return;

  btn.disabled = true;
  msg.style.display = "none";
  showProgress(true);
  setProgress(3, "Starting push — this can take a while on an active ranked account...");

  try {
    const final = await streamRequest(
      "/api/push/stream",
      lastLookup,
      (percent, message) => setProgress(percent, message)
    );
    renderCard(final.data);
    msg.textContent = "Pushed to your Discord profile.";
    msg.className = "msg success";
    showToast("Pushed to your Discord profile.", "success");
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg error";
    if (err.isBusy) showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    showProgress(false);
  }
};

// ---------------- Admin ----------------

async function loadAdminUsers() {
  try {
    const res = await fetch("/api/admin/users");
    const data = await res.json();
    const tbody = document.getElementById("adminTableBody");
    tbody.innerHTML = "";

    for (const u of data.users) {
      const tr = document.createElement("tr");
      const joined = new Date(u.created_at).toLocaleDateString();
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td>${joined}</td>
        <td><span class="status-dot ${u.discord_configured ? "on" : "off"}"></span>${u.discord_configured ? "Yes" : "No"}</td>
        <td>${u.is_admin ? "Admin" : "Summoner"}</td>
        <td class="admin-actions">
          <button class="btn-mini" data-action="edit" data-id="${u.id}">Edit</button>
          <button class="btn-mini btn-mini-danger" data-action="delete" data-id="${u.id}" ${u.is_admin ? "disabled title=\"Can't delete an admin account here\"" : ""}>Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('button[data-action="edit"]').forEach((b) => {
      b.onclick = () => toggleEditRow(Number(b.dataset.id), data.users.find((u) => u.id === Number(b.dataset.id)).username);
    });
    tbody.querySelectorAll('button[data-action="delete"]').forEach((b) => {
      b.onclick = () => deleteUser(Number(b.dataset.id), data.users.find((u) => u.id === Number(b.dataset.id)).username);
    });
  } catch (err) {
    console.error("Failed to load admin user list:", err);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function toggleEditRow(userId, username) {
  const existing = document.getElementById(`editRow-${userId}`);
  if (existing) {
    existing.remove();
    return;
  }
  document.querySelectorAll(".admin-edit-row").forEach((el) => el.remove());

  let creds;
  try {
    const res = await fetch(`/api/admin/users/${userId}/credentials`);
    creds = await res.json();
  } catch {
    showToast("Couldn't load that user's settings.", "error");
    return;
  }

  const anchorBtn = document.querySelector(`button[data-id="${userId}"][data-action="edit"]`);
  const row = anchorBtn.closest("tr");
  const editRow = document.createElement("tr");
  editRow.className = "admin-edit-row";
  editRow.id = `editRow-${userId}`;
  editRow.innerHTML = `
    <td colspan="5">
      <div class="admin-edit-form">
        <div class="row">
          <div>
            <label>Application ID</label>
            <input id="adminAppId-${userId}" value="${escapeHtml(creds.app_id || "")}">
          </div>
          <div>
            <label>Discord User ID</label>
            <input id="adminDiscordId-${userId}" value="${escapeHtml(creds.discord_user_id || "")}">
          </div>
        </div>
        <label>Bot Token ${creds.has_token ? "(one is already saved — leave blank to keep it)" : "(none saved yet)"}</label>
        <input id="adminBotToken-${userId}" type="password" placeholder="Leave blank to keep the current token">
        <label>Server</label>
        <select id="adminPlatform-${userId}">
          <option value="auto">Auto-detect</option>
          <option value="na1">NA</option><option value="euw1">EUW</option><option value="eun1">EUNE</option>
          <option value="kr">KR</option><option value="br1">BR</option><option value="jp1">JP</option>
          <option value="ru">RU</option><option value="oc1">OCE</option><option value="tr1">TR</option>
          <option value="la1">LAN</option><option value="la2">LAS</option>
        </select>
        <button class="btn-primary" id="adminSaveBtn-${userId}" style="margin-top:12px;">Save for ${escapeHtml(username)}</button>
        <div class="msg" id="adminEditMsg-${userId}"></div>
      </div>
    </td>
  `;
  row.after(editRow);
  document.getElementById(`adminPlatform-${userId}`).value = creds.platform || "auto";

  document.getElementById(`adminSaveBtn-${userId}`).onclick = async () => {
    const msg = document.getElementById(`adminEditMsg-${userId}`);
    try {
      const res = await fetch(`/api/admin/users/${userId}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: document.getElementById(`adminAppId-${userId}`).value.trim(),
          discordUserId: document.getElementById(`adminDiscordId-${userId}`).value.trim(),
          botToken: document.getElementById(`adminBotToken-${userId}`).value.trim(),
          platform: document.getElementById(`adminPlatform-${userId}`).value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      msg.textContent = "Saved.";
      msg.className = "msg success";
      showToast(`Updated ${username}'s Discord settings.`, "success");
      loadAdminUsers();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg error";
    }
  };
}

async function deleteUser(userId, username) {
  if (!confirm(`Delete ${username}'s account? This can't be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Delete failed");
    showToast(`Deleted ${username}.`, "success");
    loadAdminUsers();
  } catch (err) {
    showToast(err.message, "error");
  }
}
