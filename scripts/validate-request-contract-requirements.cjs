#!/usr/bin/env node
/**
 * Deterministically validate the tracked RCI requirement and review trace.
 *
 * The review check is not satisfied by a plausible-looking string in the requirement
 * file. Each stage must name receipts in `.agents/requirements/reviews/`, each receipt
 * must carry a Clean verdict from enough distinct reviewers, and each receipt must be
 * bound to the review-scope digest of the tree it actually judged. A verdict recorded
 * for one tree therefore cannot be spent on a different one.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const scope = require("./request-contract-review-scope.cjs");
const transcript = require("./request-contract-review-transcript.cjs");

const { root, requirementsDir, receiptsDir } = scope;
const stages = ["planning", "development", "test", "integration"];
/** review-pass SKILL.md "Reviewers" line per stage: planning 2, development 3, test 2, integration 3. */
const stageMinimumReviewers = { planning: 2, development: 3, test: 2, integration: 3 };
const requiredCleanRounds = 2;
const expectedIds = Array.from({ length: 11 }, (_, index) => `RCI-${String(index + 1).padStart(3, "0")}`);
const expectedDirectives = Array.from({ length: 7 }, (_, index) => `USR-${String(index + 1).padStart(3, "0")}`);

function fail(message) {
	throw new Error(`request-contract requirement trace: ${message}`);
}

/** Split a document on its top-level (column-zero) keys so key order never matters. */
function topLevelBlocks(text, label) {
	const blocks = new Map();
	const lines = text.split(/\r?\n/);
	let current = null;
	for (const line of lines) {
		if (/^\s*(#.*)?$/.test(line)) {
			if (current) current.body.push(line);
			continue;
		}
		const header = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
		if (header) {
			if (blocks.has(header[1])) fail(`${label}: duplicate top-level key: ${header[1]}`);
			current = { inline: header[2].trim(), body: [] };
			blocks.set(header[1], current);
			continue;
		}
		if (!current) fail(`${label}: content before any top-level key`);
		current.body.push(line);
	}
	return blocks;
}

function unquote(value) {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^"(.*)"$/s) || trimmed.match(/^'(.*)'$/s);
	return quoted ? quoted[1] : trimmed;
}

function scalarOf(blocks, key, label) {
	const block = blocks.get(key);
	if (!block || block.inline === "") fail(`${label}: missing ${key}`);
	return unquote(block.inline);
}

function bodyOf(blocks, key, label) {
	const block = blocks.get(key);
	if (!block) fail(`${label}: missing ${key} block`);
	return block.body.join("\n");
}

/** Reviews must be a mapping of stage -> list of receipt ids. */
function parseReviews(traceBody, label) {
	const line = traceBody.split(/\r?\n/).find((entry) => /^ {2}reviews:/.test(entry));
	if (!line) fail(`${label}: trace.reviews missing`);
	const inline = line.replace(/^ {2}reviews:\s*/, "").trim();
	const mapping = inline.match(/^\{(.*)\}$/s);
	if (!mapping) fail(`${label}: trace.reviews must be an inline mapping`);
	const reviews = {};
	for (const stage of stages) {
		const entry = mapping[1].match(new RegExp(`(?:^|,)\\s*${stage}:\\s*\\[([^\\]]*)\\]`));
		if (!entry) fail(`${label}: ${stage} review evidence missing or not a receipt list`);
		const ids = entry[1]
			.split(",")
			.map((item) => unquote(item))
			.filter((item) => item !== "");
		if (ids.some((id) => !/^[A-Za-z0-9._-]+$/.test(id))) fail(`${label}: ${stage} names a malformed receipt id`);
		if (new Set(ids).size !== ids.length) fail(`${label}: ${stage} repeats a receipt id`);
		reviews[stage] = ids;
	}
	return reviews;
}

function parseTracePaths(traceBody, section, label) {
	const lines = traceBody.split(/\r?\n/);
	const start = lines.findIndex((line) => new RegExp(`^ {2}${section}:\\s*$`).test(line));
	if (start === -1) fail(`${label}: trace.${section} missing`);
	const entries = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(#.*)?$/.test(line)) continue;
		if (/^ {2}[^\s#]/.test(line)) break;
		if (!/^\s*-\s/.test(line)) continue;
		const pathMatch = line.match(/path:\s*("[^"]+"|'[^']+')/);
		const symbolMatch = line.match(/symbol:\s*("[^"]+"|'[^']+')/);
		if (!pathMatch) fail(`${label}: trace.${section} entry has no path`);
		if (!symbolMatch || unquote(symbolMatch[1]).trim() === "") fail(`${label}: trace.${section} entry has no symbol`);
		entries.push(unquote(pathMatch[1]));
	}
	if (entries.length === 0) fail(`${label}: trace.${section} has no entries`);
	return entries;
}

function loadReceipts(readReceipt) {
	const receipts = new Map();
	if (!fs.existsSync(receiptsDir)) fail("review receipt store is missing");
	for (const filename of fs.readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).sort()) {
		const id = filename.replace(/\.json$/, "");
		let receipt;
		try {
			receipt = JSON.parse(readReceipt(filename));
		} catch {
			fail(`receipt ${id}: not valid JSON`);
		}
		if (receipt.review_id !== id) fail(`receipt ${id}: filename/review_id mismatch`);
		receipts.set(id, receipt);
	}
	return receipts;
}

/**
 * Re-derive everything the receipt claims about a reviewer straight from the preserved
 * bytes. Hashing the transcript alone proves only that *some* transcript exists: a real
 * FOUND_ISSUES transcript could sit next to a receipt asserting Clean, and both the hash
 * and the format check would pass. So the transcript is parsed again here, with the same
 * parser the issuer used, and the receipt must agree with what it says.
 */
function verifyReviewerAgainstTranscript(reviewer, receiptId, stage, requirementId, scopeDigest, readLog) {
	if (!/^sha256:[0-9a-f]{64}$/.test(reviewer.log_sha256 || "")) fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} has no verbatim log digest`);
	/** Containment is decided on the resolved path: a `logs/../../..` prefix passes a startsWith check. */
	const logsDir = path.join(receiptsDir, "logs");
	const resolved = typeof reviewer.log === "string" ? path.resolve(root, reviewer.log) : "";
	if (path.dirname(resolved) !== logsDir || path.basename(resolved) !== path.basename(reviewer.log || "")) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} does not preserve its transcript in the receipt store`);
	}

	let bytes;
	try {
		bytes = readLog(reviewer.log);
	} catch {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript is missing: ${reviewer.log}`);
	}
	const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== reviewer.log_sha256) fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not hash to its recorded digest`);

	const derived = transcript.readTranscript(bytes);
	/** The reviewer's own transcript names the tree it judged; a verdict cannot be moved onto another one. */
	if (derived.scope_digest !== scopeDigest) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} judged ${derived.scope_digest ?? "an unstated tree"}, not the current ${scopeDigest}`);
	}
	if (derived.stages[stage] !== reviewer.stages?.[stage]) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} claims a ${stage} verdict of ${JSON.stringify(reviewer.stages?.[stage])} but its transcript says ${JSON.stringify(derived.stages[stage])}`);
	}
	if (derived.stages[stage] !== "clean") {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not give a clean ${stage} verdict`);
	}
	if (derived.findings[stage] !== 0) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript reports ${derived.findings[stage]} ${stage} finding(s)`);
	}
	if (!derived.covers.includes(requirementId)) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not report covering it`);
	}
}

function validateReceipt(receipt, id, stage, requirementId, scopeDigest, readLog) {
	const stageResult = receipt.stages?.[stage];
	if (!stageResult) fail(`${requirementId}: receipt ${id} carries no ${stage} verdict`);
	if (stageResult.verdict !== "clean") fail(`${requirementId}: receipt ${id} ${stage} verdict is not clean`);
	if (!Number.isInteger(stageResult.findings) || stageResult.findings !== 0) fail(`${requirementId}: receipt ${id} ${stage} is clean with a nonzero finding count`);
	if (receipt.scope_digest !== scopeDigest) fail(`${requirementId}: receipt ${id} judged a different tree (scope digest drift — the reviewed content changed after the review)`);

	/**
	 * Quorum is counted per requirement, not per receipt: a reviewer only vouches for what
	 * it said it covered. One reviewer omitting RCI-007 should cost that requirement its
	 * vote, not void the receipt for the ten it did cover.
	 */
	const reviewers = Array.isArray(receipt.reviewers) ? receipt.reviewers : [];
	/** Distinct reviewers means distinct reviews: the same transcript listed twice is one voice, not two. */
	const transcripts = new Set();
	for (const reviewer of reviewers) {
		if (transcripts.has(reviewer.log_sha256)) fail(`${requirementId}: receipt ${id} lists one transcript under two reviewers`);
		transcripts.add(reviewer.log_sha256);
	}
	const vouching = reviewers.filter((reviewer) => reviewer?.stages?.[stage] === "clean" && Array.isArray(reviewer.covers) && reviewer.covers.includes(requirementId));
	const identities = new Set(vouching.map((reviewer) => `${reviewer.tool}/${reviewer.model}`));
	if (identities.size < stageMinimumReviewers[stage]) {
		fail(`${requirementId}: receipt ${id} ${stage} has ${identities.size} clean reviewer(s) vouching for it; ${stageMinimumReviewers[stage]} distinct reviewers are required`);
	}
	for (const reviewer of vouching) verifyReviewerAgainstTranscript(reviewer, id, stage, requirementId, scopeDigest, readLog);
}

const readLogFromDisk = (relativePath) => fs.readFileSync(path.join(root, relativePath));

function validateData(files, indexText, receipts, scopeDigest, exists = (relativePath) => fs.existsSync(path.join(root, relativePath)), readLog = readLogFromDisk) {
	const ids = [...files.keys()].sort();
	if (ids.join(",") !== expectedIds.join(",")) fail(`expected ${expectedIds.join(",")}; got ${ids.join(",")}`);

	/**
	 * A Dirty verdict against the very tree being certified is disqualifying, whether or not any
	 * requirement bothered to name that receipt. Passing by citing only the Clean rounds and
	 * quietly leaving a Dirty one in the store beside them is exactly the shape of the failure
	 * this gate exists to prevent.
	 */
	for (const [receiptId, receipt] of receipts) {
		if (receipt.scope_digest !== scopeDigest) continue;
		for (const stage of stages) {
			if (receipt.stages?.[stage]?.verdict === "dirty") {
				fail(`receipt ${receiptId} records a dirty ${stage} verdict against this exact tree; fix what it found and re-review`);
			}
		}
	}

	const directiveUnion = new Set();
	for (const id of expectedIds) {
		const blocks = topLevelBlocks(files.get(id), id);
		if (scalarOf(blocks, "id", id) !== id) fail(`${id}: filename/id mismatch`);
		if (scalarOf(blocks, "product", id) !== "naia-adk-request-contract") fail(`${id}: wrong product`);
		if (scalarOf(blocks, "status", id) !== "verified") fail(`${id}: status is not verified`);
		if (scalarOf(blocks, "source", id) !== "human") fail(`${id}: source is not human`);

		const directiveInline = scalarOf(blocks, "source_directives", id).match(/^\[(.*)\]$/s);
		if (!directiveInline) fail(`${id}: source_directives missing or malformed`);
		const directives = directiveInline[1].split(",").map((item) => unquote(item)).filter((item) => item !== "");
		if (directives.length === 0 || directives.some((item) => !expectedDirectives.includes(item))) fail(`${id}: invalid source_directives`);
		for (const directive of directives) directiveUnion.add(directive);

		const acceptance = bodyOf(blocks, "acceptance_criteria", id);
		if ((acceptance.match(/^\s{2}-\s+.+$/gm) || []).length < 2) fail(`${id}: fewer than two acceptance criteria`);

		const trace = bodyOf(blocks, "trace", id);
		for (const section of ["code", "tests"]) {
			for (const relativePath of parseTracePaths(trace, section, id)) {
				if (!exists(relativePath)) fail(`${id}: trace path does not exist: ${relativePath}`);
			}
		}

		const reviews = parseReviews(trace, id);
		for (const stage of stages) {
			const receiptIds = reviews[stage];
			if (receiptIds.length < requiredCleanRounds) {
				fail(`${id}: ${stage} names ${receiptIds.length} Clean round(s); review-pass requires ${requiredCleanRounds} consecutive`);
			}
			/**
			 * Two receipts are two rounds only if two reviews actually happened. Nothing else
			 * separates them: both must carry the same scope digest by construction, so a single
			 * round could otherwise be issued twice under different ids and satisfy the streak —
			 * which is the exact violation this gate exists to catch. Round identity is therefore
			 * the set of transcripts it was derived from: no transcript may be spent twice.
			 */
			const spent = new Map();
			for (const receiptId of receiptIds) {
				const receipt = receipts.get(receiptId);
				if (!receipt) fail(`${id}: ${stage} names receipt ${receiptId}, which does not exist in the receipt store`);
				validateReceipt(receipt, receiptId, stage, id, scopeDigest, readLog);
				for (const reviewer of receipt.reviewers ?? []) {
					const previous = spent.get(reviewer.log_sha256);
					if (previous !== undefined && previous !== receiptId) {
						fail(`${id}: ${stage} counts ${previous} and ${receiptId} as separate Clean rounds, but they rest on the same reviewer transcript (${reviewer.model}) — one round cannot be spent twice`);
					}
					spent.set(reviewer.log_sha256, receiptId);
				}
			}
		}

		const title = scalarOf(blocks, "title", id);
		const escapedId = id.replace("-", "\\-");
		const indexMatches = [...indexText.matchAll(new RegExp(`^\\s+- \\{ id: ${escapedId}, title: "([^"]+)", status: ([^ }]+) \\}\\s*$`, "gm"))];
		if (indexMatches.length !== 1) fail(`${id}: expected exactly one index entry`);
		if (indexMatches[0][1] !== title || indexMatches[0][2] !== "verified") fail(`${id}: index title/status drift`);
	}

	if ([...directiveUnion].sort().join(",") !== expectedDirectives.join(",")) fail("USR-001 through USR-007 are not all traced");
	if (!/product:\s*naia-adk-request-contract[\s\S]*?req_count:\s*11\b/.test(indexText)) fail("request-contract index count is not 11");
}

function loadRequirementFiles() {
	const files = new Map();
	for (const filename of scope.requirementFilenames()) {
		const text = fs.readFileSync(path.join(requirementsDir, filename), "utf8");
		const declared = scalarOf(topLevelBlocks(text, filename), "id", filename);
		const fromName = filename.slice(0, "RCI-000".length);
		if (declared !== fromName) fail(`${filename}: declares id ${declared}`);
		if (files.has(declared)) fail(`${declared}: declared by more than one file`);
		files.set(declared, text);
	}
	return files;
}

function expectFailure(label, run) {
	try {
		run();
	} catch {
		return;
	}
	fail(`negative self-test passed unexpectedly: ${label}`);
}

/**
 * The negative self-tests run against a synthetic fixture, not against the repository's
 * own requirement files and receipts.
 *
 * That is deliberate. Tests built on the live data can only run once the live data already
 * passes: before the first receipt exists the suite dies at "receipt store is missing", and
 * a mutation regex written for one file format goes inert against another. Either way the
 * assertions never execute and the gate quietly guards nothing. A fixture the test owns
 * outright always runs, and it exercises the rejection paths on a tree that is valid by
 * construction — so a regression that starts accepting forged receipts fails here loudly,
 * whatever state the real store happens to be in.
 */
function buildFixture() {
	const scopeDigest = `sha256:${"1".repeat(64)}`;
	const logs = new Map();
	const stageNames = ["planning", "development", "test", "integration"];

	/** Each round produces its own transcripts — two rounds that share bytes are one round, and the validator says so. */
	const transcriptFor = (receiptId, model, covered) =>
		Buffer.from(
			[
				`Review of ${receiptId} by ${model}.`,
				"",
				"### Scope Digest",
				"",
				scopeDigest,
				"",
				"### RCI Coverage",
				...expectedIds.map((id) => `- ${id}: ${covered.includes(id) ? "COVERED" : "NOT COVERED"}`),
				"",
				...stageNames.flatMap((stage) => {
					const heading = stage[0].toUpperCase() + stage.slice(1);
					return [`### ${heading} Findings`, "", "NONE", "", `### ${heading} Verdict`, "", "CLEAN", ""];
				}),
			].join("\n"),
		);

	const reviewerOf = (receiptId, tool, model) => {
		const logPath = `.agents/requirements/reviews/logs/${receiptId}__${tool}__${model}.log`;
		const bytes = transcriptFor(receiptId, model, expectedIds);
		logs.set(logPath, bytes);
		const derived = transcript.readTranscript(bytes);
		return {
			tool,
			model,
			log: logPath,
			log_sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
			covers: derived.covers,
			stages: derived.stages,
			findings: derived.findings,
		};
	};

	const receiptOf = (receiptId) => ({
		review_id: receiptId,
		product: "naia-adk-request-contract",
		reviewed_at: "2026-07-14T00:00:00+09:00",
		scope_digest: scopeDigest,
		covers: [...expectedIds],
		stages: Object.fromEntries(stageNames.map((stage) => [stage, { verdict: "clean", findings: 0, clean_reviewers: 3, dirty_reviewers: 0, silent_reviewers: 0 }])),
		reviewers: [reviewerOf(receiptId, "opencode", "alpha"), reviewerOf(receiptId, "opencode", "beta"), reviewerOf(receiptId, "opencode", "gamma")],
	});

	const receipts = new Map([
		["round-1", receiptOf("round-1")],
		["round-2", receiptOf("round-2")],
	]);

	/** A replay of round-1's transcripts under a second id: same bytes, different receipt. */
	const replayed = JSON.parse(JSON.stringify(receipts.get("round-2")));
	replayed.review_id = "round-2";
	replayed.reviewers = receipts.get("round-1").reviewers.map((reviewer) => ({ ...reviewer }));

	const reviewsLine = `  reviews: { ${stageNames.map((stage) => `${stage}: ["round-1", "round-2"]`).join(", ")} }`;
	const files = new Map();
	for (const [index, id] of expectedIds.entries()) {
		const directives = index === 0 ? expectedDirectives : [expectedDirectives[index % expectedDirectives.length]];
		files.set(
			id,
			[
				`id: ${id}`,
				`title: "Fixture ${id}"`,
				"product: naia-adk-request-contract",
				"status: verified",
				"source: human",
				`source_directives: [${directives.join(", ")}]`,
				"acceptance_criteria:",
				'  - "First criterion."',
				'  - "Second criterion."',
				"trace:",
				"  code:",
				'    - { path: "scripts/validate-request-contract-requirements.cjs", symbol: "validateData", coverage: full }',
				"  tests:",
				'    - { path: "scripts/request-contract-review-transcript.cjs", symbol: "selfTest", coverage: full }',
				reviewsLine,
				"decisions: []",
				"",
			].join("\n"),
		);
	}

	const indexText = [
		"products:",
		"  - product: naia-adk-request-contract",
		"    req_count: 11",
		"    requirements:",
		...expectedIds.map((id) => `      - { id: ${id}, title: "Fixture ${id}", status: verified }`),
		"",
	].join("\n");

	/** The fixture owns its filesystem too: only the paths it traces exist, so a mutated path really is missing. */
	const present = new Set(["scripts/validate-request-contract-requirements.cjs", "scripts/request-contract-review-transcript.cjs"]);
	const exists = (relativePath) => present.has(relativePath);
	const readLog = (relativePath) => {
		if (!logs.has(relativePath)) throw new Error(`fixture: no such transcript: ${relativePath}`);
		return logs.get(relativePath);
	};

	/** A transcript that covers everything except RCI-007 — proves the NOT COVERED branch is live. */
	const partialFor = (receiptId, model) => transcriptFor(receiptId, model, expectedIds.filter((id) => id !== "RCI-007"));

	return { files, indexText, receipts, scopeDigest, exists, readLog, logs, replayed, partialFor };
}

function runSelfTests() {
	const base = buildFixture();
	const check = (files = base.files, indexText = base.indexText, receipts = base.receipts, scopeDigest = base.scopeDigest, readLog = base.readLog) =>
		validateData(files, indexText, receipts, scopeDigest, base.exists, readLog);

	/** The fixture must pass as-is, or every rejection below would "pass" for the wrong reason. */
	check();

	const mutateAll = (replace) => new Map([...base.files].map(([id, text]) => [id, replace(text, id)]));
	const mutateOne = (id, replace) => {
		const before = base.files.get(id);
		const after = replace(before);
		if (after === before) fail(`negative self-test is inert: its mutation did not change ${id}`);
		return new Map([...base.files].map(([key, text]) => [key, key === id ? after : text]));
	};
	const cloneReceipts = () => new Map([...base.receipts].map(([id, receipt]) => [id, JSON.parse(JSON.stringify(receipt))]));
	const anyReceiptId = "round-1";

	for (const id of expectedIds) {
		expectFailure(`status drift in ${id}`, () => check(mutateOne(id, (text) => text.replace("status: verified", "status: active"))));
		expectFailure(`nulled review in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[[^\]]*\]/, "planning: null"))));
		expectFailure(`review named by a bare string rather than receipts in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[[^\]]*\]/, 'planning: "2026-07-14-looks-clean"'))));
		expectFailure(`single Clean round in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[("[^"]+")[^\]]*\]/, "planning: [$1]"))));
		expectFailure(`forged receipt id in ${id}`, () => check(mutateOne(id, (text) => text.replace(/development: \[[^\]]*\]/, 'development: ["forged-clean", "forged-clean-2"]'))));
		expectFailure(`index entry removed for ${id}`, () => check(base.files, base.indexText.replace(new RegExp(`^\\s+- \\{ id: ${id},.*\\n`, "m"), "")));
	}

	expectFailure("missing trace path", () => check(mutateAll((text) => text.replace("scripts/validate-request-contract-requirements.cjs", "missing/gone.cjs"))));
	expectFailure("empty trace symbol", () => check(mutateAll((text) => text.replace(/symbol: "[^"]*"/g, 'symbol: ""'))));
	expectFailure("duplicate top-level key", () => check(mutateAll((text) => `${text}\nstatus: active\n`)));
	expectFailure("requirement file dropped", () => check(new Map([...base.files].filter(([id]) => id !== "RCI-011"))));
	expectFailure("a directive is left untraced", () => check(mutateAll((text) => text.replace(/source_directives: \[[^\]]*\]/, "source_directives: [USR-001]"))));
	expectFailure("scope digest drift", () => check(base.files, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`));
	expectFailure("receipt store emptied", () => check(base.files, base.indexText, new Map()));

	expectFailure("receipt verdict flipped to dirty", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).stages.development.verdict = "dirty";
		check(base.files, base.indexText, tampered);
	});
	expectFailure("receipt clean with a nonzero finding count", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).stages.development.findings = 3;
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewer quorum dropped", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers = tampered.get(anyReceiptId).reviewers.slice(0, 1);
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewers collapse to one identity", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		receipt.reviewers = receipt.reviewers.map((reviewer) => ({ ...reviewer, model: "same" }));
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewer loses its verbatim log digest", () => {
		const tampered = cloneReceipts();
		delete tampered.get(anyReceiptId).reviewers[0].log_sha256;
		check(base.files, base.indexText, tampered);
	});
	expectFailure("reviewer stops vouching for the requirement", () => {
		const tampered = cloneReceipts();
		for (const reviewer of tampered.get(anyReceiptId).reviewers) reviewer.covers = [];
		check(base.files, base.indexText, tampered);
	});
	expectFailure("hand-written log digest with no matching transcript", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log_sha256 = `sha256:${"a".repeat(64)}`;
		check(base.files, base.indexText, tampered);
	});
	/**
	 * The attack hashing alone cannot see: keep a real, correctly-hashed transcript that says
	 * FOUND_ISSUES and write a receipt over it claiming Clean. Only re-parsing the bytes catches it.
	 */
	expectFailure("clean receipt over a transcript that found issues", () => {
		const tampered = cloneReceipts();
		const reviewer = tampered.get(anyReceiptId).reviewers[0];
		/**
		 * Same tree, same coverage, all four stages present — the ONLY difference from a genuine
		 * transcript is development's verdict. Anything less and the run would trip an earlier
		 * check (a missing planning section, say) and this test would pass without ever reaching
		 * the verdict comparison it is named for.
		 */
		const forged = Buffer.from(
			[
				"### Scope Digest",
				"",
				base.scopeDigest,
				"",
				"### RCI Coverage",
				...expectedIds.map((id) => `- ${id}: COVERED`),
				"",
				"### Planning Findings",
				"",
				"NONE",
				"",
				"### Planning Verdict",
				"",
				"CLEAN",
				"",
				"### Development Findings",
				"",
				"- `scripts/x.cjs:1 [CRITICAL] RCI-001 — a defect the reviewer really found`",
				"",
				"### Development Verdict",
				"",
				"FOUND_ISSUES",
				"",
				"### Test Findings",
				"",
				"NONE",
				"",
				"### Test Verdict",
				"",
				"CLEAN",
				"",
				"### Integration Findings",
				"",
				"NONE",
				"",
				"### Integration Verdict",
				"",
				"CLEAN",
			].join("\n"),
		);
		reviewer.log_sha256 = `sha256:${crypto.createHash("sha256").update(forged).digest("hex")}`;
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => (relativePath === reviewer.log ? forged : base.readLog(relativePath)));
	});
	expectFailure("transcript removed from the store", () => {
		const tampered = cloneReceipts();
		const missing = tampered.get(anyReceiptId).reviewers[0].log;
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => {
			if (relativePath === missing) throw new Error("gone");
			return base.readLog(relativePath);
		});
	});
	expectFailure("transcript points outside the receipt store", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log = "tmp/whatever.log";
		check(base.files, base.indexText, tampered);
	});
	expectFailure("transcript escapes the store by path traversal", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log = ".agents/requirements/reviews/logs/../../../../etc/hostname";
		check(base.files, base.indexText, tampered);
	});
	expectFailure("transcript hides in a subdirectory of the store", () => {
		const tampered = cloneReceipts();
		tampered.get(anyReceiptId).reviewers[0].log = ".agents/requirements/reviews/logs/nested/forged.log";
		check(base.files, base.indexText, tampered);
	});
	/**
	 * The violation this whole gate exists to catch: one review round, issued twice under two
	 * ids, passing as the two consecutive Clean rounds review-pass requires. Both receipts are
	 * individually valid — same scope digest, real transcripts, honest verdicts — and only the
	 * shared transcripts give it away.
	 */
	expectFailure("one round issued twice as two", () => {
		const tampered = cloneReceipts();
		tampered.set("round-2", base.replayed);
		check(base.files, base.indexText, tampered);
	});
	/** A verdict earned on the tree before the writer's last edit cannot be spent on the tree after it. */
	expectFailure("a verdict moved onto a tree its reviewer never saw", () => {
		const moved = `sha256:${"2".repeat(64)}`;
		const tampered = cloneReceipts();
		for (const receipt of tampered.values()) receipt.scope_digest = moved;
		check(base.files, base.indexText, tampered, moved);
	});
	expectFailure("one transcript listed under two reviewers", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		receipt.reviewers[1] = { ...receipt.reviewers[0], tool: "opencode", model: "beta" };
		check(base.files, base.indexText, tampered);
	});
	/**
	 * A reviewer that marked one requirement NOT COVERED must cost that requirement its vote —
	 * dropping the round below quorum for it — while the other ten stay covered. Without this,
	 * the transcript-vs-receipt coverage cross-check could be deleted and nothing would notice.
	 */
	expectFailure("a reviewer that did not cover RCI-007 cannot vouch for it", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		/** Each reviewer keeps its own distinct transcript — otherwise the duplicate-transcript check fires first and this test never reaches the quorum it is named for. */
		const partials = new Map();
		for (const reviewer of receipt.reviewers) {
			const bytes = base.partialFor(anyReceiptId, reviewer.model);
			partials.set(reviewer.log, bytes);
			reviewer.log_sha256 = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
			reviewer.covers = expectedIds.filter((id) => id !== "RCI-007");
		}
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => partials.get(relativePath) ?? base.readLog(relativePath));
	});

	/**
	 * The receipt claims its reviewers covered RCI-007; their transcripts say otherwise. The
	 * quorum filter above cannot catch this — it reads the receipt's own claim — so only the
	 * cross-check against the preserved bytes stands between a padded `covers` list and a pass.
	 */
	expectFailure("a receipt that pads its coverage beyond what the transcripts say", () => {
		const tampered = cloneReceipts();
		const receipt = tampered.get(anyReceiptId);
		const partials = new Map();
		for (const reviewer of receipt.reviewers) {
			const bytes = base.partialFor(anyReceiptId, reviewer.model);
			partials.set(reviewer.log, bytes);
			reviewer.log_sha256 = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
			/** The lie: the receipt still vouches for all eleven. */
			reviewer.covers = [...expectedIds];
		}
		check(base.files, base.indexText, tampered, base.scopeDigest, (relativePath) => partials.get(relativePath) ?? base.readLog(relativePath));
	});

	/** A Dirty verdict standing against this very tree disqualifies it, even if no requirement cites that receipt. */
	expectFailure("a dirty receipt left standing against the same tree", () => {
		const tampered = cloneReceipts();
		const dirty = JSON.parse(JSON.stringify(tampered.get("round-1")));
		dirty.review_id = "round-0";
		dirty.stages.development = { verdict: "dirty", findings: 2, clean_reviewers: 0, dirty_reviewers: 3, silent_reviewers: 0 };
		tampered.set("round-0", dirty);
		check(base.files, base.indexText, tampered);
	});
}

/** Self-tests first: they must hold whatever state the real store is in. */
if (!transcript.selfTest()) fail("the shared transcript parser failed its own self-test");
if (!scope.selfTest()) fail("the review-scope digest failed its own self-test");
runSelfTests();

const files = loadRequirementFiles();
const indexText = fs.readFileSync(path.join(requirementsDir, "_index.yaml"), "utf8");
const readReceipt = (filename) => fs.readFileSync(path.join(receiptsDir, filename), "utf8");
const receipts = loadReceipts(readReceipt);
const scopeDigest = scope.computeScopeDigest();
validateData(files, indexText, receipts, scopeDigest);

process.stdout.write("request-contract requirement trace: PASS\n");
