"use strict";
/**
 * agents-rules.json keeps one-line rules; full sections live in the file named
 * by its `detail.file` under the same key paths. Code that reads rule sections
 * reads the deep merge of both. A named detail file that is missing or
 * malformed throws, so callers that fail closed keep failing closed.
 */
const fs = require("fs");
const path = require("path");

const RULES_RELATIVE = path.join(".agents", "context", "agents-rules.json");

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, extra, at = "") {
	const out = { ...base };
	for (const [key, value] of Object.entries(extra)) {
		const where = at ? `${at}.${key}` : key;
		if (isRecord(out[key]) && isRecord(value)) out[key] = deepMerge(out[key], value, where);
		else if (Object.hasOwn(out, key)) throw new Error(`agents-rules detail collides with core at ${where}`);
		else out[key] = value;
	}
	return out;
}

/** Merge a parsed core rules object with its detail file, resolved from `root`. */
function mergeDetail(core, root) {
	if (!isRecord(core) || !isRecord(core.detail) || typeof core.detail.file !== "string") return core;
	const detail = JSON.parse(fs.readFileSync(path.join(root, core.detail.file), "utf8"));
	if (!isRecord(detail)) throw new Error(`${core.detail.file} is not a JSON object`);
	const { _about, ...sections } = detail;
	return deepMerge(core, sections);
}

/** Read `<root>/.agents/context/agents-rules.json` merged with its detail file. */
function readAgentsRules(root) {
	const core = JSON.parse(fs.readFileSync(path.join(root, RULES_RELATIVE), "utf8"));
	return mergeDetail(core, root);
}

module.exports = { readAgentsRules, mergeDetail, deepMerge, RULES_RELATIVE };
