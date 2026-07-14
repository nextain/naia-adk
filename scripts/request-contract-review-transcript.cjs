#!/usr/bin/env node
/**
 * Reviewer-transcript parsing, shared by the receipt issuer and the trace validator.
 *
 * It lives in one place on purpose. The issuer derives a receipt from a transcript and
 * the validator re-derives the same values from the preserved bytes and compares. If the
 * two used different parsers, a receipt could claim a verdict its transcript never gave.
 */

const stages = ["planning", "development", "test", "integration"];

/**
 * Strip ANSI so a colourised CLI transcript parses, and drop fenced code blocks.
 *
 * A reviewer that pastes a snippet containing `### RCI Coverage` — to demonstrate a parser
 * case, say — would otherwise plant a heading the parser reads as the real one. Digests are
 * always taken over the raw bytes; this normalisation only affects what we read out of them.
 */
function plain(text) {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, "");
}

/**
 * The last occurrence wins. A reviewer's transcript is a running log — tool calls, drafts,
 * reasoning — and the required sections come at the very end ("emit exactly these sections
 * and nothing after"). Taking the first match would let anything earlier in the log
 * impersonate the verdict.
 */
function section(text, heading) {
	const matches = [...text.matchAll(new RegExp(`^#+\\s*${heading}\\s*$([\\s\\S]*?)(?=^#+\\s|$(?![\\s\\S]))`, "gim"))];
	return matches.length ? matches[matches.length - 1][1].trim() : null;
}

/**
 * A reviewer that never emitted the section — truncated mid-tool-call, streaming error —
 * yields null. Null is not a pass; only a literal CLEAN is.
 */
function stageVerdict(text, stage) {
	const body = section(text, `${stage} Verdict`);
	if (body === null) return null;
	/**
	 * The verdict must stand alone on its line. The instructions handed to the reviewer say
	 * "CLEAN or FOUND_ISSUES" under this very heading — and a transcript usually echoes the
	 * instructions. A loose `^CLEAN\b` would read that template as a verdict, so a reviewer
	 * whose run died before it ever answered would inherit a Clean from the prompt that
	 * asked the question.
	 */
	const first = body.split(/\r?\n/).find((line) => line.trim() !== "");
	if (first === undefined) return null;
	const word = first.trim().replace(/^\*+|\*+$/g, "").replace(/[.]$/, "");
	if (/^CLEAN$/i.test(word)) return "clean";
	if (/^FOUND_ISSUES$/i.test(word)) return "dirty";
	return null;
}

/** Null means the reviewer never reported findings for this stage, which cannot count as zero. */
function stageFindings(text, stage) {
	const body = section(text, `${stage} Findings`);
	if (body === null) return null;
	/** Same hazard: the prompt's own `[CRITICAL|HIGH|MEDIUM|LOW]` placeholder must not read as a real severity, nor its `or NONE` as zero findings. */
	if (/\[CRITICAL\|HIGH\|MEDIUM\|LOW\]/i.test(body) || /\bor\s+`?NONE`?/i.test(body)) return null;
	const severities = (body.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/gi) || []).length;
	if (severities > 0) return severities;
	if (/^\W*NONE\W*$/im.test(body)) return 0;
	return null;
}

/**
 * The scope digest the reviewer was told it was judging, echoed back in its own transcript.
 *
 * Without this the receipt's digest is whatever the tree happened to be at *issue* time, not
 * at *review* time — so a writer could take a Clean round, edit the reviewed code, then issue,
 * and the receipt would bind the verdict to a tree no reviewer ever saw. The transcript is the
 * only artifact that comes from the review itself, so the digest has to travel in it.
 */
function scopeDigest(text) {
	const body = section(text, "Scope Digest");
	if (body === null) return null;
	const match = body.match(/\bsha256:[0-9a-f]{64}\b/);
	return match ? match[0] : null;
}

/** Requirements the reviewer states it actually covered. Never assumed. */
function coverage(text) {
	const body = section(text, "RCI Coverage");
	if (body === null) return [];
	const covered = new Set();
	for (const line of body.split(/\r?\n/)) {
		const match = line.match(/\b(RCI-\d{3})\b\s*[:\-—]\s*(.+)$/);
		if (!match) continue;
		const claim = match[2].trim();
		/**
		 * Only an unqualified COVERED counts. Rather than blacklisting hedges — the list is
		 * never complete — require the claim to *be* COVERED, optionally followed by evidence
		 * in parentheses or after a dash. A colon is not allowed to introduce that evidence:
		 * "COVERED: not really tested" would then read as coverage. "NOT COVERED",
		 * "PARTIALLY COVERED", and "COVERED conditional on X" all fail to match.
		 */
		if (!/^\W*COVERED\s*(?:$|[.(\-—])/i.test(claim)) continue;
		covered.add(match[1]);
	}
	return [...covered].sort();
}

/** The verdict a stage actually earns: a Clean claim standing over listed findings is not Clean. */
function stageResult(text, stage) {
	const verdict = stageVerdict(text, stage);
	const findings = stageFindings(text, stage);
	if (verdict !== "clean") return { verdict, findings };
	if (findings === 0) return { verdict: "clean", findings: 0 };
	return { verdict: findings === null ? null : "dirty", findings };
}

/** Everything a receipt may say about one reviewer, derived only from its bytes. */
function readTranscript(raw) {
	const text = plain(raw.toString("utf8"));
	const result = { scope_digest: scopeDigest(text), covers: coverage(text), stages: {}, findings: {} };
	for (const stage of stages) {
		const { verdict, findings } = stageResult(text, stage);
		result.stages[stage] = verdict;
		result.findings[stage] = findings;
	}
	return result;
}

/**
 * These parsers decide whether a review counts, so a silent misread here turns a failed
 * review into a Clean one. Exercise them directly.
 */
function selfTest(report = (message) => process.stderr.write(`${message}\n`)) {
	const failures = [];
	const check = (label, actual, expected) => {
		const got = JSON.stringify(actual);
		const want = JSON.stringify(expected);
		if (got !== want) failures.push(`${label}: got ${got}, want ${want}`);
	};

	const clean = "### Development Findings\n\nNONE\n\n### Development Verdict\n\nCLEAN\n";
	check("clean verdict", stageVerdict(clean, "development"), "clean");
	check("clean findings", stageFindings(clean, "development"), 0);
	check("clean result", stageResult(clean, "development"), { verdict: "clean", findings: 0 });

	const dirty = "### Test Findings\n\n- `a.js:1 [HIGH] RCI-001 — bad`\n\n### Test Verdict\n\nFOUND_ISSUES\n";
	check("dirty verdict", stageVerdict(dirty, "test"), "dirty");
	check("dirty findings counted", stageFindings(dirty, "test"), 1);

	check("bolded verdict", stageVerdict("### Planning Findings\n\nNONE\n\n### Planning Verdict\n\n**CLEAN**\n", "planning"), "clean");

	/** A run that died mid-tool-call never wrote the sections. It must not read as a pass. */
	const truncated = "### Files Read\n- a.js\n\nI'll now run the tests:\n<tool_call>";
	check("truncated verdict", stageVerdict(truncated, "development"), null);
	check("truncated findings", stageFindings(truncated, "development"), null);
	check("truncated result", stageResult(truncated, "development"), { verdict: null, findings: null });

	/** A Clean claim standing over findings the reviewer itself listed is a contradiction. */
	const contradictory = "### Test Findings\n\n- `a.js:1 [MEDIUM] RCI-002 — x`\n\n### Test Verdict\n\nCLEAN\n";
	check("clean claimed over listed findings", stageResult(contradictory, "test"), { verdict: "dirty", findings: 1 });

	/** Prose with neither NONE nor a severity is not evidence of zero findings. */
	check("vague findings", stageResult("### Test Findings\n\nLooks fine.\n\n### Test Verdict\n\nCLEAN\n", "test"), { verdict: null, findings: null });

	const coverageText = [
		"### RCI Coverage",
		"- RCI-001: COVERED (evidence)",
		"- RCI-002: NOT COVERED",
		"- RCI-003: PARTIALLY COVERED",
		"- RCI-004: covered — lowercase is fine",
		"- RCI-005: COVERED partially — trailing qualifier still hedges",
		"- RCI-006: COVERED except for the sandbox path",
		"- RCI-007: COVERED conditional on the signer being provisioned",
		"- RCI-008: COVERED",
		"- RCI-009: COVERED: not really tested",
		"- RCI-010: COVERED.",
		"",
		"### Planning Findings",
		"NONE",
	].join("\n");
	check("coverage counts only unqualified COVERED", coverage(coverageText), ["RCI-001", "RCI-004", "RCI-008", "RCI-010"]);
	check("coverage of an empty transcript", coverage("nothing here"), []);

	const digestText = `### Scope Digest\n\nsha256:${"a".repeat(64)}\n\n### Planning Findings\nNONE\n`;
	check("scope digest is read from the transcript", scopeDigest(digestText), `sha256:${"a".repeat(64)}`);
	check("a transcript with no scope digest yields null", scopeDigest("### Planning Findings\nNONE\n"), null);
	check("a malformed scope digest yields null", scopeDigest("### Scope Digest\n\nsha256:nope\n"), null);

	/** Severity markers are matched case-insensitively; a lowercase one still counts. */
	check("lowercase severity counted", stageFindings("### Test Findings\n\n- `a.js:1 [high] RCI-001 — x`\n\n### Test Verdict\nCLEAN\n", "test"), 1);
	check("several findings counted", stageFindings("### Test Findings\n- `a:1 [HIGH] x`\n- `b:2 [LOW] y`\n\n### Test Verdict\nFOUND_ISSUES\n", "test"), 2);

	/** The whole point of re-deriving from bytes: a dirty transcript can never read as clean. */
	const dirtyBytes = Buffer.from("### RCI Coverage\n- RCI-001: COVERED\n\n### Development Findings\n\n- `a.js:1 [CRITICAL] RCI-001 — boom`\n\n### Development Verdict\n\nFOUND_ISSUES\n");
	check("dirty transcript re-derives dirty", readTranscript(dirtyBytes).stages.development, "dirty");

	/** A snippet the reviewer pasted mid-log must not impersonate the sections it emits at the end. */
	const withSnippet = [
		"Let me check the parser with a sample:",
		"```",
		"### RCI Coverage",
		"- RCI-001: COVERED",
		"### Development Verdict",
		"CLEAN",
		"```",
		"Now my actual review.",
		"",
		"### RCI Coverage",
		"- RCI-002: COVERED",
		"",
		"### Development Findings",
		"- `a.js:1 [HIGH] RCI-002 — a real defect`",
		"",
		"### Development Verdict",
		"FOUND_ISSUES",
	].join("\n");
	check("a fenced snippet cannot impersonate the coverage section", coverage(plain(withSnippet)), ["RCI-002"]);
	check("a fenced snippet cannot impersonate the verdict", stageVerdict(plain(withSnippet), "development"), "dirty");

	/** Even unfenced, an earlier draft must not outrank the final sections. */
	const redrafted = "### Development Verdict\nCLEAN\n\n### Files Read\n- a.js\n\n### Development Findings\n- `a.js:1 [HIGH] RCI-001 — x`\n\n### Development Verdict\nFOUND_ISSUES\n";
	check("the last verdict wins", stageVerdict(redrafted, "development"), "dirty");

	/**
	 * The transcript normally echoes the instructions it was given, and those instructions
	 * carry every heading with a `CLEAN or FOUND_ISSUES` placeholder under it. A reviewer
	 * that dies before answering must not inherit a verdict from the prompt that asked for one.
	 */
	const promptEcho = [
		"### Development Findings",
		"- `path:line [CRITICAL|HIGH|MEDIUM|LOW] RCI-### — implementation defect and impact`",
		"or `NONE`",
		"",
		"### Development Verdict",
		"CLEAN or FOUND_ISSUES",
	].join("\n");
	check("the prompt template is not a verdict", stageVerdict(promptEcho, "development"), null);
	check("the prompt template is not zero findings", stageFindings(promptEcho, "development"), null);

	const diedAfterPlanning = [
		promptEcho,
		"",
		"Now my review.",
		"",
		"### Planning Findings",
		"",
		"NONE",
		"",
		"### Planning Verdict",
		"",
		"CLEAN",
	].join("\n");
	check("a stage the reviewer answered still reads", stageVerdict(diedAfterPlanning, "planning"), "clean");
	check("a stage it never reached does not inherit the template's verdict", stageVerdict(diedAfterPlanning, "development"), null);
	check("nor the template's finding count", stageFindings(diedAfterPlanning, "development"), null);
	check("and the stage result is not clean", stageResult(diedAfterPlanning, "development"), { verdict: null, findings: null });

	for (const failure of failures) report(`review-transcript parser self-test failed: ${failure}`);
	return failures.length === 0;
}

module.exports = { stages, plain, section, scopeDigest, stageVerdict, stageFindings, coverage, stageResult, readTranscript, selfTest };

if (require.main === module) {
	if (!selfTest()) process.exit(1);
	process.stdout.write("request-contract review-transcript parser: PASS\n");
}
