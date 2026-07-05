// Pushes a widget's "dynamic" fields to a single Discord user's linked
// profile connection, using THAT user's own bot token + app id — never a
// shared one, since this endpoint is tied to a specific Discord application.

async function pushToDiscord({ botToken, appId, discordUserId, dynamic }) {
  const res = await fetch(
    `https://discord.com/api/v9/applications/${appId}/users/${discordUserId}/identities/0/profile`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { dynamic } }),
    }
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${text || "(no body)"}`);
  }
  return { status: res.status };
}

module.exports = { pushToDiscord };
