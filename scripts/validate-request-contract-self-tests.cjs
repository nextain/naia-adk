#!/usr/bin/env node
const crypto = require("crypto");

module.exports = function executeRequirementTraceSelfTests({
	scope, transcript, currentReviewedFiles, expectedIds, expectedDirectives, pendingIds,
	requiredUsr008Obligations, fail, sha256, canonicalSourceEvent, loadSourceLedger, validateData, traceTestRegistrationExists,
}) {
function expectFailure(label, run) {
	try {
		run();
	} catch {
		return;
	}
	fail(`negative self-test passed unexpectedly: ${label}`);
}

function expectFailureMatching(label, pattern, run) {
	try {
		run();
	} catch (error) {
		if (pattern.test(String(error && error.message || ""))) return;
		fail(`negative self-test failed for the wrong reason: ${label}: ${error && error.message}`);
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
const buildFixture = require("./validate-request-contract-fixture.cjs")({
	scope, transcript, currentReviewedFiles, expectedIds, expectedDirectives, pendingIds,
	requiredUsr008Obligations, sha256, canonicalSourceEvent, loadSourceLedger,
});

function runSelfTests() {
	if (!traceTestRegistrationExists('test("an exact trace target", () => {});', "an exact trace target")) fail("exact test registration self-test failed");
	if (traceTestRegistrationExists('test("an exact trace target", () => {});', "test")) fail("partial test symbol passed unexpectedly");
	const base = buildFixture();
	const check = (files = base.files, indexText = base.indexText, receipts = base.receipts, scopeDigest = base.scopeDigest, readLog = base.readLog, sourceLedger = base.sourceLedger, scopeManifest = base.scopeManifest) =>
		validateData(files, indexText, receipts, scopeDigest, base.exists, readLog, sourceLedger, scopeManifest);

	/** The fixture must pass as-is, or every rejection below would "pass" for the wrong reason. */
	check();

	const mutateAll = (replace) => new Map([...base.files].map(([id, text]) => [id, replace(text, id)]));
	const mutateOne = (id, replace) => {
		const before = base.files.get(id);
		const after = replace(before);
		if (after === before) fail(`negative self-test is inert: its mutation did not change ${id}`);
		return new Map([...base.files].map(([key, text]) => [key, key === id ? after : text]));
	};

	expectFailure("active requirement without source evidence", () => {
		check(mutateOne("RCI-012", (text) => text.replace(/^source_evidence:.*\r?\n/m, "")));
	});
	expectFailure("requirement source self-reference instead of a ledger record", () => {
		check(mutateOne("RCI-012", (text) => text.replace("source_evidence: [USR-008]", "source_evidence: [RCI-012]")));
	});
	expectFailure("requirement source atom is an arbitrary string", () => {
		check(mutateOne("RCI-012", (text) => text.replace("source_atoms: [USR-008-E01]", "source_atoms: [looks-like-evidence]")));
	});
	expectFailure("derived requirement launders itself as a human source", () => {
		check(mutateOne("RCI-012", (text) => text.replace("source: derived", "source: human").replace("source_kind: derived", "source_kind: human")));
	});
	expectFailure("destructive active requirement without approval", () => {
		check(mutateOne("RCI-012", (text) => text.replace("change_effect: extend", "change_effect: replace")));
	});
	expectFailure("legacy provenance gap is silently omitted", () => {
		check(base.files, base.indexText.replace(/^\s{4}- \{ id: USR-001, introduced_in:.*\r?\n/m, ""));
	});

	const sourceIndexWith = (bytes, { sourceKind = "human", origin = "native_user_message", locator = base.sourceRecord.locator } = {}) =>
		base.indexText
			.replace(sha256(base.sourceBytes), sha256(bytes))
			.replace("source_kind: human, origin: native_user_message", `source_kind: ${sourceKind}, origin: ${origin}`)
			.replace(`locator: "${base.sourceRecord.locator}"`, `locator: "${locator}"`);
	const sourceBytesFrom = (record) => Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
	const readOnlySource = (bytes) => (relativePath) => {
		if (relativePath !== base.sourcePath) throw new Error("fixture source missing");
		return bytes;
	};
	const cloneSource = () => JSON.parse(JSON.stringify(base.sourceRecord));

	expectFailure("source artifact bytes do not match the index digest", () => {
		const bytes = Buffer.concat([base.sourceBytes, Buffer.from(" ")]);
		loadSourceLedger(base.indexText, readOnlySource(bytes));
	});
	expectFailure("source locator self-references the requirement ledger", () => {
		const record = cloneSource();
		record.locator = "self://USR-008";
		record.events[0].locator = `${record.locator}#selected-user-message-01`;
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes, { locator: record.locator }), readOnlySource(bytes));
	});
	expectFailure("source_kind laundering changes a native directive to candidate", () => {
		const record = cloneSource();
		record.source_kind = "candidate";
		record.origin = "candidate";
		record.events[0].source_kind = "candidate";
		record.events[0].origin = "candidate";
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes, { sourceKind: "candidate", origin: "candidate" }), readOnlySource(bytes));
	});
	expectFailure("source origin laundering changes a native directive to derived", () => {
		const record = cloneSource();
		record.source_kind = "derived";
		record.origin = "derived_artifact";
		record.events[0].source_kind = "derived";
		record.events[0].origin = "derived_artifact";
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes, { sourceKind: "derived", origin: "derived_artifact" }), readOnlySource(bytes));
	});
	expectFailure("selected incident excerpts are laundered as complete history", () => {
		const record = cloneSource();
		record.coverage = "complete_history";
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes), readOnlySource(bytes));
	});
	expectFailure("source excerpt changes without its text digest", () => {
		const record = cloneSource();
		record.events[0].exact_text += " tampered";
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes), readOnlySource(bytes));
	});
	expectFailure("source event sequence is rewritten", () => {
		const record = cloneSource();
		record.events[0].sequence = 2;
		record.events[0].event_sha256 = sha256(canonicalSourceEvent(record.events[0]));
		const bytes = sourceBytesFrom(record);
		loadSourceLedger(sourceIndexWith(bytes), readOnlySource(bytes));
	});
	const cloneReceipts = () => new Map([...base.receipts].map(([id, receipt]) => [id, JSON.parse(JSON.stringify(receipt))]));
	{
		const crlfReceipts = cloneReceipts();
		const reviewer = crlfReceipts.get("round-1").reviewers[0];
		const crlf = Buffer.from(base.logs.get(reviewer.log).toString("utf8").replace(/\n/g, "\r\n"), "utf8");
		reviewer.log_sha256 = sha256(crlf);
		check(base.files, base.indexText, crlfReceipts, base.scopeDigest, (relativePath) => relativePath === reviewer.log ? crlf : base.readLog(relativePath));
	}
	expectFailure("review transcript omits a required Files Read path", () => {
		const tampered = cloneReceipts();
		const reviewer = tampered.get("round-1").reviewers[0];
		const logs = new Map(base.logs);
		const original = logs.get(reviewer.log).toString("utf8");
		const omitted = currentReviewedFiles[0];
		const changed = Buffer.from(original.replace(`- \`${omitted}\`\n`, ""), "utf8");
		logs.set(reviewer.log, changed);
		const derived = transcript.readTranscript(changed);
		reviewer.log_sha256 = sha256(changed);
		reviewer.files_read = derived.files_read;
		const readLog = (relativePath) => {
			if (!logs.has(relativePath)) throw new Error("missing fixture transcript");
			return logs.get(relativePath);
		};
		check(base.files, base.indexText, tampered, base.scopeDigest, readLog);
	});
	const anyReceiptId = "round-1";

	for (const id of expectedIds) {
		const from = pendingIds.has(id) ? "status: active" : "status: verified";
		const to = pendingIds.has(id) ? "status: verified" : "status: active";
		expectFailure(`status drift in ${id}`, () => check(mutateOne(id, (text) => text.replace(from, to))));
		expectFailure(`index entry removed for ${id}`, () => check(base.files, base.indexText.replace(new RegExp(`^\\s+- \\{ id: ${id},.*\\n`, "m"), "")));
	}
	for (const id of expectedIds.filter((value) => !pendingIds.has(value))) {
		expectFailure(`nulled review in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[[^\]]*\]/, "planning: null"))));
		expectFailure(`review named by a bare string rather than receipts in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[[^\]]*\]/, 'planning: "2026-07-14-looks-clean"'))));
		expectFailure(`single Clean round in ${id}`, () => check(mutateOne(id, (text) => text.replace(/planning: \[("[^"]+")[^\]]*\]/, "planning: [$1]"))));
		expectFailure(`forged receipt id in ${id}`, () => check(mutateOne(id, (text) => text.replace(/development: \[[^\]]*\]/, 'development: ["forged-clean", "forged-clean-2"]'))));
	}

	expectFailure("missing trace path", () => check(mutateAll((text) => text.replace("scripts/validate-request-contract-requirements.cjs", "missing/gone.cjs"))));
	expectFailure("empty trace symbol", () => check(mutateAll((text) => text.replace(/symbol: "[^"]*"/g, 'symbol: ""'))));
	expectFailure("duplicate top-level key", () => check(mutateAll((text) => `${text}\nstatus: active\n`)));
	expectFailure("requirement file dropped", () => check(new Map([...base.files].filter(([id]) => id !== "RCI-011"))));
	expectFailure("a directive is left untraced", () => check(mutateAll((text) => text.replace(/source_directives: \[[^\]]*\]/, "source_directives: [USR-001]"))));
	expectFailure("scope digest drift", () => check(base.files, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`));
	expectFailureMatching("stale receipt must not hide later acceptance damage", /RCI-002: fewer than two acceptance criteria/, () => {
		const damaged = mutateOne("RCI-002", (text) => text.replace(/^\s{2}- "Second criterion\."\r?\n/m, ""));
		check(damaged, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`);
	});
	expectFailureMatching("stale receipt must not hide later trace damage", /RCI-014: trace\.tests missing/, () => {
		const damaged = mutateOne("RCI-014", (text) => text.replace(/\n  tests:\n(?:    - .*\n)+/, "\n"));
		check(damaged, base.indexText, base.receipts, `sha256:${"0".repeat(64)}`);
	});
	expectFailure("review receipt omits the exact supplied-file manifest", () => {
		const tampered = cloneReceipts();
		delete tampered.get("round-1").scope_manifest;
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("a stale modern receipt cannot hide manifest tampering", /scope_manifest does not compute to its scope_digest/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").scope_manifest[0].size += 1;
		check(base.files, base.indexText, tampered, `sha256:${"0".repeat(64)}`);
	});
	expectFailureMatching("an unbound receipt cannot downgrade itself to the legacy evidence schema", /exact legacy byte binding/, () => {
		const tampered = cloneReceipts();
		delete tampered.get("round-1").scope_manifest;
		delete tampered.get("round-1").reviewers[0].files_read;
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("reviewer scope claim differs from its transcript", /scope_digest differs from its transcript/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").reviewers[0].scope_digest = `sha256:${"9".repeat(64)}`;
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("top-level coverage padding is rejected", /aggregate coverage does not match reviewer transcripts/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").covers.push("RCI-999");
		check(base.files, base.indexText, tampered);
	});
	expectFailureMatching("aggregate reviewer counts are re-derived", /aggregate stage claims do not match reviewer transcripts/, () => {
		const tampered = cloneReceipts();
		tampered.get("round-1").stages.development.clean_reviewers += 1;
		check(base.files, base.indexText, tampered);
	});
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
	runSelfTests();
};
