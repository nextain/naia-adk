import {writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function observeHumanQuestions({config,roleConfig,messages,messageTimes,identities,byId,extractMentions,directChannels,humans,threadStarterAuthor,otherRoleUserIds,since,now,role,channel,state,receipts,oldWakeFiles,safeIdPart,receiptDir,guildId,channelMessages,messenger,wake}) {
          const humanWait = {
            ...(config.defaults?.human_wait ?? {}),
            ...(config.human_wait ?? {}),
            ...(roleConfig.human_wait ?? {}),
          };
          const cleanBody = (body) => (body || "")
            .replace(/```[\s\S]*?(?:```|$)/g, "")
            .replace(/~~~[\s\S]*?(?:~~~|$)/g, "")
            .replace(/^\s*>.*$/gm, "").replace(/`[^`]*`/g, "");
          const questionMatchers = (humanWait.question_patterns ?? [
            "[?？](?:\\s|$)", "될까요", "(?:골라\\s*주시면|고르시면)",
            "(?:답변|응답|승인)을?\\s*기다리겠습니다",
            "(?:시각|시간|선택|승인|결정).*(?:알려|말씀)\\s*주시면",
          ]).map((pattern) => new RegExp(pattern, "u"));
          const groups = [];
          for (const post of [...messages].sort((a, b) => messageTimes(a).createdMs - messageTimes(b).createdMs)) {
            if (!identities.includes(post.author_id)) continue;
            const previous = groups.at(-1);
            if (previous && previous.author_id === post.author_id && previous.channel === post.channel &&
                (previous.parts.at(-1).body || "").length >= 1900 &&
                messageTimes(post).createdMs - messageTimes(previous.parts.at(-1)).createdMs <= 120000 &&
                // Split sends are contiguous: an intervening participant starts a new utterance.
                !messages.some((m) => m.channel === post.channel && m.author_id !== post.author_id &&
                  messageTimes(m).createdMs > messageTimes(previous.parts.at(-1)).createdMs &&
                  messageTimes(m).createdMs < messageTimes(post).createdMs)) previous.parts.push(post);
            else groups.push({ ...post, parts: [post] });
          }
          for (const question of groups) {
            const body = question.parts.map((part) => cleanBody(part.body)).join("\n");
            const parentAuthor = question.parts.map((part) => part.reply_to_author_id ||
              part.reply_to?.author_id || part.reply_to?.author?.id ||
              byId.get(part.reply_to_id)?.author_id).find(Boolean);
            const mentioned = extractMentions({ body }).mentions;
            const implicit = directChannels.includes(question.channel) ||
              humans.includes(threadStarterAuthor.get(question.channel));
            const targets = humans.filter((id) => mentioned.has(id) || id === parentAuthor ||
              (implicit && (!threadStarterAuthor.get(question.channel) || threadStarterAuthor.get(question.channel) === id)));
            if (!targets.length) continue;
            if (/[?？][ \t]*(?:네|아니요)[,，]?[ \t]+[^\r\n]*(?:시작했|진행했|완료했)/u.test(body)) continue;
            // Keep a standalone addressee attached to its following question.
            // A blank line starts a new scope, so a human report cannot lend its
            // recipient to a separate paragraph directed at another bot.
            const isQuestion = body.split(/\n\s*\n/).some((block) => {
              let scopedMentions = new Set();
              return block.split(/\n+|(?<=[.!?？])\s+/).some((sentence) => {
                const mentions = extractMentions({ body: sentence }).mentions;
                for (const id of mentions) scopedMentions.add(id);
                if (!questionMatchers.some((pattern) => pattern.test(sentence))) return false;
                if ([...scopedMentions].some((id) => otherRoleUserIds.includes(id)) &&
                    !targets.some((id) => scopedMentions.has(id))) return false;
                if (/(?:문제|이상|추가로? 필요).*(?:알려|말씀).*주시면.*(?:수정|반영)/u.test(sentence)) return false;
                return true;
              });
            });
            if (!isQuestion) continue;
            const questionAt = messageTimes(question).createdMs;
            if (!Number.isFinite(questionAt) || questionAt < since || questionAt > now ||
                now - questionAt < (humanWait.after_min ?? 15) * 60000) continue;
            const questionChannel = question.channel || channel;
            const ids = question.parts.map((part) => part.id);
            const continued = messages.some((post) => targets.includes(post.author_id) &&
              ((post.channel || channel) === questionChannel || ids.includes(post.reply_to_id) ||
                ids.includes(post.channel) || question.parts.some((part) =>
                  post.channel === part.thread_id || post.channel === part.thread?.id)) &&
              messageTimes(post).createdMs > questionAt && messageTimes(post).createdMs <= now);
            const key = JSON.stringify([role, questionChannel, question.id]);
            const receipt = Buffer.from(key).toString("base64url") + ".json";
            const wasSent = question.parts.some((part) => {
              const partKey = JSON.stringify([role, questionChannel, part.id]);
              const partReceipt = Buffer.from(partKey).toString("base64url") + ".json";
              return state.human_wait_sent[partKey] !== undefined || receipts.has(partReceipt) ||
                oldWakeFiles.some((name) => name.includes(`-ledger-human-wait-${safeIdPart(part.id)}-`) && name.endsWith(`-route-${role}.md`));
            });
            if (wasSent && !receipts.has(receipt)) {
              await writeFile(path.join(receiptDir, receipt), JSON.stringify({ key, at: now }), { mode: 0o600 });
              receipts.add(receipt);
            }
            if (continued || wasSent || receipts.has(receipt)) continue;
            const guild = question.guild_id || guildId || channelMessages.guildId || "@me";
            const url = question.url || messenger.messageUrl?.(questionChannel, question.id) ||
              `https://discord.com/channels/${guild}/${questionChannel}/${question.id}`;
            const firstLine = body.split(/\r?\n/).find((line) => line.trim()) || "(질문)";
            await wake(
              role, `human-wait-${safeIdPart(question.id)}`,
              "사람 답 기다림", firstLine,
              `채널: ${questionChannel}\n글: ${url}\n질문: ${firstLine}\n1) 이 일에 이미 받은 지시가 있는지 그 채널 앞 글을 다시 읽음\n2) 바깥 발송·운영 변경·돈이 아니고 되돌릴 수 있으면 지금 진행하고 그 채널에 알림\n3) 정말 사람 승인이 필요한 일이면 #업무-요청 에 [분류] 양식으로 옮김\n사람 답을 기다려야 하면 대기 카드를 waiting 으로 남기고 recheck_at 과 request_ref 를 채우세요.`,
            );
            for (const part of question.parts) {
              const partKey = JSON.stringify([role, questionChannel, part.id]);
              const partReceipt = Buffer.from(partKey).toString("base64url") + ".json";
              await writeFile(path.join(receiptDir, partReceipt), JSON.stringify({ key: partKey, at: now }), { mode: 0o600 });
              receipts.add(partReceipt);
              state.human_wait_sent[partKey] = now;
            }
          }
}
