// Providers return normalized messages;
// Watchers never depend on a local messenger script.
export function createAdapter(
  provider,
  { fetchImpl = fetch, env = process.env } = {},
) {
  if (provider?.type !== "discord")
    throw new Error("Unsupported messenger provider");
  return {
    async messages(channel, since) {
      const token = env[provider.token_env || "DISCORD_BOT_TOKEN"];
      if (!token)
        throw new Error("Messenger token environment variable is missing");
      const messages = [];
      let before;
      const cursors = new Set();
      while (true) {
        const url = new URL(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`,
        );
        url.searchParams.set("limit", "100");
        if (before) url.searchParams.set("before", before);
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new Error(`Discord read failed (${response.status})`);
        const page = await response.json();
        if (!Array.isArray(page)) throw new Error("Invalid Discord response");
        for (const m of page) {
          if (
            !m.id ||
            !m.author?.id ||
            !Number.isFinite(Date.parse(m.timestamp))
          )
            throw new Error("Invalid Discord message");
          if (Date.parse(m.timestamp) >= since)
            messages.push({
              id: m.id,
              channel,
              author_id: m.author.id,
              created_at: m.timestamp,
              body: m.content || "",
              reply_to_id: m.message_reference?.message_id || null,
            });
        }
        if (
          page.length < 100 ||
          page.some((m) => Date.parse(m.timestamp) < since)
        )
          break;
        before = page.at(-1).id;
        if (cursors.has(before))
          throw new Error("Discord pagination did not advance");
        cursors.add(before);
      }
      return messages;
    },
  };
}
