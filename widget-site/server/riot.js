// Refactored from the original single-user script. Behavior is the same;
// the main change is that gameName/tagLine/platform are now function
// parameters instead of module-level globals, since this server may be
// handling several friends' lookups at the same time and shared mutable
// globals would let one request's platform leak into another's.

const { query } = require("./db");

const CONTINENTAL_ROUTES = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas", oc1: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
};

const SERVER_NAMES = {
  na1: "NA", euw1: "EUW", eun1: "EUNE", kr: "KR", br1: "BR",
  jp1: "JP", ru: "RU", oc1: "OCE", tr1: "TR", la1: "LAN", la2: "LAS",
};

const RANK_MINI_CREST_BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests";
const RANK_MINI_CREST_SIZE_PX = 80;

const SEASON_START_ISO = "2026-01-08T00:00:00Z";
const SEASON_START_EPOCH_SECONDS = Math.floor(new Date(SEASON_START_ISO).getTime() / 1000);
const SEASON_FETCH_DELAY_MS = 1300;
const UNRANKED_FALLBACK_QUEUES = [400, 480];

const ROLE_DISPLAY_NAMES = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support" };
const ROLE_ICON_BASE = "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg";
const ROLE_ICON_KEYS = { TOP: "top", JUNGLE: "jungle", MIDDLE: "middle", BOTTOM: "bottom", UTILITY: "utility" };
const ROLE_ICON_SIZE_PX = 64;
const TRANSPARENT_PIXEL_URL = "https://www.google.com/images/cleardot.gif";

const WR_YELLOW_BAND = 1.5;
const WR_BLUE_THRESHOLD = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDetectedPlatformMatch(matchId, platform) {
  return matchId.split("_")[0].toLowerCase() === platform;
}

async function riotFetch(url, apiKey) {
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });

  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get("retry-after")) || 5;
    await sleep(retryAfterSec * 1000);
    return riotFetch(url, apiKey);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Riot API ${res.status}: ${errText}`);
  }

  return res.json();
}

async function getAccount(gameName, tagLine, apiKey) {
  return riotFetch(
    `https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    apiKey
  );
}

async function detectPlatform(puuid, apiKey) {
  const candidates = Object.keys(CONTINENTAL_ROUTES);
  const found = [];

  for (const candidate of candidates) {
    const url = `https://${candidate}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
    const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
    if (res.ok) found.push(candidate);
    await sleep(80);
  }

  if (found.length === 0) {
    throw new Error("Could not find this account on any server. Check the Riot ID spelling.");
  }
  if (found.length === 1) return found[0];

  return disambiguateTransferredAccount(puuid, found, apiKey);
}

async function disambiguateTransferredAccount(puuid, found, apiKey) {
  const shardsByRegion = new Map();
  for (const candidate of found) {
    const region = CONTINENTAL_ROUTES[candidate];
    if (!shardsByRegion.has(region)) shardsByRegion.set(region, []);
    shardsByRegion.get(region).push(candidate);
  }

  const contenders = [];
  for (const [region, shards] of shardsByRegion) {
    const ids = await riotFetch(
      `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=1`,
      apiKey
    );
    await sleep(80);
    const matchId = ids[0];
    if (!matchId) continue;

    const idPlatform = matchId.split("_")[0].toLowerCase();
    if (!shards.includes(idPlatform)) continue;

    const details = await riotFetch(`https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`, apiKey);
    await sleep(80);
    const timestamp = details.info.gameEndTimestamp || details.info.gameStartTimestamp;
    contenders.push({ platform: idPlatform, timestamp });
  }

  if (contenders.length === 0) return found[0];
  contenders.sort((a, b) => b.timestamp - a.timestamp);
  return contenders[0].platform;
}

async function getLeagueEntries(puuid, platform, apiKey) {
  return riotFetch(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, apiKey);
}

function getActiveRankedQueue(entries) {
  const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5");
  if (solo) return { entry: solo, queueId: 420, queueLabel: "Solo Queue" };
  const flex = entries.find((e) => e.queueType === "RANKED_FLEX_SR");
  if (flex) return { entry: flex, queueId: 440, queueLabel: "Flex Queue" };
  return null;
}

function getWinRateEmoji(wrPercent) {
  if (wrPercent < 50 - WR_YELLOW_BAND) return "\u{1F534}"; // red
  if (wrPercent >= WR_BLUE_THRESHOLD) return "\u{1F535}"; // blue
  if (wrPercent > 50 + WR_YELLOW_BAND) return "\u{1F7E2}"; // green
  return "\u{1F7E1}"; // yellow
}

function getRankedStatsText(activeQueue) {
  const { entry } = activeQueue;
  const total = entry.wins + entry.losses;
  const wr = total === 0 ? 0 : ((entry.wins / total) * 100).toFixed(1);
  return { winLose: `${entry.wins}W / ${entry.losses}L`, wr: `${getWinRateEmoji(Number(wr))} ${wr}%` };
}

async function getTopMasteries(puuid, platform, apiKey) {
  return riotFetch(
    `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=3`,
    apiKey
  );
}

async function getRecentMatchIds(puuid, queueId, count, continentalRegion, platform, apiKey) {
  const ids = await riotFetch(
    `https://${continentalRegion}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}&queue=${queueId}`,
    apiKey
  );
  return ids.filter((id) => isDetectedPlatformMatch(id, platform));
}

async function getMatchDetails(matchId, continentalRegion, apiKey) {
  return riotFetch(`https://${continentalRegion}.api.riotgames.com/lol/match/v5/matches/${matchId}`, apiKey);
}

async function fetchAllMatches(matchIds, continentalRegion, apiKey, onMatch = () => {}, shouldCancel = () => false) {
  const matches = [];
  for (let i = 0; i < matchIds.length; i++) {
    raiseIfCancelled(shouldCancel);
    try {
      matches.push(await getMatchDetails(matchIds[i], continentalRegion, apiKey));
    } catch {
      // skip unreadable match, keep going
    }
    onMatch(i + 1, matchIds.length);
    await sleep(100);
  }
  return matches;
}

async function getUnrankedFallbackMatches(puuid, countPerQueue, continentalRegion, platform, apiKey, onMatch = () => {}, shouldCancel = () => false) {
  const allIds = [];
  for (const queueId of UNRANKED_FALLBACK_QUEUES) {
    allIds.push(...(await getRecentMatchIds(puuid, queueId, countPerQueue, continentalRegion, platform, apiKey)));
  }
  const matches = await fetchAllMatches(allIds, continentalRegion, apiKey, onMatch, shouldCancel);
  matches.sort((a, b) => {
    const aTime = a.info.gameEndTimestamp || a.info.gameStartTimestamp;
    const bTime = b.info.gameEndTimestamp || b.info.gameStartTimestamp;
    return bTime - aTime;
  });
  return matches;
}

function getUnrankedStatsText(puuid, matches) {
  let wins = 0, losses = 0;
  for (const match of matches) {
    const me = match.info.participants.find((p) => p.puuid === puuid);
    if (!me) continue;
    if (me.win) wins++; else losses++;
  }
  const total = wins + losses;
  if (total === 0) return { winLose: "0W / 0L", wr: "0%" };
  const wr = ((wins / total) * 100).toFixed(1);
  return { winLose: `${wins}W / ${losses}L`, wr: `${getWinRateEmoji(Number(wr))} ${wr}%` };
}

function getRoleIconUrl(teamPosition) {
  const key = ROLE_ICON_KEYS[teamPosition] || "top";
  const svgUrl = `${ROLE_ICON_BASE}/position-${key}.svg`;
  return `https://wsrv.nl/?url=${encodeURIComponent(svgUrl)}&output=png&w=${ROLE_ICON_SIZE_PX}`;
}

function getMainRole(puuid, matches) {
  const roleCounts = {};
  for (const match of matches) {
    const me = match.info.participants.find((p) => p.puuid === puuid);
    if (!me || !me.teamPosition) continue;
    roleCounts[me.teamPosition] = (roleCounts[me.teamPosition] || 0) + 1;
  }
  let topRole = null, topCount = 0;
  for (const [role, count] of Object.entries(roleCounts)) {
    if (count > topCount) { topCount = count; topRole = role; }
  }
  return topRole;
}

function getMatchHistoryEmojis(puuid, matches, count = 12) {
  const recent = matches.slice(0, count);
  const emojis = recent
    .map((match) => {
      const me = match.info.participants.find((p) => p.puuid === puuid);
      if (!me) return null;
      return me.win ? "\u{1F7E2}" : "\u{1F534}";
    })
    .filter(Boolean);
  return emojis.length > 0 ? emojis.join(" ") : "No recent games";
}

function getRankIconUrl(tier) {
  const lower = tier ? tier.toLowerCase() : "unranked";
  if (lower === "emerald") {
    const svgUrl = `${RANK_MINI_CREST_BASE}/emerald.svg`;
    return `https://wsrv.nl/?url=${encodeURIComponent(svgUrl)}&output=png&w=${RANK_MINI_CREST_SIZE_PX}`;
  }
  return `${RANK_MINI_CREST_BASE}/${lower}.png`;
}

const ARABIC_TO_ROMAN_DIVISION = { "1": "I", "2": "II", "3": "III", "4": "IV" };
const TIER_WORDS = "challenger|grandmaster|master|diamond|emerald|platinum|gold|silver|bronze|iron";

async function getPeakRankFromOpgg(gameName, tagLine, serverLabel) {
  const region = serverLabel.toLowerCase();
  const url = `https://op.gg/lol/summoners/${region}/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    if (!res.ok) {
      console.log(`[getPeakRankFromOpgg] op.gg responded ${res.status} — skipping peak rank this run`);
      return null;
    }
    const html = await res.text();

    // Match on visible TEXT CONTENT (tier name, LP number, the "Top Tier"
    // label) rather than exact CSS class names or tag structure. op.gg's
    // markup/class names change with redesigns, but the words a human reads
    // on the page are far more stable — this held up when checked against
    // op.gg's current layout, but since it's still scraping an undocumented
    // page structure, it can still break again if they change the wording.
    const plainText = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const peakMatch = plainText.match(
      // Division group requires a lookahead ensuring it's not immediately
      // followed by another digit or comma — otherwise "1" in "1,996 LP"
      // gets misread as a division number, truncating the real LP value.
      new RegExp(`(${TIER_WORDS})\\s*(I{1,3}V?(?![\\d,])|[1-4](?![\\d,]))?\\s*([\\d,]+)\\s*LP\\s*Top\\s*Tier`, "i")
    );

    if (!peakMatch) {
      console.log(`[getPeakRankFromOpgg] Could not find a "Top Tier" marker on the page — op.gg may have changed wording, or this account has no peak data`);
      return null;
    }

    const tierRaw = peakMatch[1];
    const divisionRaw = peakMatch[2];
    const lp = peakMatch[3].replace(/,/g, ""); // strip thousands separator to match Riot's own plain-number style

    // Match the same format Riot's own API uses for current rank — e.g.
    // "EMERALD IV - 76 LP" — instead of op.gg's own mixed-case, comma-LP
    // style. Apex tiers (Master/GM/Challenger) have no division on op.gg
    // either, so default to "I" the same way Riot's API does.
    const tier = tierRaw.toUpperCase();
    const division = divisionRaw ? (ARABIC_TO_ROMAN_DIVISION[divisionRaw] || divisionRaw.toUpperCase()) : "I";
    const rankText = `${tier} ${division} - ${lp} LP`;

    return { tier: tierRaw, rankText };
  } catch (err) {
    console.log(`[getPeakRankFromOpgg] Failed: ${err.message} — skipping peak rank this run`);
    return null;
  }
}

async function getVersion() {
  const res = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  const v = await res.json();
  return v[0];
}

async function getChampions(version) {
  const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
  const data = await res.json();
  const map = {};
  for (const champ of Object.values(data.data)) {
    map[champ.key] = { id: champ.id, name: champ.name, image: champ.image.full };
  }
  return map;
}

async function getRandomSplash(championId, version) {
  const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion/${championId}.json`);
  const data = await res.json();
  const skins = data.data[championId].skins;
  const shuffled = [...skins].sort(() => Math.random() - 0.5);
  for (const skin of shuffled) {
    const url = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${championId}_${skin.num}.jpg`;
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) return url;
    } catch {
      // try next skin
    }
  }
  return `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${championId}_0.jpg`;
}

// --- Season cache, now backed by Postgres instead of local files, since
// Render's free tier does not guarantee a persistent disk. ---

function defaultSeasonCache(puuid, queueId) {
  return { seasonStartIso: SEASON_START_ISO, puuid, queueId, processedMatchIds: [], champions: {} };
}

async function loadSeasonCache(puuid, queueId) {
  const { rows } = await query(
    "SELECT season_start_iso, processed_match_ids, champions FROM season_cache WHERE puuid = $1 AND queue_id = $2",
    [puuid, queueId]
  );
  if (rows.length === 0) return defaultSeasonCache(puuid, queueId);
  const row = rows[0];
  if (row.season_start_iso !== SEASON_START_ISO) return defaultSeasonCache(puuid, queueId);
  return {
    seasonStartIso: row.season_start_iso,
    puuid,
    queueId,
    processedMatchIds: JSON.parse(row.processed_match_ids),
    champions: JSON.parse(row.champions),
  };
}

async function saveSeasonCache(cache) {
  await query(
    `INSERT INTO season_cache (puuid, queue_id, season_start_iso, processed_match_ids, champions)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (puuid, queue_id) DO UPDATE
       SET processed_match_ids = $4, champions = $5, season_start_iso = $3`,
    [cache.puuid, cache.queueId, cache.seasonStartIso, JSON.stringify(cache.processedMatchIds), JSON.stringify(cache.champions)]
  );
}

function summarizeChampions(championsMap) {
  return Object.entries(championsMap)
    .map(([championId, s]) => ({ championId: Number(championId), games: s.games, wins: s.wins, losses: s.games - s.wins }))
    .sort((a, b) => b.games - a.games);
}

// Fast path for the website's quick preview: derives "most played" straight
// from the up-to-20 recent ranked matches that were ALREADY fetched for
// MainRole/WinLose/MatchHistory — zero extra Riot API calls. Unlike a cache
// of past pushes, this works immediately for every ranked player regardless
// of whether they've ever been pushed through the site before, so it never
// falls back to (potentially wildly outdated) lifetime mastery data for
// someone who's clearly actively playing ranked right now. The real push
// still runs the full, more complete season-long backfill separately.
function getRecentMostPlayed(puuid, matches) {
  const champions = {};
  for (const match of matches) {
    const me = match.info.participants.find((p) => p.puuid === puuid);
    if (!me || me.gameEndedInEarlySurrender) continue; // remakes excluded, same as the season backfill
    const champId = me.championId;
    if (!champions[champId]) champions[champId] = { games: 0, wins: 0 };
    champions[champId].games += 1;
    if (me.win) champions[champId].wins += 1;
  }
  return summarizeChampions(champions);
}

function raiseIfCancelled(shouldCancel) {
  if (shouldCancel()) {
    const err = new Error("Cancelled");
    err.cancelled = true;
    throw err;
  }
}

// Keeps a single call comfortably under any infrastructure-level connection
// timeout (proxies, load balancers, etc. commonly kill very long-lived HTTP
// requests regardless of whether data is still flowing). On an account with
// hundreds of ranked games, one call won't finish the whole season — it
// processes up to this budget, saves progress as it goes (already
// incremental), and reports back whether more remains so the caller can
// surface "run it again to keep syncing" instead of silently hanging.
const BACKFILL_MAX_MATCHES_PER_RUN = 220;
const BACKFILL_MAX_DURATION_MS = 4 * 60 * 1000; // 4 minutes — safely under typical proxy/connection timeouts, while keeping the number of repeated lookups needed for very active accounts reasonable

async function getSeasonMostPlayed(puuid, queueId, continentalRegion, platform, apiKey, onProgress = () => {}, shouldCancel = () => false) {
  const cache = await loadSeasonCache(puuid, queueId);
  const alreadyProcessed = new Set(cache.processedMatchIds);
  const seenThisRun = new Set();
  const newMatchIds = [];
  const PAGE_SIZE = 100;
  let start = 0;

  onProgress(`Checking for new ranked games since the season started...`, null);

  pageLoop:
  while (true) {
    raiseIfCancelled(shouldCancel);
    const ids = await riotFetch(
      `https://${continentalRegion}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${queueId}&startTime=${SEASON_START_EPOCH_SECONDS}&start=${start}&count=${PAGE_SIZE}`,
      apiKey
    );
    await sleep(SEASON_FETCH_DELAY_MS);
    if (ids.length === 0) break;

    for (const id of ids) {
      if (alreadyProcessed.has(id)) break pageLoop;
      if (seenThisRun.has(id)) continue;
      seenThisRun.add(id);
      if (!isDetectedPlatformMatch(id, platform)) {
        cache.processedMatchIds.push(id);
        continue;
      }
      newMatchIds.push(id);
    }
    if (ids.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  const runStart = Date.now();
  let processedThisRun = 0;
  let partial = false;

  for (let i = 0; i < newMatchIds.length; i++) {
    raiseIfCancelled(shouldCancel);

    if (processedThisRun >= BACKFILL_MAX_MATCHES_PER_RUN || Date.now() - runStart > BACKFILL_MAX_DURATION_MS) {
      partial = true;
      break;
    }

    const matchId = newMatchIds[i];
    try {
      const match = await getMatchDetails(matchId, continentalRegion, apiKey);
      const me = match.info.participants.find((p) => p.puuid === puuid);
      if (!me) continue; // retry next run
      if (!me.gameEndedInEarlySurrender) {
        const champId = me.championId;
        if (!cache.champions[champId]) cache.champions[champId] = { games: 0, wins: 0 };
        cache.champions[champId].games += 1;
        if (me.win) cache.champions[champId].wins += 1;
      }
      cache.processedMatchIds.push(matchId);
    } catch {
      // skip, retry next run
    }
    processedThisRun++;
    onProgress(
      partial
        ? `Analyzing ranked history — match ${processedThisRun} of ${newMatchIds.length} (will continue next lookup)`
        : `Analyzing ranked history — match ${processedThisRun} of ${newMatchIds.length}`,
      processedThisRun / Math.max(newMatchIds.length, 1)
    );
    await sleep(SEASON_FETCH_DELAY_MS);
  }

  await saveSeasonCache(cache);

  return {
    champions: summarizeChampions(cache.champions),
    partial,
    remaining: Math.max(newMatchIds.length - processedThisRun, 0),
  };
}


// --- Main entry point: mirrors the original script's updateWidget(), but
// RETURNS the data (for the web GUI) instead of pushing it straight to
// Discord. The caller decides whether to also push. ---

async function lookupPlayer({ apiKey, gameName, tagLine, platformPref = "auto", onProgress = () => {}, shouldCancel = () => false }) {
  // Every lookup now does the full season backfill, not just pushes. It's
  // incremental (only fetches matches it hasn't seen since last time), so
  // the FIRST time anyone is looked up it can be slow on an active account,
  // but every check after that — including an immediate push — is fast,
  // since almost nothing is new to fetch.
  const P = { account: 3, platform: 8, core: 15, matches: 25, analyze: 30, backfillStart: 30, backfillEnd: 88, peak: 93, splash: 98 };

  onProgress("Finding the account...", P.account);
  const account = await getAccount(gameName, tagLine, apiKey);

  raiseIfCancelled(shouldCancel);
  onProgress("Detecting server...", P.platform);
  const platform = platformPref === "auto" ? await detectPlatform(account.puuid, apiKey) : platformPref;
  const continentalRegion = CONTINENTAL_ROUTES[platform];
  const serverLabel = SERVER_NAMES[platform] || platform.toUpperCase();

  raiseIfCancelled(shouldCancel);
  onProgress("Fetching rank and champion data...", P.core);
  const leagueEntries = await getLeagueEntries(account.puuid, platform, apiKey);
  const activeQueue = getActiveRankedQueue(leagueEntries);
  const rank = activeQueue ? activeQueue.entry : null;

  const version = await getVersion();
  const masteries = await getTopMasteries(account.puuid, platform, apiKey);
  const champs = await getChampions(version);

  onProgress("Fetching recent match history...", P.matches);
  const onMatchProgress = (done, total) => {
    onProgress(`Fetching recent match history (${done}/${total})...`, P.core + ((P.matches - P.core) * done) / Math.max(total, 1));
  };
  const matches = activeQueue
    ? await fetchAllMatches(
        await getRecentMatchIds(account.puuid, activeQueue.queueId, 20, continentalRegion, platform, apiKey),
        continentalRegion,
        apiKey,
        onMatchProgress,
        shouldCancel
      )
    : await getUnrankedFallbackMatches(account.puuid, 20, continentalRegion, platform, apiKey, onMatchProgress, shouldCancel);

  onProgress("Analyzing main role and win rate...", P.analyze);
  const soloStats = activeQueue ? getRankedStatsText(activeQueue) : getUnrankedStatsText(account.puuid, matches);
  const mainRole = getMainRole(account.puuid, matches);
  const mainRoleText = mainRole ? ROLE_DISPLAY_NAMES[mainRole] : "N/A";
  const roleIconUrl = mainRole ? getRoleIconUrl(mainRole) : TRANSPARENT_PIXEL_URL;
  // Discord's field has limited room, so the widget only ever gets the last
  // 12 games — but the website has more space to work with, so it shows up
  // to the full 20 matches that were already fetched above.
  const matchHistoryTextDiscord = getMatchHistoryEmojis(account.puuid, matches, 12);
  const matchHistoryTextWeb = getMatchHistoryEmojis(account.puuid, matches, 20);

  let mostPlayed = [];
  let seasonSyncPartial = false;
  let seasonSyncRemaining = 0;
  if (activeQueue) {
    try {
      const backfillResult = await getSeasonMostPlayed(
        account.puuid,
        activeQueue.queueId,
        continentalRegion,
        platform,
        apiKey,
        (message, fraction) => {
          const pct = fraction == null ? P.backfillStart : P.backfillStart + (P.backfillEnd - P.backfillStart) * fraction;
          onProgress(message, pct);
        },
        shouldCancel
      );
      mostPlayed = backfillResult.champions;
      seasonSyncPartial = backfillResult.partial;
      seasonSyncRemaining = backfillResult.remaining;
    } catch (err) {
      if (err.cancelled) throw err; // don't swallow a real cancellation as if it were just a data hiccup
      // If the backfill itself fails partway (e.g. a Riot API hiccup), don't
      // fail the whole lookup — fall back to an approximation from the
      // recent matches already fetched above instead of showing nothing.
      console.log(`[lookupPlayer] Season backfill failed (${err.message}) — falling back to recent-match approximation`);
      mostPlayed = getRecentMostPlayed(account.puuid, matches);
    }
  }

  const rankText = rank ? `${rank.tier} ${rank.rank} - ${rank.leaguePoints} LP` : "Unranked";
  const rankIconUrl = getRankIconUrl(rank ? rank.tier : null);

  raiseIfCancelled(shouldCancel);
  onProgress("Checking peak rank...", P.peak);
  const opggPeak = await getPeakRankFromOpgg(account.gameName, account.tagLine, serverLabel);
  const peakRankText = opggPeak ? `Peak: ${opggPeak.rankText}` : "Peak: N/A";
  const peakRankIconUrl = getRankIconUrl(opggPeak ? opggPeak.tier : null);

  onProgress("Finding splash art...", P.splash);

  const dynamic = [
    { type: 1, name: "NicknameTag", value: `${account.gameName}#${account.tagLine}` },
    { type: 1, name: "Server", value: serverLabel },
    { type: 1, name: "Rank", value: rankText },
    { type: 3, name: "RankIcon", value: { url: rankIconUrl } },
    { type: 1, name: "WinLose", value: soloStats.winLose },
    { type: 1, name: "WR", value: `Win Rate: ${soloStats.wr}` },
    { type: 1, name: "MainRole", value: `Main Role: ${mainRoleText}` },
    { type: 3, name: "RoleIcon", value: { url: roleIconUrl } },
    { type: 1, name: "PeakRank", value: peakRankText },
    { type: 3, name: "PeakRankIcon", value: { url: peakRankIconUrl } },
    { type: 1, name: "MatchHistory", value: matchHistoryTextDiscord },
  ];

  const useRankedMostPlayed = Boolean(rank) && mostPlayed.length > 0;
  const champEntries = [];
  const entryCount = useRankedMostPlayed ? Math.min(mostPlayed.length, 3) : Math.min(masteries.length, 3);

  for (let i = 0; i < entryCount; i++) {
    if (useRankedMostPlayed) {
      const stat = mostPlayed[i];
      const champ = champs[stat.championId];
      const wr = ((stat.wins / stat.games) * 100).toFixed(1);
      champEntries.push({
        champion: champ.name,
        icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champ.image}`,
        line1: `${stat.wins}W/${stat.losses}L`,
        line2: `Win rate: ${getWinRateEmoji(Number(wr))} ${wr}%`,
      });
      dynamic.push({ type: 1, name: `Mastery${i + 1}Value`, value: `${stat.wins}W/${stat.losses}L` });
      dynamic.push({ type: 1, name: `Mastery${i + 1}Label`, value: `Win rate: ${getWinRateEmoji(Number(wr))} ${wr}%` });
      dynamic.push({ type: 3, name: `Icon${i + 1}`, value: { url: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champ.image}` } });
    } else {
      const m = masteries[i];
      const champ = champs[m.championId];
      champEntries.push({
        champion: champ.name,
        icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champ.image}`,
        line1: `Mastery ${m.championLevel}`,
        line2: `${m.championPoints.toLocaleString()} pts`,
      });
      dynamic.push({ type: 1, name: `Mastery${i + 1}Value`, value: `Mastery ${m.championLevel}` });
      dynamic.push({ type: 1, name: `Mastery${i + 1}Label`, value: `${m.championPoints.toLocaleString()} pts` });
      dynamic.push({ type: 3, name: `Icon${i + 1}`, value: { url: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champ.image}` } });
    }
  }

  let mainSplash = null;
  if (entryCount > 0) {
    const topChampId = useRankedMostPlayed ? mostPlayed[0].championId : masteries[0].championId;
    const topChamp = champs[topChampId];
    mainSplash = await getRandomSplash(topChamp.id, version);
    dynamic.push({ type: 3, name: "MainSplash", value: { url: mainSplash } });
  }

  onProgress("Done", 100);

  return {
    riotId: `${account.gameName}#${account.tagLine}`,
    puuid: account.puuid,
    platform,
    serverLabel,
    rankText,
    rankIconUrl,
    winLose: soloStats.winLose,
    winRate: soloStats.wr,
    mainRoleText,
    roleIconUrl,
    matchHistoryText: matchHistoryTextWeb,
    peakRankText,
    peakRankIconUrl,
    champEntries,
    mainSplash,
    seasonSyncPartial,
    seasonSyncRemaining,
    dynamic, // ready to hand straight to pushToDiscord()
  };
}

module.exports = { lookupPlayer };
