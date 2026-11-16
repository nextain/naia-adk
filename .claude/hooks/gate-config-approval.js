#!/usr/bin/env node
"use strict";

const path = require("path");
const { GATE_CONFIG_FILES, snapshotGateConfig, approvalCode, approvedGateConfig } = require("./lib/gate-config-pin.js");
const { resolveReviewModels, canonicalReviewModels, orderedReviewersForConfig, ROTATION } = require("./lib/deploy-plan.js");

async function main() {
	const args = process.argv.slice(2);
	const root = path.resolve(args[0] && !args[0].startsWith("--") ? args.shift() : process.cwd());
	const options = {};
	while (args.length) {
		const flag = args.shift();
		if (!["--approved-root", "--approver-id", "--channel-id", "--message-id"].includes(flag) || !args.length) throw new Error("사용법: gate-config-approval.js [root] [--approved-root root --approver-id id --channel-id id --message-id id]");
		options[flag] = args.shift();
	}
	const snapshot = snapshotGateConfig(root);
	if (!snapshot) throw new Error("관문 설정 파일을 읽을 수 없습니다: " + GATE_CONFIG_FILES.join(", "));
	const config = JSON.parse(snapshot.files[GATE_CONFIG_FILES[0]].toString("utf8"));
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("관문 설정은 객체여야 합니다");
	const models = canonicalReviewModels(resolveReviewModels(config));
	const formatModel = (m) => [m.id, m.model, m.effort, m.runner].map(JSON.stringify).join(" / ");
	console.log(`관문 설정 승인 요청\nSHA-256: ${snapshot.hash}\n승인 코드: ${approvalCode(snapshot.hash)}`);
	console.log("풀린 리뷰어 전체 목록 (id / 모델 / 강도 / 실행기):");
	for (const m of models) console.log(formatModel(m));
	console.log("실제 불릴 리뷰어 차례 (이 설정 승인 시, 작성자별, 현재 시각):");
	for (const author of ROTATION) {
		try { console.log(`${author}: ${orderedReviewersForConfig(author, config).slice(0, 2).join(" → ")}`); }
		catch (error) { console.log(`${author}: ${error.message}`); }
	}
	if (Object.keys(options).length) {
		if (!["--approved-root", "--approver-id", "--channel-id", "--message-id"].every((key) => options[key]) || !process.env.DISCORD_BOT_TOKEN) throw new Error("승인 판 비교에는 네 옵션과 DISCORD_BOT_TOKEN이 모두 필요합니다");
		const approvedRoot = path.resolve(options["--approved-root"]);
		const before = snapshotGateConfig(approvedRoot);
		const code = before && approvalCode(before.hash);
		const approved = before && await approvedGateConfig({ root: approvedRoot, approverId: options["--approver-id"], token: process.env.DISCORD_BOT_TOKEN, refs: [{ code, channelId: options["--channel-id"], messageId: options["--message-id"] }] });
		if (!approved || approved.hash !== before.hash) throw new Error("비교할 승인 판을 확인하지 못했습니다");
		const old = new Map(canonicalReviewModels(resolveReviewModels(approved.config)).map((m) => [m.id, m]));
		const next = new Map(models.map((m) => [m.id, m]));
		console.log(`승인 판 ${approved.hash} 대비 리뷰어 차이:`);
		let changed = false;
		for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
			const a = old.get(id), b = next.get(id);
			if (JSON.stringify(a) === JSON.stringify(b)) continue;
			changed = true;
			if (a) console.log(`- ${formatModel(a)}`);
			if (b) console.log(`+ ${formatModel(b)}`);
		}
		if (!changed) console.log("(리뷰어 변경 없음)");
		for (const name of GATE_CONFIG_FILES) {
			const a = before.files[name].toString("utf8").split("\n");
			const b = snapshot.files[name].toString("utf8").split("\n");
			let start = 0, ae = a.length, be = b.length;
			while (start < ae && start < be && a[start] === b[start]) start++;
			while (ae > start && be > start && a[ae - 1] === b[be - 1]) { ae--; be--; }
			console.log(`승인 판 대비 설정 줄: ${name}`);
			if (start === ae && start === be) console.log("(변경 없음)");
			for (const line of a.slice(start, ae)) console.log(`- ${line}`);
			for (const line of b.slice(start, be)) console.log(`+ ${line}`);
		}
	}
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
