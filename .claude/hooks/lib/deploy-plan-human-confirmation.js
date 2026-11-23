"use strict";
// Plan gate responsibility: human-confirmation.
const path = require("path");
const { humanTyped } = require("./deploy-human-approval.js");
const { readJson, DISCORD_FILE, ROOT } = require("./deploy-plan-common.js");
const { approvalExpiresAt } = require("./deploy-plan-approval-state.js");
const { discordConfirms } = require("./deploy-plan-discord.js");

/** 저장소 정본 설정에서 봇 열쇠를 읽는다. 실패하면 null. 값은 출력하지 않는다. */
async function loadDiscordToken(repoRoot) {
	try {
		const { pathToFileURL } = require("url");
		const gateCfg = readJson(path.join(repoRoot, "config", "deploy-gate.json")) || {};
		const configuredInstances = Array.isArray(gateCfg?.discord?.instances) ? gateCfg.discord.instances : [];
		const instances = [...new Set([process.env.NAIA_MESSENGER_INSTANCE, ...configuredInstances].filter(Boolean))];
		if (instances.length === 0) return null;
		const helperDir = path.join(repoRoot, ".agents", "skills", "manage-discord-sessions", "helper");
		const { loadMessengerConfig, FileCredentialResolver } = await import(pathToFileURL(path.join(helperDir, "discord-config.mjs")).href);
		const { messengerInstancePaths } = await import(pathToFileURL(path.join(helperDir, "instance-paths.mjs")).href);
		for (const inst of instances) {
			try {
				const paths = messengerInstancePaths(repoRoot, inst);
				const t = new FileCredentialResolver(paths.credentialsDirectory).resolve(loadMessengerConfig(paths.configPath).discord.credentialRef);
				if (t) return t;
			} catch {}
		}
		return null;
	} catch {
		return null;
	}
}

/** 사람 확인: 대화창 입력 또는 승인자 디스코드 글. */
async function humanConfirmed(row, plan, ctx) {
	const { code, createdAt: sinceIso } = row;
	const until = approvalExpiresAt(row, plan);
	const typed = humanTyped(ctx.transcriptPath, code, sinceIso, { sessionId: ctx.sessionId, until });
	if (typed.ok) return { ok: true, at: typed.at, via: "terminal" };
	const refsFile = path.join(ctx.gatesDir, DISCORD_FILE);
	const refs = readJson(refsFile);
	const list = Array.isArray(refs?.approvals) ? refs.approvals.filter((r) => r && r.code === code) : [];
	if (list.length === 0) return { ok: false, why: typed.why };
	const gateCfg = readJson(path.join(ctx.repoRoot || ROOT, "config", "deploy-gate.json")) || {};
	const expectedApproverId = gateCfg?.approver?.discordUserId !== undefined ? gateCfg.approver.discordUserId : ctx.approverId;
	const approverId = ctx.approverId !== undefined ? ctx.approverId : expectedApproverId;
	const token = ctx.discordToken !== undefined ? ctx.discordToken : await loadDiscordToken(ctx.repoRoot);
	const d = await discordConfirms({ code, sinceIso, until, refs: list, approverId, expectedApproverId, token, fetchImpl: ctx.fetchImpl, messages: ctx.messages });
	return d.ok ? d : { ok: false, why: d.why };
}

module.exports = {
	loadDiscordToken,
	humanConfirmed,
};
