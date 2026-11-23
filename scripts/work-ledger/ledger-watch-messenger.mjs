import {createMessengerReads} from './ledger-watch-reads.mjs';
import {messageContext} from './ledger-watch-addressing.mjs';
import {observeHumanQuestions} from './ledger-watch-questions.mjs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {safeName,readLedger,changeLedger,validDate,taskForSource,matchesSource,normalizeMsgId,hasHumanMsgId,isWorkerItem} from './ledger.mjs';
import {configuredHumans,createAdapter} from './messenger.mjs';
import {receiveWork,orderForIntake,relatedSources,relatedTask} from './work-intake.mjs';
import {DEFAULT_MAX_HUMAN_WAKES,MENTION_ONLY_MAX_WAKES,WAKE_COOLDOWN_MS,roleOption,isMentionOnlyBody,loadAnsweredElsewhere,upsertWaitingHuman} from './ledger-watch-state.mjs';

// One factory per watcher round retains only the existing shared read/retry state.
export function createMessengerChecks({root,config,configPath,now,sleep,adapter,state,warnings,errors,wake,oldWakeFiles,receipts,receiptDir,readCache,successfulThisRound,failedThisRound,safeIdPart,roleMaxHumanWakes}) {
    let sharedMessenger = adapter;
    let messengerRoundStarted = false;
    const {readMessages,readReply,readWithRetry,channelFailure} = createMessengerReads({config,sleep,state,errors,warnings,wake,safeIdPart,readCache,failedThisRound});
    return ({role,roleConfig,ledger,intake}) => async () => {
      try {
        if (intake.enabled === true && intake.since !== undefined && !validDate(intake.since))
          throw new Error("intake.since must be a UTC ISO date");
        const directChannels = roleOption(roleConfig, config, "direct_channels", []);
        const channels = [...new Set([
          ...roleOption(roleConfig, config, "channels", []),
          ...directChannels,
        ])];
        const humans = configuredHumans(config, roleConfig);
        const relays = [
          ...new Set([
            ...(roleConfig.relay_ids ?? []),
            ...(config.defaults?.relay_ids ?? []),
            ...(config.relay_ids ?? []),
            ...(roleConfig.relay_bot_ids ?? []),
            ...(config.defaults?.relay_bot_ids ?? []),
            ...(config.relay_bot_ids ?? []),
            ...(roleConfig.relay_user_ids ?? []),
            ...(config.defaults?.relay_user_ids ?? []),
            ...(config.relay_user_ids ?? []),
            ...(roleConfig.webhook_ids ?? []),
            ...(config.defaults?.webhook_ids ?? []),
            ...(config.webhook_ids ?? []),
          ]),
        ];
        // user_ids는 봇 정체성이므로 역할별로만 설정한다(defaults·최상위 상속 금지).
        const identities = roleConfig.user_ids ?? [];
        const roleIds = roleOption(roleConfig, config, "role_ids", []);
        const ownTargets = [...new Set([...identities, ...roleIds])];
        if (channels.length && (!humans.length || !ownTargets.length))
          throw new Error(
            "Messenger watch requires human_ids and role user_ids",
          );
        const maxHumanWakes =
          roleMaxHumanWakes.get(role) ?? DEFAULT_MAX_HUMAN_WAKES;
        const checkUnrecordedHuman =
          roleOption(roleConfig, config, "check_unrecorded_human", true) !== false;
        const elsewhereIds = await loadAnsweredElsewhere({
          root,
          configPath,
          configured: roleOption(roleConfig, config, "answered_elsewhere_file", undefined),
          warnings,
          role,
          now,
        });
        const messenger = sharedMessenger ??= (channels.length ? createAdapter(config.provider) : null);
        if (messenger && !messengerRoundStarted) {
          messenger.beginRound?.();
          messengerRoundStarted = true;
        }
        const maxThreads =
          roleConfig.max_threads ??
          config.defaults?.max_threads ??
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
            // A question's own thread can contain the answer after archiving.
            if (tid) {
              discoveredThreads.add(tid);
              if (m.author_id) threadStarterAuthor.set(tid, m.author_id);
            }
          }
          const guildId =
            roleConfig.guild_id ??
            config.defaults?.guild_id ??
            config.guild_id ??
            config.provider?.guild_id ??
            null;
          if (typeof messenger.threads === "function") {
            try {
              const activeThreads = await readWithRetry(() =>
                messenger.threads(channel, channelMessages, { guildId, all: true, direct: directChannels.includes(channel) }),
              );
              for (const [tid, owner] of activeThreads?.threadOwners ?? [])
                if (owner && !threadStarterAuthor.has(tid)) threadStarterAuthor.set(tid, owner);
              for (const value of activeThreads || []) {
                const tid = typeof value === "string" ? value : value.id;
                if (tid) discoveredThreads.add(tid);
                const owner = typeof value === "string" ? activeThreads.threadOwners?.get(tid) : value.owner_id;
                if (owner && !threadStarterAuthor.has(tid)) threadStarterAuthor.set(tid, owner);
              }
            } catch (error) {
              // Thread discovery failing must not mark a successful channel read failed.
              if (error.status === 429 || /HTTP 429/.test(error.message || ""))
                warnings.push(`messenger:${role}:${channel}:threads: ${error.message || String(error)}`);
              else await channelFailure(role, channel, error, ":threads");
            }
          }
          const candidateThreads = [...discoveredThreads].filter(
            (tid) => tid && !visitedThreads.has(tid),
          );
          const threadLimit = Math.max(0, maxThreads);
          const cursorKey = `${role}:${channel}`;
          const previousThreadCursor = state.thread_cursors[cursorKey];
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
          const readChannelsInScan = new Set([channel]);
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
            readChannelsInScan.add(threadId);
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
          const {isHumanOrRelay,extractMentions,extractItemMentions,addressed,messageTimes} = messageContext({identities,otherRoleUserIds,humans,relays,ownTargets,byId,threadStarterAuthor,directChannels,channel,otherIdentities});
          await observeHumanQuestions({config,roleConfig,messages,messageTimes,identities,byId,extractMentions,directChannels,humans,threadStarterAuthor,otherRoleUserIds,since,now,role,channel,state,receipts,oldWakeFiles,safeIdPart,receiptDir,guildId,channelMessages,messenger,wake});
          if (!checkUnrecordedHuman && intake.enabled !== true) continue;
          const seenInScan = new Set();
          const intakePage = intake.enabled === true ? orderForIntake(messages, channel, discoveredThreads) : null;
          for (const m of intakePage?.ordered ?? messages) {
            seenInScan.add(m.id);
            try {
              if (!isHumanOrRelay(m)) continue;
              const { createdMs, editedMs, isEdited, effectiveMs } = messageTimes(m);
              if (!Number.isFinite(effectiveMs) || effectiveMs > now) continue;
              if (intake.enabled === true && intake.since && createdMs < Date.parse(intake.since)) continue;
              const msgChannel = m.channel || channel;
              if (intake.enabled === true && hasHumanMsgId(m.id) && effectiveMs >= since && !isMentionOnlyBody(m)) {
                // The legacy reminder also recognizes quoted identities. Creating
                // a work item requires an identity from the installation settings.
                if (!humans.includes(m.author_id) && !relays.includes(m.author_id) && !relays.includes(m.webhook_id)) continue;
                const answered = elsewhereIds.get(m.id);
                if (answered !== undefined && answered >= effectiveMs) continue;
                const mentions = extractMentions(m);
                const pointsElsewhere = otherIdentities.some(id => mentions.allMentions.has(id));
                if (pointsElsewhere && !mentions.everyoneOrHere && !ownTargets.some(id => mentions.allMentions.has(id))) continue;
                if (!addressed(m, true)) continue;
                const recorded = taskForSource(ledger.items, msgChannel, m.id);
                const related = recorded ? [] : await relatedSources(m, channel, intakePage, ledger.items,
                  (referenceChannel, id) => readReply(messenger, referenceChannel, id));
                if (!addressed(m, Boolean(recorded || relatedTask(ledger.items, related)))) continue;
                const body = String(m.body || "").trim();
                ledger = await receiveWork({
                  root, roleConfig, ledger, related, revision: effectiveMs, edited: isEdited, now, minutes: intake.defaultDueMinutes ?? 120,
                  title: body.replace(/\s+/g, " ").slice(0, 120) || "(본문 없음)",
                  source: { channel: msgChannel, msg_id: normalizeMsgId(m.id), quote: body.slice(0, 200),
                    mentions: [...mentions.mentions], mention_roles: [...mentions.roleMentions], mention_everyone: mentions.everyoneOrHere },
                });
                continue;
              }
              if (!checkUnrecordedHuman || !addressed(m)) continue;
              // 사람 글은 장부 기록(또는 명시된 answered_elsewhere_file) 없이 답글·후속 글만으로 닫히지 않는다.
              const mThreadId =
                msgChannel !== channel || discoveredThreads.has(msgChannel)
                  ? msgChannel
                  : m.thread_id || m.thread?.id || null;
              let latestThreadHumanMs = -Infinity;
              for (const post of messages) {
                if (post.id === m.id || !isHumanOrRelay(post)) continue;
                const postCh = post.channel || channel;
                const sameThread =
                  (mThreadId !== null && postCh === mThreadId) ||
                  (postCh !== channel && postCh === m.id);
                if (!sameThread) continue;
                const postEffMs = messageTimes(post).effectiveMs;
                if (
                  Number.isFinite(postEffMs) &&
                  postEffMs > effectiveMs &&
                  postEffMs <= now &&
                  postEffMs > latestThreadHumanMs
                ) {
                  latestThreadHumanMs = postEffMs;
                }
              }
              const reopenMs = Math.max(
                isEdited ? editedMs : -Infinity,
                latestThreadHumanMs,
              );
              const msgMentions = extractMentions(m);
              const { tokens: msgMentionTokens } = msgMentions;
              const mentionSignature = JSON.stringify(msgMentionTokens);
              const recordedItems = ledger.items.filter(
                (i) => !isWorkerItem(i) && matchesSource(i.from, msgChannel, m.id),
              );
              const isRecorded = recordedItems.some((i) => {
                if (i.status === "waiting_human") {
                  if (Number.isFinite(reopenMs)) {
                    const handledAt = i.checked_at || i.created_at;
                    if (!handledAt || Date.parse(handledAt) < reopenMs)
                      return false;
                  }
                  if (!isEdited) return true;
                } else if (!isEdited) {
                  return true;
                } else {
                  const handledAt = i.checked_at;
                  if (!handledAt || Date.parse(handledAt) < editedMs)
                    return false;
                }
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
              });
              // 수정 시각이 answered-elsewhere 기록 시각보다 뒤면 수정 재감지가 우선한다.
              const elsewhereAt = elsewhereIds.get(m.id);
              const isRecordedElsewhere =
                elsewhereAt !== undefined && (!isEdited || elsewhereAt >= editedMs);
              const wakeId = `human-${safeName(m.id)}`;
              const wakeKey = JSON.stringify([
                role,
                wakeId,
                "장부에 없는 사람 글",
              ]);
              const clearHumanWakeState = () => {
                delete state.sent[wakeKey];
                delete state.mentions[wakeKey];
                delete state.wake_counts[wakeKey];
                delete state.wake_mention_only[wakeKey];
                delete state.wake_meta[wakeKey];
              };
              const bodyText = String(m.body || "").trim();
              const itemTitle =
                bodyText.replace(/\s+/g, " ").slice(0, 120) || "(본문 없음)";
              if (effectiveMs < since) {
                if (
                  !recordedItems.length &&
                  !isRecordedElsewhere
                ) {
                  ledger = await upsertWaitingHuman({
                    root,
                    role,
                    msgId: m.id,
                    msgChannel,
                    title: itemTitle,
                    quote: bodyText.slice(0, 200),
                    mentions: [...msgMentions.mentions],
                    roleMentions: [...msgMentions.roleMentions],
                    everyoneOrHere: msgMentions.everyoneOrHere,
                    reopenMs: effectiveMs,
                    note: "24시간 감시 창 밖 미등록 글 사람 대기 등록",
                    now,
                  });
                }
                clearHumanWakeState();
                delete state.wake_reset_at[wakeKey];
                continue;
              }
              if (
                isRecorded ||
                isRecordedElsewhere
              ) {
                clearHumanWakeState();
                delete state.wake_reset_at[wakeKey];
                continue;
              }
              const mentionOnly = isMentionOnlyBody(m);
              const wakeLimit = mentionOnly
                ? MENTION_ONLY_MAX_WAKES
                : maxHumanWakes;
              let priorCount = state.wake_counts[wakeKey] ?? 0;
              const mentionsChanged =
                isEdited &&
                state.mentions[wakeKey] !== undefined &&
                state.mentions[wakeKey] !== mentionSignature;
              const promotedToBody =
                isEdited && state.wake_mention_only[wakeKey] === true && !mentionOnly;
              const resetBaseline =
                state.wake_reset_at[wakeKey] ??
                Math.max(createdMs, state.sent[wakeKey] ?? -Infinity);
              const hasNewActivity =
                Number.isFinite(reopenMs) && reopenMs > resetBaseline;
              if (
                mentionsChanged ||
                promotedToBody ||
                (hasNewActivity && priorCount >= wakeLimit)
              ) {
                clearHumanWakeState();
                if (Number.isFinite(reopenMs)) state.wake_reset_at[wakeKey] = reopenMs;
                priorCount = 0;
              } else if (hasNewActivity) {
                state.wake_counts[wakeKey] = 0;
                state.wake_reset_at[wakeKey] = reopenMs;
                priorCount = 0;
              }
              if (priorCount >= wakeLimit) {
                const cooldownElapsed =
                  state.sent[wakeKey] === undefined ||
                  now - state.sent[wakeKey] >= WAKE_COOLDOWN_MS;
                if (cooldownElapsed) {
                  ledger = await upsertWaitingHuman({
                    root,
                    role,
                    msgId: m.id,
                    msgChannel,
                    title: itemTitle,
                    quote: bodyText.slice(0, 200),
                    mentions: [...msgMentions.mentions],
                    roleMentions: [...msgMentions.roleMentions],
                    everyoneOrHere: msgMentions.everyoneOrHere,
                    reopenMs: Number.isFinite(reopenMs) ? reopenMs : effectiveMs,
                    note: `재깨움 ${wakeLimit}회 상한 뒤 사람 대기 등록`,
                    now,
                  });
                  clearHumanWakeState();
                  delete state.wake_reset_at[wakeKey];
                }
                continue;
              }
              const woken = await wake(
                role,
                wakeId,
                "장부에 없는 사람 글",
                m.body || "(본문 없음)",
                `출처: ${msgChannel}/${m.id}\n기한: (미등록)\n결과: (없음)`,
              );
              if (woken) {
                state.mentions[wakeKey] = mentionSignature;
                state.wake_counts[wakeKey] = priorCount + 1;
                if (Number.isFinite(reopenMs)) state.wake_reset_at[wakeKey] = reopenMs;
                if (mentionOnly) state.wake_mention_only[wakeKey] = true;
                else delete state.wake_mention_only[wakeKey];
                state.wake_meta[wakeKey] = {
                  role,
                  channel: msgChannel,
                  scan_channel: channel,
                  msg_id: m.id,
                  title: itemTitle,
                  quote: bodyText.slice(0, 200),
                  mentions: [...msgMentions.mentions],
                  mention_roles: [...msgMentions.roleMentions],
                  mention_everyone: msgMentions.everyoneOrHere,
                  effective_ms: effectiveMs,
                };
              }
            } catch (error) {
              const sourceChannel = m?.channel || channel;
              if (intake.enabled === true && sourceChannel !== channel) {
                if (previousThreadCursor === undefined) delete state.thread_cursors[cursorKey];
                else state.thread_cursors[cursorKey] = previousThreadCursor;
              }
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
          if (!checkUnrecordedHuman) continue;
          // 24시간 감시 창을 벗어나 API 응답에서 빠진 미등록 사람 글을 버리기 전에 waiting_human으로 등록한다.
          for (const [wk, meta] of Object.entries(state.wake_meta)) {
            if (meta.role !== role || meta.scan_channel !== channel) continue;
            if (seenInScan.has(meta.msg_id)) continue;
            if (!readChannelsInScan.has(meta.channel) && meta.channel !== channel) continue;
            if (!(meta.effective_ms < since)) continue;
            const recorded = taskForSource(ledger.items, meta.channel, meta.msg_id);
            const metaElsewhereAt = elsewhereIds.get(meta.msg_id);
            const metaElsewhere =
              metaElsewhereAt !== undefined && metaElsewhereAt >= meta.effective_ms;
            const beforeIntake = intake.enabled === true && intake.since && meta.effective_ms < Date.parse(intake.since);
            if (!recorded && !metaElsewhere && !beforeIntake) {
              ledger = await upsertWaitingHuman({
                root,
                role,
                msgId: meta.msg_id,
                msgChannel: meta.channel,
                title: meta.title || "(본문 없음)",
                quote: meta.quote || "",
                mentions: Array.isArray(meta.mentions) ? meta.mentions : [],
                roleMentions: Array.isArray(meta.mention_roles)
                  ? meta.mention_roles
                  : [],
                everyoneOrHere: meta.mention_everyone === true,
                reopenMs: meta.effective_ms,
                note: "24시간 감시 창 밖 미등록 글 사람 대기 등록",
                now,
              });
            }
            delete state.sent[wk];
            delete state.mentions[wk];
            delete state.wake_counts[wk];
            delete state.wake_mention_only[wk];
            delete state.wake_reset_at[wk];
            delete state.wake_meta[wk];
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
    };
}
