// Validates a manually-obtained OAuth2 access token for the "Widgets v2"
// linking step (see server/riot.js history / README for the full backstory
// on why this is needed — it's Discord's experimental "Social SDK" widget
// feature, not the documented "Linked Roles" system).
//
// Each person gets this token themselves, by hand, using Discord's own
// Developer Portal "OAuth2 URL Generator": register any placeholder
// Redirect URI (https://discord.com works fine), check the `openid` and
// `sdk.social_layer` scopes, generate the URL, change response_type=code to
// response_type=token in it, open it, authorize, and copy the access_token
// value out of the resulting URL's fragment. That's the value that gets
// pasted into the site.
//
// This token expires after 7 days (implicit grant never issues a refresh
// token), so this isn't a one-time-forever setup — it has to be repeated
// periodically.

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

module.exports = { fetchDiscordSelf };
