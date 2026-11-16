"use strict";
// 시험이 실제 ~/.local/state 를 건드리지 못하게 막는 공통 안전망.
// require 하는 순간 XDG_STATE_HOME 을 빈 임시 폴더로 바꾸고, 시험이 끝날 때 그 폴더에
// 파일이 생겨 있으면(= 시험이 DEPLOY_*_STATE_DIR 를 빠뜨려 기본 경로로 샜다는 뜻) 실패시킨다.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "state-isolation-"));
const xdg = path.join(sandbox, "xdg");
fs.mkdirSync(xdg, { recursive: true });
process.env.XDG_STATE_HOME = xdg;

function listFiles(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listFiles(p));
		else out.push(p);
	}
	return out;
}

function leaked() {
	try {
		return listFiles(xdg);
	} catch {
		return [];
	}
}

process.on("exit", (code) => {
	const files = leaked();
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {}
	if (files.length > 0) {
		process.stderr.write(
			`상태 폴더 env 누락: 시험이 기본 상태 경로에 파일을 썼습니다:\n${files.map((f) => `  ${path.relative(xdg, f)}`).join("\n")}\n`,
		);
		if (code === 0) process.exitCode = 1;
	}
});

module.exports = { sandbox, xdg, leaked };
