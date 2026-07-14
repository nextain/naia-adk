#!/usr/bin/env node
/** Deterministically validate the tracked RCI requirement/review trace. */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requirementsDir = path.join(root, ".agents", "requirements");
const stages = ["planning", "development", "test", "integration"];
const expectedIds = Array.from({ length: 11 }, (_, index) => `RCI-${String(index + 1).padStart(3, "0")}`);
const expectedDirectives = Array.from({ length: 7 }, (_, index) => `USR-${String(index + 1).padStart(3, "0")}`);

function fail(message) {
	throw new Error(`request-contract requirement trace: ${message}`);
}

function scalar(text, key) {
	const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
	if (!match) fail(`missing ${key}`);
	return match[1].replace(/^"|"$/g, "");
}

function block(text, start, end) {
	const match = text.match(new RegExp(`^${start}:\\s*\\n([\\s\\S]*?)(?=^${end}:\\s*(?:\\n|$))`, "m"));
	if (!match) fail(`missing ${start} block`);
	return match[1];
}

function validateData(files, indexText, exists = (relativePath) => fs.existsSync(path.join(root, relativePath))) {
	const ids = [...files.keys()].sort();
	if (ids.join(",") !== expectedIds.join(",")) fail(`expected ${expectedIds.join(",")}; got ${ids.join(",")}`);

	const directiveUnion = new Set();
	for (const id of expectedIds) {
		const text = files.get(id);
		if (scalar(text, "id") !== id) fail(`${id}: filename/id mismatch`);
		if (scalar(text, "product") !== "naia-adk-request-contract") fail(`${id}: wrong product`);
		if (scalar(text, "status") !== "verified") fail(`${id}: status is not verified`);
		if (scalar(text, "source") !== "human") fail(`${id}: source is not human`);

		const directiveMatch = text.match(/^source_directives:\s*\[([^\]]+)\]\s*$/m);
		if (!directiveMatch) fail(`${id}: source_directives missing or malformed`);
		const directives = directiveMatch[1].split(",").map((item) => item.trim());
		if (directives.length === 0 || directives.some((item) => !expectedDirectives.includes(item))) fail(`${id}: invalid source_directives`);
		for (const directive of directives) directiveUnion.add(directive);

		const acceptance = block(text, "acceptance_criteria", "trace");
		if ((acceptance.match(/^\s{2}-\s+.+$/gm) || []).length < 2) fail(`${id}: fewer than two acceptance criteria`);

		const trace = text.match(/^trace:\s*\n([\s\S]*?)(?=^decisions:\s*)/m)?.[1];
		if (!trace) fail(`${id}: trace block missing`);
		for (const section of ["code", "tests"]) {
			const sectionMatch = trace.match(new RegExp(`^  ${section}:\\s*\\n([\\s\\S]*?)(?=^  (?:code|tests|reviews):|\\z)`, "m"));
			if (!sectionMatch) fail(`${id}: trace.${section} missing`);
			const paths = [...sectionMatch[1].matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
			if (paths.length === 0) fail(`${id}: trace.${section} has no paths`);
			for (const relativePath of paths) if (!exists(relativePath)) fail(`${id}: trace path does not exist: ${relativePath}`);
		}

		const reviews = trace.match(/^  reviews:\s*\{([^}]+)\}\s*$/m)?.[1];
		if (!reviews) fail(`${id}: trace.reviews missing or malformed`);
		for (const stage of stages) {
			const value = reviews.match(new RegExp(`(?:^|,)\\s*${stage}:\\s*("[^"]+"|[^,]+)`))?.[1]?.trim();
			if (!value || value === "null" || value === '""') fail(`${id}: ${stage} review evidence missing`);
		}

		const title = scalar(text, "title");
		const escapedId = id.replace("-", "\\-");
		const indexMatches = [...indexText.matchAll(new RegExp(`^\\s+- \\{ id: ${escapedId}, title: "([^"]+)", status: ([^ }]+) \\}\\s*$`, "gm"))];
		if (indexMatches.length !== 1) fail(`${id}: expected exactly one index entry`);
		if (indexMatches[0][1] !== title || indexMatches[0][2] !== "verified") fail(`${id}: index title/status drift`);
	}

	if ([...directiveUnion].sort().join(",") !== expectedDirectives.join(",")) fail("USR-001 through USR-007 are not all traced");
	if (!/product:\s*naia-adk-request-contract[\s\S]*?req_count:\s*11\b/.test(indexText)) fail("request-contract index count is not 11");
}

function expectFailure(label, files, indexText, exists) {
	try {
		validateData(files, indexText, exists);
	} catch {
		return;
	}
	fail(`negative self-test passed unexpectedly: ${label}`);
}

const files = new Map();
for (const filename of fs.readdirSync(requirementsDir).filter((name) => /^RCI-\d{3}-.+\.yaml$/.test(name)).sort()) {
	const text = fs.readFileSync(path.join(requirementsDir, filename), "utf8");
	files.set(scalar(text, "id"), text);
}
const indexText = fs.readFileSync(path.join(requirementsDir, "_index.yaml"), "utf8");
validateData(files, indexText);

const first = expectedIds[0];
const withMutation = (replacement) => new Map([...files].map(([id, text]) => [id, id === first ? replacement(text) : text]));
expectFailure("status drift", withMutation((text) => text.replace("status: verified", "status: active")), indexText);
expectFailure("missing planning review", withMutation((text) => text.replace(/planning:\s*"[^"]+"/, "planning: null")), indexText);
expectFailure("missing trace path", withMutation((text) => text.replace('.agents/hooks/core/request-contract.js', 'missing/request-contract.js')), indexText);
expectFailure("missing index entry", files, indexText.replace(/^\s+- \{ id: RCI-001,.*\n/m, ""));

process.stdout.write("request-contract requirement trace: PASS\n");
