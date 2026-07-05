// Auth guard
fetch("/api/me").then(r => r.json()).then(d => {
  if (!d.loggedIn) window.location.href = "/index.html";
});

document.getElementById("signOutBtn").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/index.html";
};

// ---------------- Settings ----------------

async function loadCredentials() {
  const res = await fetch("/api/credentials");
  const data = await res.json();
  document.getElementById("appId").value = data.app_id || "";
  document.getElementById("discordUserId").value = data.discord_user_id || "";
  document.getElementById("platformSelect").value = data.platform || "auto";
  const dot = document.getElementById("statusDot");
  dot.className = "status-dot " + (data.has_token && data.app_id && data.discord_user_id ? "on" : "off");
}
loadCredentials();

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
    msg.textContent = "Saved.";
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
  btn.innerHTML = '<span class="spinner"></span>Looking up...';
  msg.style.display = "none";
  document.getElementById("cardResult").classList.remove("visible");

  try {
    const res = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameName, tagLine, platform }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Lookup failed");
    lastLookup = { gameName, tagLine };
    renderCard(data);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Look up";
  }
};

function renderCard(data) {
  document.getElementById("cardHero").style.backgroundImage = data.mainSplash ? `url(${data.mainSplash})` : "none";
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
  btn.innerHTML = '<span class="spinner"></span>Pushing...';
  msg.style.display = "none";

  try {
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastLookup),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Push failed");
    msg.textContent = "Pushed to your Discord profile.";
    msg.className = "msg success";
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Push this to my Discord profile";
  }
};
