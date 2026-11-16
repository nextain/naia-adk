#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const { GATE_CONFIG_FILES, snapshotGateConfig, approvalCode } = require("./lib/gate-config-pin.js");

const root = path.resolve(process.argv[2] || process.cwd());
const snapshot = snapshotGateConfig(root);
if (!snapshot) {
	console.error("관문 설정 파일을 읽을 수 없습니다: " + GATE_CONFIG_FILES.join(", "));
	process.exit(1);
}
console.log(`관문 설정 승인 요청\nSHA-256: ${snapshot.hash}\n승인 코드: ${approvalCode(snapshot.hash)}\n바뀐 줄 (Git HEAD 대비):`);
for (const name of GATE_CONFIG_FILES) {
	let before;
	try { before = execFileSync("git", ["show", `HEAD:${name}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
	catch { before = ""; }
	const after = snapshot.files[name].toString("utf8");
	const oldLines = before ? before.split("\n") : [];
	const newLines = after ? after.split("\n") : [];
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.length, newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
	console.log(`--- ${name}`);
	if (oldEnd === start && newEnd === start) console.log("(변경 없음)");
	for (const line of oldLines.slice(start, oldEnd)) console.log(`- ${line}`);
	for (const line of newLines.slice(start, newEnd)) console.log(`+ ${line}`);
}
