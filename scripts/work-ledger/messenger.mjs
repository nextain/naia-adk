// Providers return normalized messages;
// Watchers never depend on a local messenger script.
export function createAdapter(
  provider,
  {
    fetchImpl = fetch,
    env = process.env,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
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
  let retryWaitMs = 0;
  const activeGuilds = new Map();
  const threadOwners = new Map();
  const referencedAuthors = new Map();
  async function request(url, options) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(30000),
      });
      if (response.status !== 429) return response;
      const body = await response.text();
      const retryHeader = response.headers?.get?.("retry-after");
      let retryAfter = retryHeader == null ? NaN : Number(retryHeader);
      try {
        retryAfter = Number(JSON.parse(body).retry_after ?? retryAfter);
      } catch {
        // Some proxies send plain text; use Retry-After when available.
      }
      if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = 1;
      if (attempt === 0 && retryAfter <= 5 && retryWaitMs + retryAfter * 1000 <= 30000) {
        retryWaitMs += retryAfter * 1000;
        await sleep(retryAfter * 1000);
        continue;
      }
      const error = new Error(`Discord HTTP 429; body: ${body.slice(0, 200)}`);
      error.status = 429;
      error.retry_after = retryAfter;
      error.retry_exhausted = true;
      throw error;
    }
  }
  const threadOffsets = new Map();
  const channelGuilds = new Map();
  const directChannels = new Set();
  return {
    beginRound() { activeGuilds.clear(); referencedAuthors.clear(); threadOwners.clear(); retryWaitMs = 0; },
    messageUrl(channel, messageId) {
      if (directChannels.has(channel)) return `https://discord.com/channels/@me/${channel}/${messageId}`;
      const guild = provider.guild_id || provider.guildId || channelGuilds.get(channel);
      return guild
        ? `https://discord.com/channels/${guild}/${channel}/${messageId}`
        : null;
    },
    async messages(channel, since) {
      const token = env[provider.token_env || "DISCORD_BOT_TOKEN"];
      if (!token)
        throw new Error("Messenger token environment variable is missing");
      const messages = [];
      const seenIds = new Set();
      const threadIds = new Set();
      let guildId =
        provider.guild_id ||
        provider.guildId ||
        channelGuilds.get(channel) ||
        null;
      let before;
      let seenCreatedBeforeSince = false;
      const cursors = new Set();
      const maxPages =
        Number.isFinite(provider.max_pages) && provider.max_pages > 0
          ? provider.max_pages
          : 10;
      const maxOldPages =
        Number.isFinite(provider.max_old_pages) && provider.max_old_pages >= 0
          ? provider.max_old_pages
          : maxPages;
      let pageCount = 0;
      let oldPages = 0;
      while (true) {
        const url = new URL(
          `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`,
        );
        url.searchParams.set("limit", "100");
        if (before) url.searchParams.set("before", before);
        const response = await request(url, {
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
        let hasRecentOnPage = false;
        for (const m of page) {
          if (
            !m.id ||
            !m.author?.id ||
            !Number.isFinite(Date.parse(m.timestamp)) ||
            (m.edited_timestamp != null &&
              !Number.isFinite(Date.parse(m.edited_timestamp)))
          )
            throw new Error("Invalid Discord message");
          if (!guildId && (m.guild_id || m.thread?.guild_id)) {
            guildId = m.guild_id || m.thread?.guild_id;
            channelGuilds.set(channel, guildId);
          }
          const attachedThreadId = m.thread?.id || m.thread_id || null;
          if (
            attachedThreadId &&
            m.thread?.thread_metadata?.archived !== true &&
            m.thread?.archived !== true
          )
            {
              threadIds.add(attachedThreadId);
              if (guildId) channelGuilds.set(attachedThreadId, guildId);
              if (m.thread?.owner_id) threadOwners.set(attachedThreadId, m.thread.owner_id);
            }
          referencedAuthors.set(`${channel}:${m.id}`, Promise.resolve(m.author.id));
          const createdMs = Date.parse(m.timestamp);
          if (createdMs < since) seenCreatedBeforeSince = true;
          const editedMs = m.edited_timestamp
            ? Date.parse(m.edited_timestamp)
            : NaN;
          const effectiveMs =
            Number.isFinite(editedMs) && editedMs > createdMs
              ? editedMs
              : createdMs;
          if (effectiveMs >= since && !seenIds.has(m.id)) {
            let replyAuthor = m.referenced_message?.author?.id || null;
            const reference = m.message_reference;
            if (!replyAuthor && reference?.message_id) {
              const referenceChannel = reference.channel_id || channel;
              const key = `${referenceChannel}:${reference.message_id}`;
              if (!referencedAuthors.has(key)) referencedAuthors.set(key, (async () => {
                const reply = await request(new URL(`https://discord.com/api/v10/channels/${encodeURIComponent(referenceChannel)}/messages/${encodeURIComponent(reference.message_id)}`), {
                  headers: { Authorization: `Bot ${token}` },
                });
                if (!reply.ok) return null;
                return (await reply.json())?.author?.id || null;
              })());
              try { replyAuthor = await referencedAuthors.get(key); }
              catch { /* Deleted/inaccessible references retain explicit mentions and thread context. */ }
            }
            seenIds.add(m.id);
            hasRecentOnPage = true;
            messages.push({
              id: m.id,
              channel,
              guild_id: m.guild_id || null,
              author_id: m.author.id,
              webhook_id: m.webhook_id || null,
              created_at: m.timestamp,
              edited_at: m.edited_timestamp || null,
              edited_timestamp: m.edited_timestamp || null,
              body: m.content || "",
              reply_to_id: m.message_reference?.message_id || null,
              reply_to_author_id: replyAuthor,
              mentions: (m.mentions || []).map((mention) =>
                typeof mention === "string" ? mention : mention.id,
              ),
              mention_roles: (m.mention_roles || []).map((roleId) =>
                typeof roleId === "string" ? roleId : roleId.id,
              ),
              mention_everyone: m.mention_everyone === true,
              thread_id: attachedThreadId,
              thread: m.thread || null,
            });
          }
        }
        pageCount += 1;
        if (hasRecentOnPage) oldPages = 0;
        else oldPages += 1;
        if (
          page.length < 100 ||
          pageCount >= maxPages ||
          oldPages >= maxOldPages
        )
          break;
        before = page.at(-1).id;
        if (cursors.has(before)) {
          if (seenCreatedBeforeSince) break;
          throw new Error("Discord pagination did not advance");
        }
        cursors.add(before);
      }
      Object.defineProperty(messages, "threadIds", {
        value: [...threadIds],
        enumerable: false,
      });
      Object.defineProperty(messages, "guildId", {
        value: guildId,
        enumerable: false,
      });
      return messages;
    },
    async threads(channel, channelMessages = [], options = {}) {
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
      if (options.direct) directChannels.add(channel);
      if (directChannels.has(channel)) return [];
      let targetGuild =
        options?.guildId ||
        provider.guild_id ||
        provider.guildId ||
        channelMessages?.guildId ||
        channelMessages?.find?.((m) => m?.guild_id)?.guild_id ||
        channelGuilds.get(channel) ||
        null;
      if (!targetGuild) {
        try {
          const chUrl = new URL(
            `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}`,
          );
          const chResponse = await request(chUrl, {
            headers: { Authorization: `Bot ${token}` },
            signal: AbortSignal.timeout(30000),
          });
          if (chResponse?.ok) {
            const chData = await chResponse.json();
            if (chData?.type === 1 || chData?.type === 3) {
              directChannels.add(channel);
              return [];
            }
            if (
              chData &&
              typeof chData === "object" &&
              !Array.isArray(chData) &&
              typeof chData.guild_id === "string" &&
              chData.guild_id
            ) {
              targetGuild = chData.guild_id;
              channelGuilds.set(channel, targetGuild);
            }
          }
        } catch (error) {
          if (error.status === 429) throw error;
          // Fall through to active threads request so HTTP/network errors surface there.
        }
      }
      targetGuild = targetGuild || channel;
      const url = new URL(
        `https://discord.com/api/v10/guilds/${encodeURIComponent(targetGuild)}/threads/active`,
      );
      // Cache the promise, including failures, for this watch round.
      if (targetGuild !== channel) {
        for (const tid of threadIds) channelGuilds.set(tid, targetGuild);
      }
      if (!activeGuilds.has(targetGuild)) activeGuilds.set(targetGuild, (async () => {
        const response = await request(url, {
          headers: { Authorization: `Bot ${token}` },
        });
        if (!response.ok) {
          const body = await readErrorBody(response);
          throw new Error(`Discord guild ${targetGuild} active threads: HTTP ${response.status}; body: ${body}`);
        }
        const data = await response.json();
        return Array.isArray(data?.threads) ? data.threads : Array.isArray(data) ? data : [];
      })());
      const list = await activeGuilds.get(targetGuild);
      for (const item of list) {
        if (item?.id && item.owner_id) threadOwners.set(item.id, item.owner_id);
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
      threadIds.delete(channel);
      const result = [...threadIds];
      Object.defineProperty(result, "threadOwners", { value: new Map(threadOwners) });
      if (targetGuild !== channel) {
        for (const threadId of result) channelGuilds.set(threadId, targetGuild);
      }
      if (
        options?.all !== true &&
        Number.isFinite(provider.max_threads) &&
        provider.max_threads >= 0
      ) {
        const limit = Math.max(0, provider.max_threads);
        if (limit === 0 || result.length === 0) return [];
        if (result.length <= limit) return result;
        const offset = (threadOffsets.get(channel) ?? 0) % result.length;
        const rotated = Array.from(
          { length: limit },
          (_, i) => result[(offset + i) % result.length],
        );
        threadOffsets.set(channel, (offset + limit) % result.length);
        return rotated;
      }
      return result;
    },
  };
}
