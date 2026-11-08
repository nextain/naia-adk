// Providers return normalized messages;
// Watchers never depend on a local messenger script.
export function createAdapter(
  provider,
  { fetchImpl = fetch, env = process.env } = {},
) {
  if (provider?.type !== "discord")
    throw new Error("Unsupported messenger provider");
  async function readErrorBody(response) {
    try {
      return (await response.text()).slice(0, 200);
    } catch (error) {
      return `(body read failed: ${error.message})`;
    }
  }
  return {
    async messages(channel, since) {
      const token = env[provider.token_env || "DISCORD_BOT_TOKEN"];
      if (!token)
        throw new Error("Messenger token environment variable is missing");
      const messages = [];
      const threadIds = new Set();
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
        if (!response.ok) {
          const body = await readErrorBody(response);
          throw new Error(
            `Discord channel ${channel}: HTTP ${response.status}; body: ${body}`,
          );
        }
        const page = await response.json();
        if (!Array.isArray(page)) throw new Error("Invalid Discord response");
        for (const m of page) {
          if (
            !m.id ||
            !m.author?.id ||
            !Number.isFinite(Date.parse(m.timestamp)) ||
            (m.edited_timestamp != null &&
              !Number.isFinite(Date.parse(m.edited_timestamp)))
          )
            throw new Error("Invalid Discord message");
          const attachedThreadId = m.thread?.id || m.thread_id || null;
          if (
            attachedThreadId &&
            m.thread?.thread_metadata?.archived !== true &&
            m.thread?.archived !== true
          )
            threadIds.add(attachedThreadId);
          const createdMs = Date.parse(m.timestamp);
          const editedMs = m.edited_timestamp
            ? Date.parse(m.edited_timestamp)
            : NaN;
          const effectiveMs =
            Number.isFinite(editedMs) && editedMs > createdMs
              ? editedMs
              : createdMs;
          if (effectiveMs >= since)
            messages.push({
              id: m.id,
              channel,
              author_id: m.author.id,
              created_at: m.timestamp,
              edited_at: m.edited_timestamp || null,
              edited_timestamp: m.edited_timestamp || null,
              body: m.content || "",
              reply_to_id: m.message_reference?.message_id || null,
              reply_to_author_id: m.referenced_message?.author?.id || null,
              mentions: (m.mentions || []).map((mention) => mention.id),
              mention_everyone: m.mention_everyone === true,
              thread_id: attachedThreadId,
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
      Object.defineProperty(messages, "threadIds", {
        value: [...threadIds],
        enumerable: false,
      });
      return messages;
    },
    async threads(channel, channelMessages = []) {
      const token = env[provider.token_env || "DISCORD_BOT_TOKEN"];
      if (!token)
        throw new Error("Messenger token environment variable is missing");
      const threadIds = new Set(channelMessages?.threadIds || []);
      for (const m of channelMessages || []) {
        const tid = m?.thread_id || m?.thread?.id;
        if (
          tid &&
          m?.thread?.thread_metadata?.archived !== true &&
          m?.thread?.archived !== true
        )
          threadIds.add(tid);
      }
      const url = new URL(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/threads/active`,
      );
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        if (response.status !== 404) {
          const body = await readErrorBody(response);
          throw new Error(
            `Discord channel ${channel} active threads: HTTP ${response.status}; body: ${body}`,
          );
        }
      } else {
        const data = await response.json();
        const list = Array.isArray(data?.threads)
          ? data.threads
          : Array.isArray(data)
            ? data
            : [];
        for (const item of list) {
          if (typeof item === "string") threadIds.add(item);
          else if (item && typeof item === "object") {
            if (
              item.thread?.id &&
              item.thread?.thread_metadata?.archived !== true &&
              item.thread?.archived !== true
            )
              threadIds.add(item.thread.id);
            else if (
              item.id &&
              !item.author &&
              item.thread_metadata?.archived !== true &&
              item.archived !== true &&
              (!item.parent_id || item.parent_id === channel)
            )
              threadIds.add(item.id);
          }
        }
      }
      threadIds.delete(channel);
      const result = [...threadIds];
      if (Number.isFinite(provider.max_threads) && provider.max_threads >= 0)
        return result.slice(0, provider.max_threads);
      return result;
    },
  };
}
