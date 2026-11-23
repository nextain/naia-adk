export function messageContext({identities,otherRoleUserIds,humans,relays,ownTargets,byId,threadStarterAuthor,directChannels,channel,otherIdentities}) {
          function isHumanOrRelay(m) {
            if (
              identities.includes(m.author_id) ||
              otherRoleUserIds.includes(m.author_id)
            )
              return false;
            if (humans.includes(m.author_id) || relays.includes(m.author_id))
              return true;
            if (m.webhook_id) return true;
            if (humans.some((h) => (m.body || "").includes(`[${h}]`)))
              return true;
            return false;
          }
          function extractMentions(m) {
            const mentions = new Set(
              (m.mentions ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of (m.body || "").matchAll(/<@!?(\w[\w-]*)>/g))
              mentions.add(match[1]);
            const roleMentions = new Set(
              (m.mention_roles ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of (m.body || "").matchAll(/<@&(\w[\w-]*)>/g))
              roleMentions.add(match[1]);
            const allMentions = new Set([...mentions, ...roleMentions]);
            const everyoneOrHere =
              m.mention_everyone === true ||
              /(?<![\p{L}\p{N}_@])@(?:everyone|here)\b/u.test(m.body || "");
            const tokens = [
              ...[...mentions].filter(Boolean).map((id) => `u:${id}`),
              ...[...roleMentions].filter(Boolean).map((id) => `r:${id}`),
              ...(everyoneOrHere ? ["all"] : []),
            ].sort();
            return {
              mentions,
              roleMentions,
              allMentions,
              everyoneOrHere,
              tokens,
            };
          }
          function extractItemMentions(i) {
            const quote = i?.from?.quote || "";
            const mentions = new Set(
              (i?.from?.mentions ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of quote.matchAll(/<@!?(\w[\w-]*)>/g))
              mentions.add(match[1]);
            const roleMentions = new Set(
              (i?.from?.mention_roles ?? []).map((value) =>
                typeof value === "string" ? value : value.id,
              ),
            );
            for (const match of quote.matchAll(/<@&(\w[\w-]*)>/g))
              roleMentions.add(match[1]);
            const everyoneOrHere =
              i?.from?.mention_everyone === true ||
              /(?<![\p{L}\p{N}_@])@(?:everyone|here)\b/u.test(quote);
            return new Set([
              ...[...mentions].filter(Boolean).map((id) => `u:${id}`),
              ...[...roleMentions].filter(Boolean).map((id) => `r:${id}`),
              ...(everyoneOrHere ? ["all"] : []),
            ]);
          }
          function addressed(m, followsRecordedTask = false) {
            const { allMentions, everyoneOrHere } = extractMentions(m);
            const ownMention = ownTargets.some((id) => allMentions.has(id));
            const parentAuthor =
              m.reply_to_author_id ||
              m.reply_to?.author_id ||
              m.reply_to?.author?.id ||
              byId.get(m.reply_to_id)?.author_id ||
              threadStarterAuthor.get(m.channel);
            const ownReply = ownTargets.includes(parentAuthor);
            const inDirectChannel =
              directChannels.includes(channel) ||
              directChannels.includes(m.channel);
            if (ownMention || ownReply || inDirectChannel) return true;
            const otherReply = Boolean(
              parentAuthor &&
                (otherIdentities.includes(parentAuthor) ||
                  (!ownTargets.includes(parentAuthor) &&
                    !humans.includes(parentAuthor) &&
                    !relays.includes(parentAuthor))),
            );
            if (otherReply) return false;
            return everyoneOrHere || followsRecordedTask;
          }
          function messageTimes(m) {
            const createdMs = Date.parse(m.created_at || m.timestamp);
            const rawEdit = m.edited_at || m.edited_timestamp;
            const editedMs = rawEdit ? Date.parse(rawEdit) : NaN;
            const isEdited = Number.isFinite(editedMs) && editedMs > createdMs;
            const effectiveMs = isEdited ? editedMs : createdMs;
            return { createdMs, editedMs, isEdited, effectiveMs };
          }
    return {isHumanOrRelay,extractMentions,extractItemMentions,addressed,messageTimes};
}
