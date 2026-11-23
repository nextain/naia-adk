// Existing readiness io responsibility; behavior is owned by the public facade.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const sameCommit = (a, b) => typeof a === "string" && typeof b === "string" && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function sha256File(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveIn(root, p) {
	if (typeof p !== "string" || !p) throw new Error(`경로 칸이 문자열 경로가 아님: ${JSON.stringify(p)}`.slice(0, 160));
	return path.isAbsolute(p) ? p : path.join(root, p);
}

module.exports = { sameCommit, readJson, sha256File, resolveIn };
