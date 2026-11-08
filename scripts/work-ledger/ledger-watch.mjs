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
export async function watch({ root, config, adapter, now = Date.now() }) {
  const wakeDir = path.join(root, ".agents/work/l4/wake");
  const stateFile = path.join(root, ".agents/work/ledger", "watch-state.json");
  await mkdir(wakeDir, { recursive: true });
  return withLock(stateFile, async () => {
    let state = { version: 1, sent: {} };
    let stateError;
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        state.version !== 1 ||
        !state.sent ||
        typeof state.sent !== "object" ||
        Array.isArray(state.sent) ||
        Object.values(state.sent).some((v) => !Number.isFinite(v))
      )
        throw new Error("Invalid watch state");
    } catch (error) {
      if (error.code !== "ENOENT") {
        stateError = "감시 상태 파일 읽기 실패";
        state = { version: 1, sent: {} };
      }
    }
    const wakes = [];
    const errors = [];
    let sequence = 0;
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
        const humans = roleConfig.human_ids ?? config.human_ids ?? [];
        const identities = roleConfig.user_ids ?? [];
        if (channels.length && (!humans.length || !identities.length))
          throw new Error(
            "Messenger watch requires human_ids and role user_ids",
          );
        const messenger =
          adapter || (channels.length ? createAdapter(config.provider) : null);
        for (const channel of channels) {
          const since = now - 24 * 60 * 60000;
          let messages;
          try {
            messages = await messenger.messages(channel, since);
          } catch (error) {
            errors.push(`messenger:${role}:${channel}`);
            await wake(
              role,
              `messenger-error-${safeName(channel)}`,
              "감시 실패",
              "메신저 읽기 실패",
              `공급자: ${config.provider?.type || "(미설정)"}\n채널: ${channel}\n오류: ${error.message || String(error)}`,
            );
            continue;
          }
          const byId = new Map(messages.map((m) => [m.id, m]));
          const otherIdentities = config.roles
            .filter((r) => r.role !== role)
            .flatMap((r) => r.user_ids ?? [])
            .filter((id) => !identities.includes(id));
          function addressed(m) {
            const mentions = new Set((m.mentions ?? []).map((value) =>
              typeof value === "string" ? value : value.id,
            ));
            for (const match of (m.body || "").matchAll(/<@!?(\w[\w-]*)>/g))
              mentions.add(match[1]);
            const ownMention = identities.some((id) => mentions.has(id));
            const parentAuthor = m.reply_to_author_id || m.reply_to?.author_id ||
              m.reply_to?.author?.id || byId.get(m.reply_to_id)?.author_id;
            if (
              ownMention ||
              identities.includes(parentAuthor) ||
              m.mention_everyone === true ||
              /@(?:everyone|here)\b/.test(m.body || "") ||
              (roleConfig.direct_channels ?? []).includes(channel)
            )
              return true;
            if (otherIdentities.some((id) => mentions.has(id))) return false;
            return false;
          }
          const replied = new Set(
            messages
              .filter((m) => identities.includes(m.author_id) && m.reply_to_id)
              .map((m) => m.reply_to_id),
          );
          const recorded = new Set(ledger.items.map((i) => i.from.msg_id));
          for (const m of messages)
            if (
              humans.includes(m.author_id) &&
              addressed(m) &&
              !(roleConfig.answered_by_any_role_post_after === true &&
                messages.some((post) =>
                  identities.includes(post.author_id) &&
                  Date.parse(post.created_at) > Date.parse(m.created_at) &&
                  Date.parse(post.created_at) <= now,
                )) &&
              Date.parse(m.created_at) >= since &&
              Date.parse(m.created_at) <= now &&
              !recorded.has(m.id) &&
              !replied.has(m.id)
            )
              await wake(
                role,
                `human-${safeName(m.id)}`,
                "장부에 없는 사람 글",
                m.body || "(본문 없음)",
                `출처: ${channel}/${m.id}\n기한: (미등록)\n결과: (없음)`,
              );
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
    await atomicJson(stateFile, state);
    return { wakes, errors };
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
