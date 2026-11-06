"use strict";
/**
 * 운영 배포 승인은 사람이 대화창에 직접 친 1회용 코드로만 받는다.
 *
 * 예전 방식(.claude/deploy/approvals.json)은 AI가 쓸 수 있는 파일이라 AI가 스스로
 * 승인할 수 있었다. 여기서는 게이트가 명령 하나마다 코드를 만들고, 대화 기록에서
 * 사람이 쓴 메시지(도구 결과·시스템 알림·백그라운드 작업 알림이 아닌 것)에 그
 * 코드가 있을 때만 그 명령을 한 번 통과시킨다. AI는 코드를 볼 수 있지만 사람
 * 메시지를 만들 수는 없다.
 *
 * 코드는 명령 전문(공백 정규화)에 묶인다. 이미지·대상이 바뀌면 새 코드가 필요하다.
 * 상태 파일은 저장소 밖(~/.local/state)에 둔다.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHALLENGE_TTL_MS = 2 * 60 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function statePath(env = process.env) {
	const base = env.DEPLOY_APPROVAL_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "naia-harness");
	return path.join(base, "deploy-challenges.json");
}

function load(file) {
	try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(d.challenges) ? d : { challenges: [] }; } catch { return { challenges: [] }; }
}

function save(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function commandHash(command) {
	return crypto.createHash("sha256").update(String(command).replace(/\s+/g, " ").trim()).digest("hex");
}

function normalizePrefix(prefix) {
	return (prefix === "RUN" || prefix === "REVIEW") ? prefix : "DEPLOY";
}

function newCode(prefix = "DEPLOY") {
	const validPrefix = normalizePrefix(prefix);
	const bytes = crypto.randomBytes(6);
	let s = "";
	for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
	return `${validPrefix}-${s}`;
}

function textOfHumanEntry(entry) {
	if (!entry || typeof entry !== "object") return [];
	if (entry.type === "attachment") {
		const a = entry.attachment || {};
		if (a.type === "queued_command" && a.origin && a.origin.kind === "human" && typeof a.prompt === "string") return [a.prompt];
		return [];
	}
	if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return [];
	if (entry.origin && entry.origin.kind && entry.origin.kind !== "human") return [];
	const message = entry.message || {};
	if (message.role !== "user") return [];
	const content = message.content;
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	if (blocks.some((b) => b && b.type === "tool_result")) return [];
	// 시스템 알림·작업 알림은 '<'로 시작하는 태그 블록이다. AI가 설명문을 넣을 수 있으므로 뺀다.
	return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string" && !b.text.trim().startsWith("<")).map((b) => b.text);
}

/** 대화 기록에서 since 이후 사람이 쓴 메시지에 code 가 있는가. */
function humanTyped(transcriptPath, code, sinceIso) {
	if (!transcriptPath) return { ok: false, why: "no-transcript" };
	let raw;
	try { raw = fs.readFileSync(transcriptPath, "utf8"); } catch { return { ok: false, why: "no-transcript" }; }
	const since = Date.parse(sinceIso) || 0;
	for (const line of raw.split("\n")) {
		if (!line.includes(code)) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		const at = Date.parse(entry.timestamp || "") || 0;
		if (at < since) continue;
		if (textOfHumanEntry(entry).some((t) => t.includes(code))) return { ok: true, at: entry.timestamp };
	}
	return { ok: false, why: "not-typed" };
}

/**
 * 명령에 대한 승인을 확인한다.
 * 돌려주는 값: { approved: true, code } 또는 { approved: false, code, services, reason }
 */
function checkApproval({ command, services, sessionId, transcriptPath, env = process.env, now = Date.now(), prefix = "DEPLOY" }) {
	const validPrefix = normalizePrefix(prefix);
	const file = statePath(env);
	const data = load(file);
	data.challenges = data.challenges.filter((c) => now - Date.parse(c.createdAt) < CHALLENGE_TTL_MS || c.usedAt);
	data.challenges = data.challenges.filter((c) => now - Date.parse(c.createdAt) < 7 * 24 * 60 * 60 * 1000);
	const hash = commandHash(command);
	let challenge = data.challenges.find((c) => {
		const cPrefix = c.prefix || "DEPLOY";
		return c.hash === hash && c.sessionId === sessionId && cPrefix === validPrefix && !c.usedAt && now - Date.parse(c.createdAt) < CHALLENGE_TTL_MS;
	});
	if (!challenge) {
		challenge = { code: newCode(validPrefix), prefix: validPrefix, hash, sessionId, services, createdAt: new Date(now).toISOString() };
		data.challenges.push(challenge);
		save(file, data);
		return { approved: false, code: challenge.code, services, reason: "issued" };
	}
	const typed = humanTyped(transcriptPath, challenge.code, challenge.createdAt);
	if (!typed.ok) return { approved: false, code: challenge.code, services, reason: typed.why };
	challenge.usedAt = new Date(now).toISOString();
	challenge.approvedMessageAt = typed.at;
	save(file, data);
	return { approved: true, code: challenge.code, services };
}

module.exports = { checkApproval, humanTyped, textOfHumanEntry, commandHash, statePath, CHALLENGE_TTL_MS };
