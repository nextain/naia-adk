#!/usr/bin/env node
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  readLedger,
  changeLedger,
  safeName,
  withLock,
  atomicJson,
  parseArgs,
} from "./ledger.mjs";
import { createAdapter } from "./messenger.mjs";
export async function watch({
  root,
  config,
  adapter,
  now = Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const wakeDir = path.join(root, ".agents/work/l4/wake");
  const stateFile = path.join(root, ".agents/work/ledger", "watch-state.json");
  await mkdir(wakeDir, { recursive: true });
  return withLock(stateFile, async () => {
    let state = { version: 1, sent: {}, thread_cursors: {}, mentions: {} };
    let stateError;
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        state.version !== 1 ||
        [state.human_wait_sent, state.channel_failures].some(
          (map) => map !== undefined && (
            !map || typeof map !== "object" || Array.isArray(map) ||
            Object.values(map).some((value) => !Number.isFinite(value) || value < 0)
          ),
        ) ||
        !state.sent ||
        typeof state.sent !== "object" ||
        Array.isArray(state.sent) ||
        Object.values(state.sent).some((v) => !Number.isFinite(v)) ||
        (state.thread_cursors !== undefined &&
          (!state.thread_cursors ||
            typeof state.thread_cursors !== "object" ||
            Array.isArray(state.thread_cursors) ||
            Object.values(state.thread_cursors).some(
              (v) => !Number.isInteger(v) || v < 0,
            ))) ||
        (state.mentions !== undefined &&
          (!state.mentions ||
            typeof state.mentions !== "object" ||
            Array.isArray(state.mentions)))
      )
        throw new Error("Invalid watch state");
      state.thread_cursors ??= {};
      state.mentions ??= {};
    } catch (error) {
      if (error.code !== "ENOENT") {
        stateError = "감시 상태 파일 읽기 실패";
        state = { version: 1, sent: {}, thread_cursors: {}, mentions: {} };
      }
    }
    state.human_wait_sent ??= {};
    state.channel_failures ??= {};
    const wakes = [];
    const warnings = [];
    const readCache = new Map();
    const failedThisRound = new Set();
    const successfulThisRound = new Set();
    let readStarted = false;
    async function readMessages(messenger, channel, since) {
      const key = `messages:${channel}`;
      if (!readCache.has(key))
        readCache.set(key, readWithRetry(() => messenger.messages(channel, since)));
      return readCache.get(key);
    }
    async function readWithRetry(read) {
      const interval = config.channel_read_interval_ms ?? 300;
      if (readStarted && interval > 0) await sleep(interval);
      readStarted = true;
      try {
        return await read();
      } catch (error) {
        const limited = error.status === 429 || /HTTP 429/.test(error.message || "");
        if (!limited || error.retry_exhausted) throw error;
        const seconds = Number(error.retry_after ?? 1);
        await sleep(
          (Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000,
        );
        return read();
      }
    }
    async function channelFailure(role, channel, error, suffix = "") {
      if (!(error.status === 429 || /HTTP 429/.test(error.message || ""))) {
        if (!failedThisRound.has(channel)) delete state.channel_failures[channel];
        errors.push(`messenger:${role}:${channel}${suffix}`);
        await wake(
          role, `messenger-error-${safeIdPart(channel)}${suffix ? "-threads" : ""}`,
          "감시 실패", "메신저 읽기 실패",
          `채널: ${channel}\n오류: ${error.message || String(error)}`,
        );
        return;
      }
      if (!failedThisRound.has(channel)) {
        state.channel_failures[channel] = (state.channel_failures[channel] || 0) + 1;
        failedThisRound.add(channel);
      }
      warnings.push(`messenger:${role}:${channel}: ${error.message || String(error)}`);
      if (state.channel_failures[channel] >= 3)
        await wake(
          role, `messenger-error-${safeIdPart(channel)}`,
          "감시 실패", "메신저 읽기 연속 실패",
          `채널: ${channel}\n연속 실패: ${state.channel_failures[channel]}회\n오류: ${error.message || String(error)}`,
        );
    }
    const errors = [];
    let sequence = 0;
    function safeIdPart(raw) {
      try {
        return safeName(raw);
      } catch {
        const cleaned = String(raw ?? "")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .replace(/^[^a-zA-Z0-9]+/, "")
          .slice(0, 40);
        const hex =
          Buffer.from(String(raw ?? "")).toString("hex").slice(0, 16) || "0";
        return cleaned ? `${cleaned}-${hex}` : `id-${hex}`;
      }
    }
    async function wake(role, id, reason, title, details = "") {
      safeName(role);
      safeName(id);
      const key = JSON.stringify([role, id, reason]);
      if (state.sent[key] !== undefined && now - state.sent[key] < 30 * 60000)
        return;
      const stamp = new Date(now + sequence++).toISOString().replace(/\D/g, "");
      const file = path.join(wakeDir, `${stamp}-ledger-${id}-route-${role}.md`);
      // wx prevents overwriting an existing wake when a prior state write failed.
      try {
        await writeFile(
          file,
          `[장부] ${reason}: ${String(title).replace(/[\r\n]/g, " ")}\n${details}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const alternate = path.join(
          wakeDir,
          `${stamp}-ledger-${id}-${randomUUID()}-route-${role}.md`,
        );
        await writeFile(alternate, `[장부] ${reason}: ${title}\n${details}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      }
      state.sent[key] = now;
      wakes.push({ role, id, reason });
    }
    if (!Array.isArray(config.roles) || !config.roles.length)
      throw new Error("Configuration requires roles");
    for (const roleConfig of config.roles) {
      const role = safeName(roleConfig.role);
      if (stateError) {
        errors.push(stateError);
        await wake(role, "watch-error", "감시 실패", stateError);
      }
      let ledger;
      try {
        try {
          ledger = await readLedger(root, role);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await changeLedger(root, role, (l) => {
            l.report = {
              every_min: roleConfig.report?.every_min ?? 0,
              channel: roleConfig.report?.channel || "",
              last_msg_id: null,
              last_at: null,
            };
          });
          ledger = await readLedger(root, role);
        }
      } catch (error) {
        errors.push(`ledger:${role}`);
        await wake(
          role,
          "ledger-error",
          "감시 실패",
          "장부 읽기 실패",
          `장부: .agents/work/ledger/${role}.json\n오류: ${error.message || String(error)}`,
        );
        continue;
      }
      for (const item of ledger.items) {
        const details = `출처: ${item.from.channel}/${item.from.msg_id}\n기한: ${item.due}\n결과: ${item.worker?.result || "(없음)"}`;
        if (item.status === "open" && Date.parse(item.due) < now)
          await wake(role, item.id, "기한 넘음", item.title, details);
        if (item.worker) {
          try {
            const info = await stat(path.resolve(root, item.worker.done_file));
            if (!item.checked_at || Date.parse(item.checked_at) < info.mtimeMs)
              await wake(
                role,
                item.id,
                "일꾼 끝, 결과 안 읽음",
                item.title,
                details,
              );
          } catch (error) {
            if (error.code !== "ENOENT") {
              errors.push(`worker:${role}:${item.id}`);
              await wake(
                role,
                item.id,
                "감시 실패",
                "일꾼 끝 파일 확인 실패",
                details,
              );
            }
          }
        }
      }
      const report =
        ledger.report.every_min === 0 && roleConfig.report
          ? {
              ...ledger.report,
              every_min: roleConfig.report.every_min,
              channel: roleConfig.report.channel,
            }
          : ledger.report;
      if (
        report.every_min > 0 &&
        (report.last_at === null ||
          now - Date.parse(report.last_at) >= report.every_min * 60000)
      )
        await wake(
          role,
          "report",
          "정기 보고 시각",
          `${report.every_min}분 정기 보고`,
          `출처: ${report.channel}\n기한: ${report.last_at ? new Date(Date.parse(report.last_at) + report.every_min * 60000).toISOString() : "첫 보고 대기"}\n결과: (없음)`,
        );
      try {
        const channels = [...new Set([
          ...(roleConfig.channels ?? config.channels ?? []),
          ...(roleConfig.direct_channels ?? []),
        ])];
        const humans = roleConfig.human_ids ?? roleConfig.humans ??
          config.human_ids ?? config.humans ?? [];
        const relays = [
          ...new Set([
            ...(roleConfig.relay_ids ?? []),
            ...(config.relay_ids ?? []),
            ...(roleConfig.relay_bot_ids ?? []),
            ...(config.relay_bot_ids ?? []),
            ...(roleConfig.relay_user_ids ?? []),
            ...(config.relay_user_ids ?? []),
            ...(roleConfig.webhook_ids ?? []),
            ...(config.webhook_ids ?? []),
          ]),
        ];
        const identities = roleConfig.user_ids ?? [];
        const roleIds = roleConfig.role_ids ?? [];
        const ownTargets = [...new Set([...identities, ...roleIds])];
        if (channels.length && (!humans.length || !ownTargets.length))
          throw new Error(
            "Messenger watch requires human_ids and role user_ids",
          );
        const messenger =
          adapter || (channels.length ? createAdapter(config.provider) : null);
        const maxThreads =
          roleConfig.max_threads ??
          config.max_threads ??
          config.provider?.max_threads ??
          25;
        const visitedThreads = new Set(channels);
        for (const channel of channels) {
          const since = now - 24 * 60 * 60000;
          let channelMessages;
          try {
            safeName(channel);
            channelMessages = await readMessages(messenger, channel, since);
          } catch (error) {
            await channelFailure(role, channel, error);
            continue;
          }
          successfulThisRound.add(channel);
          const messages = channelMessages.map((m) => ({
            ...m,
            channel: m.channel || channel,
          }));
          const threadStarterAuthor = new Map();
          const discoveredThreads = new Set(channelMessages.threadIds || []);
          for (const m of channelMessages) {
            const tid = m?.thread_id || m?.thread?.id;
            if (
              tid &&
              m?.thread?.thread_metadata?.archived !== true &&
              m?.thread?.archived !== true
            ) {
              discoveredThreads.add(tid);
              if (m.author_id) threadStarterAuthor.set(tid, m.author_id);
            }
          }
          const guildId =
            roleConfig.guild_id ??
            config.guild_id ??
            config.provider?.guild_id ??
            null;
          if (typeof messenger.threads === "function") {
            try {
              const activeThreads = await readWithRetry(() =>
                messenger.threads(channel, channelMessages, { guildId, all: true }),
              );
              for (const tid of activeThreads || []) {
                if (tid) discoveredThreads.add(tid);
              }
            } catch (error) {
              await channelFailure(role, channel, error, ":threads");
            }
          }
          const candidateThreads = [...discoveredThreads].filter(
            (tid) => tid && !visitedThreads.has(tid),
          );
          const threadLimit = Math.max(0, maxThreads);
          const cursorKey = `${role}:${channel}`;
          let threadIds = [];
          if (threadLimit > 0 && candidateThreads.length > 0) {
            if (candidateThreads.length <= threadLimit) {
              threadIds = candidateThreads;
              state.thread_cursors[cursorKey] = 0;
            } else {
              const start =
                (state.thread_cursors[cursorKey] ?? 0) %
                candidateThreads.length;
              for (let i = 0; i < threadLimit; i++) {
                threadIds.push(
                  candidateThreads[(start + i) % candidateThreads.length],
                );
              }
              state.thread_cursors[cursorKey] =
                (start + threadLimit) % candidateThreads.length;
            }
          }
          for (const threadId of threadIds) {
            visitedThreads.add(threadId);
            let threadMessages;
            try {
              safeName(threadId);
              threadMessages = await readMessages(messenger, threadId, since);
            } catch (error) {
              await channelFailure(role, threadId, error);
              continue;
            }
            successfulThisRound.add(threadId);
            for (const tm of threadMessages) {
              messages.push({ ...tm, channel: tm.channel || threadId });
            }
          }
          const byId = new Map(messages.map((m) => [m.id, m]));
          const otherRoleUserIds = config.roles
            .filter((r) => r.role !== role)
            .flatMap((r) => r.user_ids ?? [])
            .filter((id) => !identities.includes(id));
          const otherIdentities = config.roles
            .filter((r) => r.role !== role)
            .flatMap((r) => [...(r.user_ids ?? []), ...(r.role_ids ?? [])])
            .filter((id) => !ownTargets.includes(id));
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
          function addressed(m) {
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
              (roleConfig.direct_channels ?? []).includes(channel) ||
              (roleConfig.direct_channels ?? []).includes(m.channel);
            if (ownMention || ownReply || inDirectChannel) return true;
            const otherReply = Boolean(
              parentAuthor &&
                (otherIdentities.includes(parentAuthor) ||
                  (!ownTargets.includes(parentAuthor) &&
                    !humans.includes(parentAuthor) &&
                    !relays.includes(parentAuthor))),
            );
            if (otherReply) return false;
            if (everyoneOrHere) return true;
            return false;
          }
          function messageTimes(m) {
            const createdMs = Date.parse(m.created_at || m.timestamp);
            const rawEdit = m.edited_at || m.edited_timestamp;
            const editedMs = rawEdit ? Date.parse(rawEdit) : NaN;
            const isEdited = Number.isFinite(editedMs) && editedMs > createdMs;
            const effectiveMs = isEdited ? editedMs : createdMs;
            return { createdMs, editedMs, isEdited, effectiveMs };
          }
          const humanWait = {
            ...(config.human_wait ?? {}),
            ...(roleConfig.human_wait ?? {}),
          };
          const questionPatterns = humanWait.question_patterns ?? [
            "[?？](?:\\s|$)", "될까요", "알려\\s*주시면",
            "말씀\\s*주시면", "골라\\s*주시면", "기다리겠습니다",
          ];
          const questionMatchers = questionPatterns.map(
            (pattern) => new RegExp(pattern, "u"),
          );
          for (const question of messages) {
            if (!identities.includes(question.author_id)) continue;
            const parentAuthor = question.reply_to_author_id ||
              question.reply_to?.author_id || question.reply_to?.author?.id ||
              byId.get(question.reply_to_id)?.author_id;
            const mentioned = extractMentions(question).mentions;
            const targets = humans.filter((id) => mentioned.has(id) || id === parentAuthor);
            if (!targets.length || !questionMatchers.some(
              (pattern) => pattern.test(question.body || ""),
            )) continue;
            const questionAt = messageTimes(question).effectiveMs;
            if (
              !Number.isFinite(questionAt) || questionAt < since ||
              questionAt > now ||
              now - questionAt < (humanWait.after_min ?? 15) * 60000
            ) continue;
            const questionChannel = question.channel || channel;
            const continued = messages.some((post) =>
              (post.channel || channel) === questionChannel &&
              (targets.includes(post.author_id) || post.author_id === question.author_id) &&
              messageTimes(post).effectiveMs > questionAt &&
              messageTimes(post).effectiveMs <= now,
            );
            const key = JSON.stringify([role, questionChannel, question.id]);
            if (continued || state.human_wait_sent[key] !== undefined) continue;
            const guild = question.guild_id || guildId || channelMessages.guildId || "@me";
            const url = question.url || messenger.messageUrl?.(questionChannel, question.id) ||
              `https://discord.com/channels/${guild}/${questionChannel}/${question.id}`;
            const firstLine = (question.body || "").split(/\r?\n/)[0];
            await wake(
              role, `human-wait-${safeIdPart(question.id)}`,
              "사람 답 기다림", firstLine,
              `채널: ${questionChannel}\n글: ${url}\n질문: ${firstLine}\n1) 이 일에 이미 받은 지시가 있는지 그 채널 앞 글을 다시 읽음\n2) 바깥 발송·운영 변경·돈이 아니고 되돌릴 수 있으면 지금 진행하고 그 채널에 알림\n3) 정말 사람 승인이 필요한 일이면 #업무-요청 에 [분류] 양식으로 옮김`,
            );
            state.human_wait_sent[key] = now;
          }
          for (const m of messages) {
            try {
              if (!isHumanOrRelay(m) || !addressed(m)) continue;
              const { editedMs, isEdited, effectiveMs } = messageTimes(m);
              if (
                !Number.isFinite(effectiveMs) ||
                effectiveMs < since ||
                effectiveMs > now
              )
                continue;
              const msgChannel = m.channel || channel;
              const replies = messages.filter(
                (r) =>
                  identities.includes(r.author_id) &&
                  (r.channel || channel) === msgChannel &&
                  r.reply_to_id === m.id,
              );
              const isReplied = isEdited
                ? replies.some((r) => messageTimes(r).effectiveMs >= editedMs)
                : replies.length > 0;
              const isAnsweredAfter =
                roleConfig.answered_by_any_role_post_after === true &&
                messages.some(
                  (post) =>
                    identities.includes(post.author_id) &&
                    (post.channel || channel) === msgChannel &&
                    messageTimes(post).effectiveMs > effectiveMs &&
                    messageTimes(post).effectiveMs <= now,
                );
              const { tokens: msgMentionTokens } = extractMentions(m);
              const mentionSignature = JSON.stringify(msgMentionTokens);
              const recordedItems = ledger.items.filter(
                (i) => i.from.msg_id === m.id,
              );
              const isRecorded = isEdited
                ? recordedItems.some((i) => {
                    if (!i.checked_at || Date.parse(i.checked_at) < editedMs)
                      return false;
                    const itemMentions = extractItemMentions(i);
                    const hasRecordedContext =
                      Boolean(i.from?.quote) ||
                      Array.isArray(i.from?.mentions) ||
                      Array.isArray(i.from?.mention_roles) ||
                      itemMentions.size > 0;
                    if (hasRecordedContext) {
                      return msgMentionTokens.every((tok) =>
                        itemMentions.has(tok),
                      );
                    }
                    return true;
                  })
                : recordedItems.length > 0;
              const wakeId = `human-${safeName(m.id)}`;
              const wakeKey = JSON.stringify([
                role,
                wakeId,
                "장부에 없는 사람 글",
              ]);
              if (isReplied || isAnsweredAfter || isRecorded) {
                delete state.sent[wakeKey];
                delete state.mentions[wakeKey];
                continue;
              }
              if (
                isEdited &&
                state.sent[wakeKey] !== undefined &&
                state.mentions[wakeKey] !== undefined &&
                state.mentions[wakeKey] !== mentionSignature
              ) {
                delete state.sent[wakeKey];
              }
              await wake(
                role,
                wakeId,
                "장부에 없는 사람 글",
                m.body || "(본문 없음)",
                `출처: ${msgChannel}/${m.id}\n기한: (미등록)\n결과: (없음)`,
              );
              state.mentions[wakeKey] = mentionSignature;
            } catch (error) {
              const sourceChannel = m?.channel || channel;
              errors.push(`messenger:${role}:${sourceChannel}:${m?.id}`);
              await wake(
                role,
                `messenger-error-${safeIdPart(`${sourceChannel}-${m?.id}`)}`,
                "감시 실패",
                "메신저 메시지 처리 실패",
                `공급자: ${config.provider?.type || "(미설정)"}\n채널: ${sourceChannel}\n메시지: ${m?.id}\n오류: ${error.message || String(error)}`,
              );
            }
          }
        }
      } catch (error) {
        errors.push(`messenger:${role}`);
        await wake(
          role,
          "messenger-error",
          "감시 실패",
          "메신저 읽기 실패",
          `공급자: ${config.provider?.type || "(미설정)"}\n오류: ${error.message || String(error)}`,
        );
      }
    }
    // Keep only recent dedup entries; timers do not grow the state indefinitely.
    state.sent = Object.fromEntries(
      Object.entries(state.sent).filter(([, at]) => now - at < 24 * 60 * 60000),
    );
    state.mentions = Object.fromEntries(
      Object.entries(state.mentions).filter(([k]) => k in state.sent),
    );
    for (const channel of successfulThisRound) {
      if (!failedThisRound.has(channel)) delete state.channel_failures[channel];
    }
    await atomicJson(stateFile, state);
    return { wakes, errors, warnings };
  });
}
export async function main(args = process.argv.slice(2)) {
  const { opts } = parseArgs(args);
  const root = path.resolve(opts.root || process.cwd());
  const config = JSON.parse(
    await readFile(
      path.resolve(root, opts.config || "config/work-ledger.json"),
      "utf8",
    ),
  );
  const result = await watch({ root, config });
  for (const warning of result.warnings)
    console.warn(`work-ledger-watch warning: ${warning}`);
  console.log(JSON.stringify({ event: "work-ledger-watch", ...result }));
  if (result.errors.length) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(`work-ledger-watch failed: ${error.message}`);
    process.exitCode = 1;
  });
