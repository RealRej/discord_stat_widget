// Handles the one-time "Connect my Discord account" step for Discord's
// experimental "Profile Widgets v2" feature (built on their Social SDK) —
// this is what the profile-push endpoint your script uses actually belongs
// to, confirmed against community documentation (chloecinders.com/blog/
// discord-widgets, rohan.run/writing/discord-widgets). It is NOT the
// documented "Linked Roles" system (that uses a different scope entirely
// and produces a different visual result), so don't confuse the two.
//
// Per that documentation, this specifically requires the IMPLICIT grant
// (response_type=token) with scope "openid sdk.social_layer" — not the
// standard authorization-code grant. Implicit grant returns the access
// token directly in the redirect URL's fragment (#access_token=...), which
// browsers never send to a server, so a small client-side page has to read
// it and hand it to our server itself (see public/discord-callback.html).
// No Client Secret is needed for this flow, unlike the code grant.

const AUTHORIZE_URL = "https://discord.com/api/oauth2/authorize";
const SCOPES = "openid sdk.social_layer";

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: SCOPES,
    state,
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// Sanity-checks a token by hitting Discord's real, documented /users/@me
// endpoint — confirms the token is genuinely valid and tells us which
// Discord account it belongs to, so we can catch a mismatch (e.g. someone
// authorizing with the wrong Discord account) before marking anything linked.
async function fetchDiscordSelf(accessToken) {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Discord token check ${res.status}: ${text || "(no body)"}`);
  }
  return JSON.parse(text); // { id, username, ... }
}

module.exports = { buildAuthorizeUrl, fetchDiscordSelf, SCOPES };
