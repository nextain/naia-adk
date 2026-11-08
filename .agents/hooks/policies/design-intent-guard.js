"use strict";

/**
 * Design-Change Upstream/Consumer Artifact Intent Recheck Policy (intent-guard).
 *
 * When a requirement file (.agents/requirements/*.yaml) changes its design
 * fields (or is deleted / retired), every artifact produced by or consumed
 * under that requirement must:
 *   (a) declare a machine-measurable intent test (condition + test_path) whose
 *       condition expresses a content/semantic metric comparison (not merely
 *       file existence, extension, byte size, or record/line count),
 *   (b) have the declared test_path exist inside the repository with real
 *       uncommented assertions on non-literal operands, the declared symbol in
 *       identifier/code position (outside comments and string literals),
 *       numeric thresholds matching the declared condition (outside comments
 *       and string literals), and actual artifact/stage inspection (not vacuous
 *       constant hardcoding), and
 *   (c) re-verify the intent test in the same change — the gate directly
 *       re-executes the declared test at check/commit time (requiring exit 0)
 *       and requires either the test file to be updated in the same change set
 *       or a committed/staged runner receipt (.agents/intent-receipts/<REQ>.json)
 *       whose design_sha256, test_sha256, artifact_sha256, and normalized
 *       output_sha256 match the gate's live test execution.
 *
 * Shell parsing reuses .claude/hooks/lib/git-command-parser.js and
 * .claude/hooks/lib/effective-argv.js (no duplicate shell tokenizer or git option sets).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const HOOKS_LIB_DIR = path.resolve(__dirname, "..", "..", "..", ".claude", "hooks", "lib");
const { shellClauses, findGitSubcommandArgv } = require(
	path.join(HOOKS_LIB_DIR, "git-command-parser.js"),
);
const { effectiveCommands, gitClauseDirectory } = require(
	path.join(HOOKS_LIB_DIR, "effective-argv.js"),
);

const REQ_PATH_RE = /(?:^|\/)\.agents\/requirements\/(?!_)[^/]+\.ya?ml$/;
const RUNNER_ID = "intent-guard-runner/v1";
const RECEIPT_PROOF_SALT = "naia-adk-intent-guard-receipt-v1";
const DEFAULT_RECEIPT_DIR = ".agents/intent-receipts";

const DESIGN_TOP_KEYS = new Set([
	"design",
	"design_spec",
	"design_intent",
	"description",
	"acceptance_criteria",
	"change_effect",
	"preserves",
	"must_not_change",
	"decisions",
]);

const ARTIFACT_SECTION_KEYS = [
	"artifacts",
	"upstream_artifacts",
	"consumed_artifacts",
	"produced_artifacts",
	"stage_artifacts",
];

function sha256Hex(input) {
	return crypto.createHash("sha256").update(String(input ?? ""), "utf8").digest("hex");
}

function normalizeTestOutput(stdout, stderr) {
	return `${stdout || ""}\n${stderr || ""}`
		.replace(/\r\n/g, "\n")
		.replace(/\(\d+(?:\.\d+)?ms\)/g, "(0ms)")
		.replace(/(\bduration_ms:?\s+)\d+(?:\.\d+)?/g, "$10")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim().length > 0)
		.join("\n");
}

function executeIntentTest(repoRoot, absTestPath) {
	const cleanEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
	delete cleanEnv.NODE_TEST_CONTEXT;
	const runRes = spawnSync(
		process.execPath,
		["--test", "--test-reporter=tap", absTestPath],
		{
			cwd: repoRoot,
			env: cleanEnv,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30000,
		},
	);
	const exitCode = typeof runRes.status === "number" ? runRes.status : 1;
	const normalizedOutput = normalizeTestOutput(runRes.stdout, runRes.stderr);
	const outputSha256 = sha256Hex(normalizedOutput);
	return {
		exitCode,
		stdout: runRes.stdout || "",
		stderr: runRes.stderr || "",
		outputSha256,
	};
}

function computeArtifactFingerprint(repoRoot, rawArtifactPath) {
	if (!rawArtifactPath || isPlaceholderValue(rawArtifactPath)) return "";
	const normPath = String(rawArtifactPath).replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normPath || normPath.startsWith("/") || normPath.startsWith("..") || normPath.includes("/../")) {
		return "";
	}
	const absPath = path.resolve(repoRoot, normPath);
	if (absPath !== repoRoot && !absPath.startsWith(repoRoot + path.sep)) return "";
	if (!fs.existsSync(absPath)) return "";
	try {
		const st = fs.statSync(absPath);
		if (!st.isFile()) return "";
		return sha256Hex(fs.readFileSync(absPath, "utf8"));
	} catch {
		return "";
	}
}

function computeReceiptProof({
	runner,
	reqId,
	artifactId,
	testPath,
	designSha256,
	testSha256,
	artifactSha256,
	exitCode,
	outputSha256,
	ranAt,
}) {
	const payload = [
		RECEIPT_PROOF_SALT,
		String(runner || ""),
		String(reqId || ""),
		String(artifactId || ""),
		String(testPath || ""),
		String(designSha256 || ""),
		String(testSha256 || ""),
		String(artifactSha256 || ""),
		String(exitCode ?? ""),
		String(outputSha256 || ""),
		String(ranAt || ""),
	].join("|");
	return sha256Hex(payload);
}

function unquoteYaml(val) {
	if (val == null) return "";
	const trimmed = String(val).trim();
	if (!trimmed) return "";
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	const commentIdx = trimmed.indexOf(" #");
	const withoutComment = commentIdx >= 0 ? trimmed.slice(0, commentIdx).trim() : trimmed;
	if (
		(withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
		(withoutComment.startsWith("'") && withoutComment.endsWith("'"))
	) {
		return withoutComment.slice(1, -1).trim();
	}
	return withoutComment;
}

function isPlaceholderValue(val) {
	if (val == null) return true;
	const s = String(val).trim();
	if (!s || s === "null" || s === "none" || s === "~" || s === "TODO" || s === "TBD") {
		return true;
	}
	if (/^\{[^}]+\}$/.test(s)) return true;
	return false;
}

const SUPERFICIAL_SUBJECT_EN_RE =
	/^(?:the\s+)?(?:file|files|artifact|artifacts|output|outputs|record|records|row|rows|line|lines|item|items|byte|bytes|dir|directory|folder|ext|extension|format|shape|size|count|length|exists?|existence|present|non[-_]?empty)(?:[\s_-]*(?:count|size|length|bytes?|number|total|exists?|existence|ext|extension|format|shape))?$/i;

const SUPERFICIAL_SUBJECT_KO_RE =
	/^(?:산출물|파일|출력|결과물|폴더|디렉터리|레코드|행|줄|항목|바이트|확장자|크기|개수|모양|형식|길이|존재|유무)?\s*(?:파일\s*)?(?:존재|유무|있음|생성|개수|수|크기|용량|바이트|확장자|모양|형식|길이)(?:\s*(?:가|이|은|는|의))?$/;

function isSuperficialSubject(rawSubject) {
	const subj = String(rawSubject || "")
		.trim()
		.replace(/^['"(\[]+|['")\]]+$/g, "")
		.trim();
	if (!subj) return true;
	if (SUPERFICIAL_SUBJECT_EN_RE.test(subj)) return true;
	if (SUPERFICIAL_SUBJECT_KO_RE.test(subj)) return true;
	return false;
}

/**
 * Determine whether a condition only checks superficial file shape/count/existence
 * rather than a content/semantic value metric with an explicit comparison operator
 * or quantitative threshold.
 */
function isShapeOrCountOnlyCondition(condition) {
	if (!condition || typeof condition !== "string") return true;
	const text = condition.trim();
	if (!text) return true;

	if (
		/(?:모양|개수|존재|유무|확장자|파일\s*크기|행\s*수|줄\s*수|레코드\s*개수)(?:[·,\s/]|과|와|및|이나)*\s*만\s*(?:확인|검사|검증|체크|본다|봄|측정)/.test(
			text,
		) ||
		/\b(?:file\s+shape|file\s+count|record\s+count|line\s+count|shape\s+and\s+count|existence\s+and\s+(?:record\s+)?count)\s+only\b/i.test(
			text,
		)
	) {
		return true;
	}

	const clauses = text
		.split(/\b(?:and|or)\b|&&|\|\||,|;|(?:\s+및\s+)|(?:\s*이고\s*)|(?:\s*이며\s*)/i)
		.map((c) => c.trim())
		.filter(Boolean);

	if (clauses.length === 0) return true;

	let hasContentMetricComparison = false;

	for (const clause of clauses) {
		const symMatch = clause.match(
			/^(.+?)\s*(<=|>=|===|!==|==|!=|<|>|=|±)\s*(['"][^'"]+['"]|-?\d+(?:\.\d+)?(?:\s*[A-Za-z%]+)?|\b(?:true|false|null)\b)\s*$/i,
		);
		if (symMatch) {
			const subject = symMatch[1].trim();
			const rhs = symMatch[3].trim();
			const isByteUnitOnly = /^-?\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|bytes?)$/i.test(rhs);
			if (!isSuperficialSubject(subject) && !(isByteUnitOnly && /크기|용량|size|byte/i.test(subject))) {
				hasContentMetricComparison = true;
			}
			continue;
		}

		const koBoundMatch = clause.match(
			/^(.+?)\s+(-?\d+(?:\.\d+)?(?:\s*[A-Za-z%개]*)?)\s*(?:이하|이상|미만|초과|이내|동일|일치)/,
		);
		if (koBoundMatch) {
			const subject = koBoundMatch[1].trim();
			if (!isSuperficialSubject(subject)) {
				hasContentMetricComparison = true;
			}
			continue;
		}
	}

	return !hasContentMetricComparison;
}

/**
 * Strip JS/TS/Python line and block comments while preserving string literals.
 */
function stripCodeComments(source) {
	if (!source || typeof source !== "string") return "";
	let out = "";
	let i = 0;
	let quote = null;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (quote) {
			out += ch;
			if (ch === "\\" && i + 1 < source.length) {
				out += source[++i];
			} else if (ch === quote) {
				quote = null;
			}
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			const nl = source.indexOf("\n", i + 2);
			if (nl < 0) break;
			i = nl;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) break;
			i = end + 2;
			continue;
		}
		if (ch === "#" && (i === 0 || source[i - 1] === "\n")) {
			const nl = source.indexOf("\n", i + 1);
			if (nl < 0) break;
			i = nl;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Mask string and template literals (`'...'`, `"..."`, `` `...` ``) to `""` so
 * symbol and numeric threshold checks inspect identifier/code positions only.
 */
function stripStringLiterals(code) {
	if (!code || typeof code !== "string") return "";
	let out = "";
	let i = 0;
	let quote = null;
	while (i < code.length) {
		const ch = code[i];
		if (quote) {
			if (ch === "\\" && i + 1 < code.length) {
				i += 2;
				continue;
			}
			if (ch === quote) {
				quote = null;
				out += '""';
			}
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			i++;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function extractConditionThresholds(condition) {
	if (!condition || typeof condition !== "string") return [];
	const matches = condition.match(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g) || [];
	return [...new Set(matches)];
}

function codeContainsNumericThreshold(codeWithoutStrings, numStr) {
	const targetNum = Number(numStr);
	const codeNums =
		codeWithoutStrings.match(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g) || [];
	if (codeNums.includes(numStr)) return true;
	if (!Number.isFinite(targetNum)) return false;
	return codeNums.some((tok) => Number(tok) === targetNum);
}

function isLiteralOnlyExpression(expr) {
	if (!expr || typeof expr !== "string") return true;
	const noStrings = stripStringLiterals(expr);
	const noObjKeys = noStrings.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\s*:/g, ":");
	const noKeywords = noObjKeys.replace(
		/\b(?:true|false|null|undefined|NaN|Infinity|void)\b/g,
		" ",
	);
	const noNumbers = noKeywords.replace(
		/(?<![A-Za-z_$])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?n?(?![A-Za-z_$])/gi,
		" ",
	);
	return !/[A-Za-z_$][A-Za-z0-9_$]*/.test(noNumbers);
}

function extractBalancedCallArgs(code, openParenIndex) {
	let depth = 0;
	let quote = null;
	const args = [];
	let cur = "";
	for (let i = openParenIndex; i < code.length; i++) {
		const ch = code[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && i + 1 < code.length) {
				cur += code[++i];
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			if (ch === "(" && depth === 0) {
				depth = 1;
				continue;
			}
			depth++;
			cur += ch;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (ch === ")" && depth === 0) {
				if (cur.trim()) args.push(cur.trim());
				return { args, closeParenIndex: i };
			}
			cur += ch;
			continue;
		}
		if (ch === "," && depth === 1) {
			args.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	return null;
}

/**
 * Verify that the test code contains at least one assertion whose tested operand(s)
 * are not purely constant/literal expressions (rejecting both `assert.ok(true)`
 * and multi-argument `assert.equal(1, 1)` / `assert.deepStrictEqual({}, {})`).
 */
function hasNonTautologicalAssertion(uncommentedCode) {
	const callRe = /\b(assert(?:\.([A-Za-z_]\w*))?|expect)\s*\(/g;
	let match;
	while ((match = callRe.exec(uncommentedCode)) !== null) {
		const fullName = match[1];
		const method = match[2] || "";
		const openParenIdx = match.index + match[0].length - 1;
		const parsed = extractBalancedCallArgs(uncommentedCode, openParenIdx);
		if (!parsed || parsed.args.length === 0) continue;

		if (fullName === "expect") {
			const subjectArg = parsed.args[0];
			const afterExpect = uncommentedCode.slice(parsed.closeParenIndex + 1);
			const matcherMatch = afterExpect.match(/^\s*\.\s*(?:not\s*\.\s*)?[A-Za-z_]\w*\s*\(/);
			let matcherArgs = [];
			if (matcherMatch) {
				const mOpen =
					parsed.closeParenIndex + 1 + matcherMatch.index + matcherMatch[0].length - 1;
				const mParsed = extractBalancedCallArgs(uncommentedCode, mOpen);
				if (mParsed) matcherArgs = mParsed.args;
			}
			const operands = [subjectArg, ...matcherArgs.slice(0, 1)];
			if (operands.some((op) => !isLiteralOnlyExpression(op))) {
				return true;
			}
			continue;
		}

		if (!method || method === "ok") {
			const expr = parsed.args[0];
			const binMatch = expr.match(/^(.+?)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/);
			if (binMatch && binMatch[1].trim() === binMatch[3].trim()) {
				continue;
			}
			if (!isLiteralOnlyExpression(expr)) {
				return true;
			}
			continue;
		}

		const testedOperands = parsed.args.slice(0, 2);
		if (
			testedOperands.length >= 2 &&
			testedOperands[0].trim() === testedOperands[1].trim()
		) {
			continue;
		}
		if (testedOperands.some((op) => !isLiteralOnlyExpression(op))) {
			return true;
		}
	}
	return false;
}

/**
 * Detect vacuous constant-hardcoded tests that never reference/read the declared
 * artifact (or stage) or that hardcode condition metric variables to literal constants.
 */
function checkVacuousConstantTest(uncommentedCode, artifact, condition) {
	const normArtPath = (artifact.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
	const artBasename = normArtPath ? path.posix.basename(normArtPath) : "";
	const artId = (artifact.id || "").trim();
	const artIdIdent = artId.replace(/[^A-Za-z0-9_]+/g, "_");
	const stageRaw = (artifact.stage || "").trim();
	const stageIdent = stageRaw.replace(/[^A-Za-z0-9_]+/g, "_");

	const candidateRefs = [
		normArtPath,
		artBasename.length >= 4 ? artBasename : "",
		artId.length >= 4 ? artId : "",
		artIdIdent.length >= 4 ? artIdIdent : "",
		stageRaw.length >= 4 && stageRaw !== "upstream" ? stageRaw : "",
		stageIdent.length >= 4 && stageIdent !== "upstream" ? stageIdent : "",
	].filter(Boolean);

	if (candidateRefs.length > 0 && !candidateRefs.some((ref) => uncommentedCode.includes(ref))) {
		return {
			vacuous: true,
			reason: `(b) 공허한 상수 시험 차단: 시험 파일 코드에 선언된 산출물 경로("${normArtPath || artId}") 또는 단계 식별자가 등장하지 않습니다(산출물을 실제로 읽거나 생성 함수를 호출해야 합니다).`,
		};
	}

	const metricIdents = (String(condition || "").match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []).filter(
		(tok) => !/^(?:and|or|true|false|null|in|not)$/i.test(tok) && Number.isNaN(Number(tok)),
	);
	for (const ident of metricIdents) {
		const constAssignRe = new RegExp(
			`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*(?:-?\\d+(?:\\.\\d+)?|['"][^'"]*['"]|true|false|null)\\s*(?:;|\\r?\\n)`,
		);
		if (constAssignRe.test(uncommentedCode)) {
			return {
				vacuous: true,
				reason: `(b) 공허한 상수 시험 차단: 조건 지표("${ident}")가 산출물에서 읽히지 않고 상수 리터럴로 직접 하드코딩되어 있습니다.`,
			};
		}
	}

	return { vacuous: false };
}

/**
 * Parse top-level blocks of a requirement YAML file.
 */
function parseTopLevelBlocks(yamlText) {
	const blocks = new Map();
	if (!yamlText || typeof yamlText !== "string") return blocks;
	const lines = yamlText.split(/\r?\n/);
	let currentKey = null;
	for (const line of lines) {
		if (/^\s*(?:#.*)?$/.test(line)) {
			if (currentKey) blocks.get(currentKey).lines.push(line);
			continue;
		}
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
		if (match) {
			currentKey = match[1];
			blocks.set(currentKey, {
				inline: match[2].trim(),
				lines: [],
			});
			continue;
		}
		if (currentKey) {
			blocks.get(currentKey).lines.push(line);
		}
	}
	return blocks;
}

function parseInlineObject(inlineText) {
	const trimmed = inlineText.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return {};
	const result = {};
	const parts = [];
	let cur = "";
	let quote = null;
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && i + 1 < inner.length) cur += inner[++i];
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) parts.push(cur.trim());
	for (const part of parts) {
		const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (!m) continue;
		const k = m[1];
		const v = m[2].trim();
		if (v.startsWith("{") && v.endsWith("}")) {
			result[k] = parseInlineObject(v);
		} else {
			result[k] = unquoteYaml(v);
		}
	}
	return result;
}

function parseArtifactItemLines(itemLines) {
	const obj = {};
	let subSection = null;
	let subList = null;

	for (let i = 0; i < itemLines.length; i++) {
		const raw = itemLines[i];
		if (/^\s*(?:#.*)?$/.test(raw)) continue;

		const indentMatch = raw.match(/^(\s*)(.*)$/);
		const indent = indentMatch ? indentMatch[1].length : 0;
		const content = indentMatch ? indentMatch[2].trim() : raw.trim();

		if (subSection && content.startsWith("- ")) {
			const rest = content.slice(2).trim();
			if (!subList) subList = [];
			if (rest.startsWith("{") && rest.endsWith("}")) {
				const parsedInline = parseInlineObject(rest);
				if (parsedInline) subList.push(parsedInline);
			} else {
				const kv = rest.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
				const entry = {};
				if (kv) entry[kv[1]] = unquoteYaml(kv[2]);
				subList.push(entry);
			}
			obj[subSection] = subList;
			continue;
		}

		const kv = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (!kv) continue;
		const key = kv[1];
		const val = kv[2].trim();

		if (
			(key === "intent_test" || key === "intent_tests") &&
			(!val || val === "|" || val === ">")
		) {
			subSection = key;
			subList = null;
			obj[key] = {};
			continue;
		}

		if (
			(key === "intent_test" || key === "intent_tests") &&
			val.startsWith("{") &&
			val.endsWith("}")
		) {
			subSection = null;
			obj[key] = parseInlineObject(val);
			continue;
		}

		if (subSection && indent >= 6) {
			if (Array.isArray(obj[subSection]) && obj[subSection].length > 0) {
				obj[subSection][obj[subSection].length - 1][key] = unquoteYaml(val);
			} else {
				if (!obj[subSection] || typeof obj[subSection] !== "object") {
					obj[subSection] = {};
				}
				obj[subSection][key] = unquoteYaml(val);
			}
			continue;
		}

		subSection = null;
		obj[key] = unquoteYaml(val);
	}

	return normalizeArtifactEntry(obj);
}

function normalizeArtifactEntry(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = raw.id || raw.name || raw.artifact || raw.path || raw.output || "";
	const artifactPath = raw.path || raw.artifact_path || raw.output || raw.file || raw.id || "";
	const stage = raw.stage || raw.role || raw.producer || "upstream";
	const requirementRef = raw.requirement || raw.req_id || "";

	let intentTests = [];
	if (Array.isArray(raw.intent_tests)) {
		intentTests = raw.intent_tests.map((t) => ({
			condition: t.condition || t.assertion || t.criteria || t.invariant || t.expect || "",
			test_path: t.test_path || t.path || t.file || t.test_file || t.test || "",
			symbol: t.symbol || "",
			receipt: t.receipt || t.receipt_path || "",
		}));
	} else if (raw.intent_test && typeof raw.intent_test === "object") {
		const t = raw.intent_test;
		intentTests.push({
			condition: t.condition || t.assertion || t.criteria || t.invariant || t.expect || "",
			test_path: t.test_path || t.path || t.file || t.test_file || t.test || "",
			symbol: t.symbol || "",
			receipt: t.receipt || t.receipt_path || "",
		});
	} else if (
		raw.condition ||
		raw.intent_condition ||
		raw.test_path ||
		raw.intent_test_path ||
		raw.test_file
	) {
		intentTests.push({
			condition:
				raw.condition || raw.intent_condition || raw.assertion || raw.criteria || "",
			test_path: raw.test_path || raw.intent_test_path || raw.test_file || "",
			symbol: raw.symbol || raw.test_symbol || "",
			receipt: raw.receipt || raw.receipt_path || "",
		});
	}

	return {
		id: String(id).trim(),
		path: String(artifactPath).trim(),
		stage: String(stage).trim(),
		requirementRef: String(requirementRef).trim(),
		intentTests,
	};
}

function parseArtifactsFromBlock(block) {
	if (!block) return [];
	const inline = (block.inline || "").trim();
	if (inline === "[]" || inline === "null" || inline === "~") return [];

	const items = [];
	let currentItemLines = null;

	for (const line of block.lines || []) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const listMatch = line.match(/^(\s*)-\s+(.*)$/);
		if (listMatch && listMatch[1].length <= 4) {
			if (currentItemLines && currentItemLines.length > 0) {
				const parsed = parseArtifactItemLines(currentItemLines);
				if (parsed) items.push(parsed);
			}
			const rest = listMatch[2].trim();
			if (rest.startsWith("{") && rest.endsWith("}")) {
				const inlineObj = parseInlineObject(rest);
				const parsed = normalizeArtifactEntry(inlineObj);
				if (parsed) items.push(parsed);
				currentItemLines = null;
			} else {
				currentItemLines = [`    ${rest}`];
			}
			continue;
		}
		if (currentItemLines) {
			currentItemLines.push(line);
		}
	}

	if (currentItemLines && currentItemLines.length > 0) {
		const parsed = parseArtifactItemLines(currentItemLines);
		if (parsed) items.push(parsed);
	}

	return items;
}

/**
 * Parse a requirement YAML document into its id, status, design digest, and declared artifacts.
 */
function parseRequirementDocument(yamlText, fallbackId = "") {
	const blocks = parseTopLevelBlocks(yamlText);
	const rawId = blocks.has("id") ? unquoteYaml(blocks.get("id").inline) : fallbackId;
	const id = rawId || fallbackId;
	const status = blocks.has("status") ? unquoteYaml(blocks.get("status").inline).toLowerCase() : "";

	const artifacts = [];
	for (const key of ARTIFACT_SECTION_KEYS) {
		if (blocks.has(key)) {
			artifacts.push(...parseArtifactsFromBlock(blocks.get(key)));
		}
	}

	const designParts = [];
	for (const key of [...DESIGN_TOP_KEYS].sort()) {
		if (!blocks.has(key)) continue;
		const b = blocks.get(key);
		const normalizedLines = (b.lines || [])
			.map((l) => l.replace(/#.*$/, "").trimRight())
			.filter((l) => l.trim().length > 0);
		designParts.push(`${key}:${unquoteYaml(b.inline)}\n${normalizedLines.join("\n")}`);
	}

	const artifactDesignParts = artifacts.map((a) => ({
		id: a.id,
		path: a.path,
		stage: a.stage,
		conditions: a.intentTests.map((t) => ({
			condition: t.condition,
			test_path: t.test_path,
			symbol: t.symbol,
		})),
	}));
	designParts.push(`artifacts:${JSON.stringify(artifactDesignParts)}`);

	const hasExplicitDesignFields =
		[...DESIGN_TOP_KEYS].some((k) => blocks.has(k)) || artifacts.length > 0;
	const designDigest = sha256Hex(designParts.join("\n---\n"));
	const fullDigest = sha256Hex(String(yamlText || ""));

	return {
		id,
		status,
		blocks,
		artifacts,
		hasExplicitDesignFields,
		designDigest,
		fullDigest,
	};
}

/**
 * Validate whether a single artifact's intent test satisfies (a), (b), and (c).
 */
function evaluateArtifactIntent({
	reqId,
	reqRelPath,
	artifact,
	repoRoot,
	activeChangedFiles,
	readNewFileContent,
	designDigest,
	fullDigest,
}) {
	const artifactLabel =
		artifact.id && artifact.path && artifact.id !== artifact.path
			? `${artifact.id} (${artifact.path})`
			: artifact.id || artifact.path || "(이름 없는 산출물)";

	// (a) Intent test must be declared with a non-placeholder, content-metric condition and test_path
	if (!artifact.intentTests || artifact.intentTests.length === 0) {
		return {
			ok: false,
			code: "missing_intent_test",
			reqId,
			reqRelPath,
			artifactLabel,
			artifact,
			reason: "(a) 의도 시험 미기재: 기계로 재는 조건(condition)과 시험 파일 경로(test_path)가 없습니다.",
		};
	}

	for (const testSpec of artifact.intentTests) {
		const cond = (testSpec.condition || "").trim();
		const rawTestPath = (testSpec.test_path || "").trim();

		if (isPlaceholderValue(cond) || isPlaceholderValue(rawTestPath)) {
			return {
				ok: false,
				code: "missing_intent_test",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: "(a) 의도 시험 미기재: condition 또는 test_path가 비어 있거나 템플릿 자리표시자 상태입니다.",
			};
		}

		if (isShapeOrCountOnlyCondition(cond)) {
			return {
				ok: false,
				code: "shape_or_count_only_test",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(a) 의도 시험 부적격(파일 모양·개수만 보는 시험): "${cond}" — 산출물 내용 지표와 비교 연산자(<=, >=, == 등)를 포함한 기계적 의미 조건을 적으세요.`,
			};
		}

		const normTestPath = rawTestPath.replace(/\\/g, "/").replace(/^\.\//, "");
		if (
			!normTestPath ||
			normTestPath.startsWith("/") ||
			normTestPath.startsWith("..") ||
			normTestPath.includes("/../")
		) {
			return {
				ok: false,
				code: "invalid_test_path",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일 경로 부적격: "${rawTestPath}" (저장소 내부 상대 경로여야 합니다).`,
			};
		}

		const absTestPath = path.resolve(repoRoot, normTestPath);
		if (absTestPath !== repoRoot && !absTestPath.startsWith(repoRoot + path.sep)) {
			return {
				ok: false,
				code: "invalid_test_path",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일 경로가 저장소 밖을 가리킵니다: "${rawTestPath}".`,
			};
		}

		if (!fs.existsSync(absTestPath)) {
			return {
				ok: false,
				code: "missing_test_file",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 실제 파일 없음: "${normTestPath}" 파일이 존재하지 않습니다.`,
			};
		}

		let stat;
		try {
			const realTest = fs.realpathSync(absTestPath);
			const realRoot = fs.realpathSync(repoRoot);
			if (realTest !== realRoot && !realTest.startsWith(realRoot + path.sep)) {
				return {
					ok: false,
					code: "invalid_test_path",
					reqId,
					reqRelPath,
					artifactLabel,
					artifact,
					reason: `(b) 의도 시험 심볼릭 링크가 저장소 밖을 가리킵니다: "${normTestPath}".`,
				};
			}
			stat = fs.statSync(realTest);
		} catch {
			return {
				ok: false,
				code: "missing_test_file",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일을 읽을 수 없습니다: "${normTestPath}".`,
			};
		}

		if (!stat.isFile() || stat.size === 0) {
			return {
				ok: false,
				code: "missing_test_file",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일이 비어 있거나 일반 파일이 아닙니다: "${normTestPath}".`,
			};
		}

		const testContent = fs.readFileSync(absTestPath, "utf8");
		const uncommentedCode = stripCodeComments(testContent);
		if (!uncommentedCode.trim()) {
			return {
				ok: false,
				code: "missing_test_file",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일("${normTestPath}")에 주석을 제외한 실제 실행 코드가 없습니다.`,
			};
		}

		const codeWithoutStrings = stripStringLiterals(uncommentedCode);

		// [보통-P2a] Symbol must appear outside comments AND outside string literals (unless symbol itself contains spaces, in which case require identifier or uncommented match)
		if (testSpec.symbol && !isPlaceholderValue(testSpec.symbol)) {
			const sym = testSpec.symbol.trim();
			const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sym);
			const hasSym = isIdentifier
				? codeWithoutStrings.includes(sym)
				: uncommentedCode.includes(sym);
			if (!hasSym) {
				return {
					ok: false,
					code: "missing_test_symbol",
					reqId,
					reqRelPath,
					artifactLabel,
					artifact,
					reason: `(b) 의도 시험 파일("${normTestPath}")의 실제 식별자 코드(주석·문자열 리터럴 제외)에 선언된 시험 심볼("${sym}")이 없습니다.`,
				};
			}
		}

		// [보통-P2b] Reject single-arg and multi-arg constant-to-constant tautological assertions
		if (!hasNonTautologicalAssertion(uncommentedCode)) {
			return {
				ok: false,
				code: "weak_test_assertion",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일("${normTestPath}")에 실제 산출물 지표를 검증하는 단언문(assert/expect)이 없거나 상수-상수 동어반복 단언뿐입니다.`,
			};
		}

		// [보통-P3a] Numeric thresholds from condition must appear outside comments AND outside string literals
		const thresholds = extractConditionThresholds(cond);
		for (const numStr of thresholds) {
			if (!codeContainsNumericThreshold(codeWithoutStrings, numStr)) {
				return {
					ok: false,
					code: "condition_threshold_mismatch",
					reqId,
					reqRelPath,
					artifactLabel,
					artifact,
					reason: `(b) 의도 시험 내용 불일치: 조건("${cond}")의 수치 기준값("${numStr}")이 시험 파일("${normTestPath}")의 실제 코드(주석·문자열 리터럴 제외)에 없습니다.`,
				};
			}
		}

		// [보통-R3] Reject vacuous constant-hardcoded tests that never reference/read the artifact
		const vacuousCheck = checkVacuousConstantTest(uncommentedCode, artifact, cond);
		if (vacuousCheck.vacuous) {
			return {
				ok: false,
				code: "vacuous_constant_test",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: vacuousCheck.reason,
			};
		}

		const actualTestSha256 = sha256Hex(testContent);
		const actualArtifactSha256 = computeArtifactFingerprint(repoRoot, artifact.path);

		// (c) Must be re-verified in the same change AND pass live gate execution:
		const testChangedInSameChange = activeChangedFiles.has(normTestPath);
		const receiptCheck = verifyIntentReceipt({
			repoRoot,
			reqId,
			artifact,
			testSpec,
			normTestPath,
			absTestPath,
			actualTestSha256,
			actualArtifactSha256,
			activeChangedFiles,
			readNewFileContent,
			designDigest,
			fullDigest,
		});

		if (!testChangedInSameChange && !receiptCheck.ok) {
			return {
				ok: false,
				code: "test_not_rerun",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason:
					`(c) 설계 변경 후 의도 시험 미실행: 같은 변경에서 시험 파일("${normTestPath}")이 갱신되지 않았고 ` +
					`유효한 시험 영수증도 없습니다${receiptCheck.detail ? ` (${receiptCheck.detail})` : ""}.`,
			};
		}

		// [심각-R1] Even when test_path was updated in the same change set without a receipt,
		// the gate directly executes test_path at commit/check time and requires exitCode === 0.
		if (testChangedInSameChange && !receiptCheck.ok) {
			const liveRun = executeIntentTest(repoRoot, absTestPath);
			if (liveRun.exitCode !== 0) {
				return {
					ok: false,
					code: "test_execution_failed",
					reqId,
					reqRelPath,
					artifactLabel,
					artifact,
					reason: `(c) 의도 시험 실행 실패: 관문이 커밋/검사 시점에 "${normTestPath}" 시험을 직접 실행했으나 실패했습니다 (exit_code=${liveRun.exitCode}).`,
				};
			}
		}
	}

	return {
		ok: true,
		reqId,
		reqRelPath,
		artifactLabel,
		artifact,
	};
}

function verifyIntentReceipt({
	repoRoot,
	reqId,
	artifact,
	testSpec,
	normTestPath,
	absTestPath,
	actualTestSha256,
	actualArtifactSha256,
	activeChangedFiles,
	readNewFileContent,
	designDigest,
	fullDigest,
}) {
	const candidates = [];
	if (testSpec.receipt && !isPlaceholderValue(testSpec.receipt)) {
		candidates.push(testSpec.receipt.replace(/\\/g, "/").replace(/^\.\//, ""));
	}
	if (reqId) {
		candidates.push(`${DEFAULT_RECEIPT_DIR}/${reqId}.json`);
	}
	if (artifact.id && !isPlaceholderValue(artifact.id)) {
		candidates.push(`${DEFAULT_RECEIPT_DIR}/${artifact.id}.json`);
	}
	candidates.push(".agents/intent-receipts.json");
	if (reqId) {
		candidates.push(`.agents/progress/intent-receipts/${reqId}.json`);
	}

	let lastDetail = "";
	for (const relReceipt of candidates) {
		if (
			!relReceipt ||
			relReceipt.startsWith("/") ||
			relReceipt.startsWith("..") ||
			relReceipt.includes("/../")
		) {
			continue;
		}
		const absReceipt = path.resolve(repoRoot, relReceipt);
		if (absReceipt !== repoRoot && !absReceipt.startsWith(repoRoot + path.sep)) continue;

		let rawReceiptText = null;
		if (typeof readNewFileContent === "function") {
			rawReceiptText = readNewFileContent(relReceipt);
		}
		if (rawReceiptText == null && fs.existsSync(absReceipt)) {
			try {
				rawReceiptText = fs.readFileSync(absReceipt, "utf8");
			} catch {
				rawReceiptText = null;
			}
		}

		if (rawReceiptText == null) {
			if (
				testSpec.receipt &&
				relReceipt === testSpec.receipt.replace(/\\/g, "/").replace(/^\.\//, "")
			) {
				lastDetail = `영수증 파일 없음: ${relReceipt}`;
			}
			continue;
		}

		let parsed;
		try {
			parsed = JSON.parse(rawReceiptText);
		} catch {
			lastDetail = `영수증 JSON 파싱 실패: ${relReceipt}`;
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;

		let targetEntry = parsed;
		if (
			Array.isArray(parsed.artifacts) ||
			Array.isArray(parsed.results) ||
			Array.isArray(parsed.receipts)
		) {
			const list = parsed.artifacts || parsed.results || parsed.receipts;
			const matched = list.find(
				(item) =>
					item &&
					(item.artifact_id === artifact.id ||
						item.id === artifact.id ||
						item.path === artifact.path ||
						item.test_path === normTestPath),
			);
			if (!matched) {
				lastDetail = `영수증(${relReceipt})에 산출물(${artifact.id || artifact.path}) 항목 없음`;
				continue;
			}
			targetEntry = { ...parsed, ...matched };
		}

		const statusVal = String(
			targetEntry.status ?? targetEntry.result ?? targetEntry.verdict ?? "",
		).toLowerCase();
		const passedBool =
			targetEntry.passed === true ||
			targetEntry.ok === true ||
			statusVal === "pass" ||
			statusVal === "passed";
		const failedBool =
			targetEntry.passed === false ||
			targetEntry.ok === false ||
			statusVal === "fail" ||
			statusVal === "failed" ||
			statusVal === "error" ||
			statusVal === "blocked";

		if (!passedBool || failedBool) {
			lastDetail = `영수증(${relReceipt}) 판정이 통과(pass)가 아님`;
			continue;
		}

		if (
			targetEntry.test_path &&
			targetEntry.test_path.replace(/\\/g, "/").replace(/^\.\//, "") !== normTestPath
		) {
			lastDetail = `영수증(${relReceipt})의 test_path가 ${normTestPath}와 다름`;
			continue;
		}

		const recordedDigest =
			targetEntry.design_sha256 ||
			targetEntry.req_sha256 ||
			targetEntry.requirement_sha256 ||
			parsed.design_sha256 ||
			parsed.req_sha256 ||
			parsed.requirement_sha256 ||
			null;

		if (!recordedDigest) {
			lastDetail = `영수증(${relReceipt})에 설계 해시(design_sha256)가 없음`;
			continue;
		}

		const cleanDigest = String(recordedDigest).replace(/^sha256:/, "");
		if (cleanDigest !== designDigest && cleanDigest !== fullDigest) {
			lastDetail = `영수증(${relReceipt})의 설계 해시가 현재 설계와 불일치(이전 설계 영수증)`;
			continue;
		}

		// [보통-R2] Receipt file must not be in gitignored .agents/progress/ and must be included in the same change set
		if (relReceipt.startsWith(".agents/progress/")) {
			lastDetail = `영수증(${relReceipt})이 gitignore 경로(.agents/progress/)에 있어 커밋·CI 재현이 불가합니다(.agents/intent-receipts/ 경로를 사용하세요)`;
			continue;
		}
		if (activeChangedFiles && !activeChangedFiles.has(relReceipt)) {
			lastDetail = `영수증 파일(${relReceipt})이 같은 변경 집합(스테이지/커밋)에 포함되지 않음 (git add ${relReceipt} 후 커밋하세요)`;
			continue;
		}

		const runner = targetEntry.runner || parsed.runner || "";
		const exitCode = targetEntry.exit_code;
		const ranAt = targetEntry.ran_at || parsed.ran_at || "";
		const outputSha256 = targetEntry.output_sha256 || "";
		const recordedTestSha256 = String(targetEntry.test_sha256 || "").replace(/^sha256:/, "");
		const recordedArtifactSha256 = String(targetEntry.artifact_sha256 || "").replace(
			/^sha256:/,
			"",
		);
		const recordedProof = String(targetEntry.run_proof || "");

		if (runner !== RUNNER_ID || exitCode !== 0 || !ranAt || !/^[a-f0-9]{64}$/.test(outputSha256)) {
			lastDetail = `영수증(${relReceipt})에 실행기 증명(runner/exit_code: 0/output_sha256)이 없음(수기 영수증 차단 — --run-tests로 생성하세요)`;
			continue;
		}

		if (!recordedTestSha256 || recordedTestSha256 !== actualTestSha256) {
			lastDetail = `영수증(${relReceipt})의 시험 파일 해시(test_sha256)가 현재 시험 파일("${normTestPath}")과 불일치`;
			continue;
		}

		if (
			actualArtifactSha256 &&
			recordedArtifactSha256 &&
			recordedArtifactSha256 !== actualArtifactSha256
		) {
			lastDetail = `영수증(${relReceipt})의 산출물 파일 해시(artifact_sha256)가 현재 산출물("${artifact.path}")과 불일치`;
			continue;
		}

		const expectedProof = computeReceiptProof({
			runner,
			reqId: targetEntry.requirement_id || parsed.requirement_id || reqId,
			artifactId: targetEntry.artifact_id || artifact.id,
			testPath: normTestPath,
			designSha256: cleanDigest,
			testSha256: recordedTestSha256,
			artifactSha256: recordedArtifactSha256,
			exitCode,
			outputSha256,
			ranAt,
		});

		if (!recordedProof || recordedProof !== expectedProof) {
			lastDetail = `영수증(${relReceipt})의 실행 증명(run_proof) 검증 실패(수기 위조 차단)`;
			continue;
		}

		// [심각-R1] Gate directly re-executes the declared test at verification/commit time
		// and verifies both exitCode === 0 and normalized output_sha256 parity.
		const liveRun = executeIntentTest(repoRoot, absTestPath);
		if (liveRun.exitCode !== 0) {
			lastDetail = `관문이 "${normTestPath}" 시험을 직접 재실행했으나 실패함 (exit_code=${liveRun.exitCode})`;
			continue;
		}
		if (outputSha256 !== liveRun.outputSha256) {
			lastDetail = `영수증(${relReceipt})의 실행 출력 지문(output_sha256)이 관문 직접 실행 출력과 불일치(공개값 재계산 위조 차단)`;
			continue;
		}

		return { ok: true, receiptPath: relReceipt };
	}

	return { ok: false, detail: lastDetail };
}

/**
 * Execute declared intent tests for requirement files and write verified receipts
 * to the committable `.agents/intent-receipts/<REQ-ID>.json` path.
 */
function runRequirementIntentTests(repoRoot, options = {}) {
	const resolvedRoot = resolveGitRepoRoot(repoRoot) || path.resolve(repoRoot || process.cwd());
	const reqDir = path.join(resolvedRoot, ".agents", "requirements");
	if (!fs.existsSync(reqDir)) {
		return { ok: true, receiptsWritten: [] };
	}

	const filterReqId = options.reqId ? String(options.reqId).trim() : null;
	const receiptsWritten = [];
	const failures = [];

	const entries = fs.readdirSync(reqDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || entry.name.startsWith("_") || !/\.ya?ml$/i.test(entry.name)) continue;
		const relPath = `.agents/requirements/${entry.name}`;
		const absPath = path.join(resolvedRoot, relPath);
		const content = fs.readFileSync(absPath, "utf8");
		const fallbackId = entry.name.replace(/\.ya?ml$/i, "");
		const doc = parseRequirementDocument(content, fallbackId);
		if (filterReqId && doc.id !== filterReqId && fallbackId !== filterReqId) continue;
		if (!doc.artifacts || doc.artifacts.length === 0) continue;

		const artifactReceipts = [];
		const isoNow = new Date().toISOString();

		for (const artifact of doc.artifacts) {
			for (const testSpec of artifact.intentTests || []) {
				const rawTestPath = (testSpec.test_path || "").trim();
				if (isPlaceholderValue(rawTestPath)) continue;
				const normTestPath = rawTestPath.replace(/\\/g, "/").replace(/^\.\//, "");
				const absTestPath = path.resolve(resolvedRoot, normTestPath);
				if (!fs.existsSync(absTestPath)) {
					failures.push({
						reqId: doc.id,
						artifactId: artifact.id,
						testPath: normTestPath,
						reason: `Test file does not exist: ${normTestPath}`,
					});
					continue;
				}

				const testContent = fs.readFileSync(absTestPath, "utf8");
				const testSha256 = sha256Hex(testContent);
				const artifactSha256 = computeArtifactFingerprint(resolvedRoot, artifact.path);
				const liveRun = executeIntentTest(resolvedRoot, absTestPath);
				const exitCode = liveRun.exitCode;
				const outputSha256 = liveRun.outputSha256;
				const status = exitCode === 0 ? "pass" : "fail";
				const runProof = computeReceiptProof({
					runner: RUNNER_ID,
					reqId: doc.id,
					artifactId: artifact.id,
					testPath: normTestPath,
					designSha256: doc.designDigest,
					testSha256,
					artifactSha256,
					exitCode,
					outputSha256,
					ranAt: isoNow,
				});

				const itemReceipt = {
					requirement_id: doc.id,
					artifact_id: artifact.id,
					path: artifact.path,
					test_path: normTestPath,
					status,
					exit_code: exitCode,
					design_sha256: doc.designDigest,
					test_sha256: testSha256,
					artifact_sha256: artifactSha256,
					output_sha256: outputSha256,
					ran_at: isoNow,
					runner: RUNNER_ID,
					run_proof: runProof,
				};
				artifactReceipts.push(itemReceipt);

				if (exitCode !== 0) {
					failures.push({
						reqId: doc.id,
						artifactId: artifact.id,
						testPath: normTestPath,
						exitCode,
						reason: (liveRun.stderr || liveRun.stdout || "Test execution failed").trim(),
					});
				}
			}
		}

		if (artifactReceipts.length > 0) {
			const receiptDir = path.join(resolvedRoot, DEFAULT_RECEIPT_DIR);
			fs.mkdirSync(receiptDir, { recursive: true });
			const receiptPath = path.join(receiptDir, `${doc.id}.json`);
			const receiptPayload = {
				runner: RUNNER_ID,
				requirement_id: doc.id,
				design_sha256: doc.designDigest,
				req_sha256: doc.fullDigest,
				ran_at: isoNow,
				status: artifactReceipts.every((r) => r.exit_code === 0) ? "pass" : "fail",
				artifacts: artifactReceipts,
			};
			fs.writeFileSync(receiptPath, JSON.stringify(receiptPayload, null, 2) + "\n", "utf8");
			receiptsWritten.push(path.relative(resolvedRoot, receiptPath).replace(/\\/g, "/"));
		}
	}

	return {
		ok: failures.length === 0,
		receiptsWritten,
		failures,
	};
}

function runGit(repoRoot, args) {
	return spawnSync("git", ["-c", "core.quotePath=false", "-C", repoRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 5000,
	});
}

function resolveGitRepoRoot(startDir) {
	let probe = path.resolve(startDir || process.cwd());
	while (probe && !fs.existsSync(probe)) {
		const parent = path.dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	const res = spawnSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5000,
	});
	if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return null;
	const rawTop = res.stdout.trim();
	try {
		return fs.realpathSync.native ? fs.realpathSync.native(rawTop) : fs.realpathSync(rawTop);
	} catch {
		return path.resolve(rawTop);
	}
}

function parseNullSeparatedPaths(stdout) {
	if (!stdout) return [];
	return stdout
		.split("\0")
		.map((s) => s.trim().replace(/\\/g, "/"))
		.filter(Boolean);
}

function readGitBlob(repoRoot, revSpec) {
	const res = runGit(repoRoot, ["show", revSpec]);
	if (res.status !== 0) return null;
	return res.stdout;
}

/**
 * Inspect a repository for requirement design changes and verify all associated
 * upstream/produced artifacts' intent tests.
 */
function checkRepositoryDesignIntent(repoRoot, options = {}) {
	const resolvedRoot = resolveGitRepoRoot(repoRoot);
	if (!resolvedRoot) return { ok: true, violations: [] };

	const reqDir = path.join(resolvedRoot, ".agents", "requirements");
	const mode = options.mode || "auto";

	let candidateChangedFiles;
	let activeChangedFiles;
	let readNewFileContent;
	let readOldFileContent;

	const hasHeadRes = runGit(resolvedRoot, ["rev-parse", "--verify", "HEAD"]);
	const hasHead = hasHeadRes.status === 0;

	if (mode === "commit") {
		const rev = options.commitRev || "HEAD";
		const parentRes = runGit(resolvedRoot, ["rev-parse", "--verify", `${rev}^`]);
		const hasParent = parentRes.status === 0;
		const commitChanged = hasParent
			? parseNullSeparatedPaths(
					runGit(resolvedRoot, [
						"diff-tree",
						"--no-renames",
						"--no-commit-id",
						"--name-only",
						"-r",
						"-z",
						rev,
					]).stdout,
				)
			: parseNullSeparatedPaths(
					runGit(resolvedRoot, ["ls-tree", "--name-only", "-r", "-z", rev]).stdout,
				);
		candidateChangedFiles = new Set(commitChanged);
		activeChangedFiles = candidateChangedFiles;
		readNewFileContent = (relPath) => readGitBlob(resolvedRoot, `${rev}:${relPath}`);
		readOldFileContent = (relPath) =>
			hasParent ? readGitBlob(resolvedRoot, `${rev}^:${relPath}`) : null;
	} else {
		const stagedFiles = new Set(
			parseNullSeparatedPaths(
				runGit(resolvedRoot, ["diff", "--cached", "--no-renames", "--name-only", "-z"]).stdout,
			),
		);
		const normalizedExplicit = Array.isArray(options.explicitPaths)
			? options.explicitPaths
					.map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, ""))
					.filter(Boolean)
			: [];

		if (mode === "explicit") {
			candidateChangedFiles = new Set(normalizedExplicit);
			activeChangedFiles = new Set([...stagedFiles, ...normalizedExplicit]);
			readNewFileContent = (relPath) => {
				const abs = path.resolve(resolvedRoot, relPath);
				if (!fs.existsSync(abs)) return null;
				try {
					return fs.readFileSync(abs, "utf8");
				} catch {
					return null;
				}
			};
		} else if (
			mode === "staged" ||
			(mode === "auto" && !options.includeWorktree && stagedFiles.size > 0)
		) {
			candidateChangedFiles = new Set(stagedFiles);
			for (const p of normalizedExplicit) candidateChangedFiles.add(p);
			activeChangedFiles = candidateChangedFiles;
			readNewFileContent = (relPath) => {
				if (stagedFiles.has(relPath)) {
					const indexBlob = readGitBlob(resolvedRoot, `:${relPath}`);
					if (indexBlob !== null) return indexBlob;
				}
				const abs = path.resolve(resolvedRoot, relPath);
				if (!fs.existsSync(abs)) return null;
				try {
					return fs.readFileSync(abs, "utf8");
				} catch {
					return null;
				}
			};
		} else if (mode === "tracked-worktree") {
			const unstagedFiles = new Set(
				parseNullSeparatedPaths(runGit(resolvedRoot, ["diff", "--name-only", "-z"]).stdout),
			);
			candidateChangedFiles = new Set([...stagedFiles, ...unstagedFiles, ...normalizedExplicit]);
			activeChangedFiles = candidateChangedFiles;
			readNewFileContent = (relPath) => {
				const abs = path.resolve(resolvedRoot, relPath);
				if (!fs.existsSync(abs)) return null;
				try {
					return fs.readFileSync(abs, "utf8");
				} catch {
					return null;
				}
			};
		} else {
			const unstagedFiles = new Set(
				parseNullSeparatedPaths(runGit(resolvedRoot, ["diff", "--name-only", "-z"]).stdout),
			);
			const untrackedFiles = new Set(
				parseNullSeparatedPaths(
					runGit(resolvedRoot, [
						"ls-files",
						"--others",
						"--exclude-standard",
						"-z",
						"--",
						".agents/requirements",
						".agents/intent-receipts",
						"tests",
						"test",
					]).stdout,
				),
			);
			candidateChangedFiles = new Set([
				...stagedFiles,
				...unstagedFiles,
				...untrackedFiles,
				...normalizedExplicit,
			]);
			activeChangedFiles = candidateChangedFiles;
			readNewFileContent = (relPath) => {
				const abs = path.resolve(resolvedRoot, relPath);
				if (!fs.existsSync(abs)) return null;
				try {
					return fs.readFileSync(abs, "utf8");
				} catch {
					return null;
				}
			};
		}

		readOldFileContent = (relPath) => {
			if (!hasHead) return null;
			return readGitBlob(resolvedRoot, `HEAD:${relPath}`);
		};
	}

	const changedReqPaths = [...candidateChangedFiles].filter((f) => REQ_PATH_RE.test(f)).sort();
	if (changedReqPaths.length === 0) {
		return { ok: true, violations: [] };
	}

	const allReqDocs = new Map();
	if (fs.existsSync(reqDir)) {
		try {
			for (const entry of fs.readdirSync(reqDir, { withFileTypes: true })) {
				if (!entry.isFile() || entry.name.startsWith("_") || !/\.ya?ml$/i.test(entry.name)) continue;
				const relPath = `.agents/requirements/${entry.name}`;
				const content = readNewFileContent(relPath);
				if (content != null) {
					const fallbackId = entry.name.replace(/\.ya?ml$/i, "");
					allReqDocs.set(relPath, parseRequirementDocument(content, fallbackId));
				}
			}
		} catch {
			/* ignore */
		}
	}

	// Pre-parse changed requirement files to detect legitimate `git mv` renames ([사소-F1a])
	const parsedChanges = new Map();
	for (const reqRelPath of changedReqPaths) {
		const fallbackId = path.posix.basename(reqRelPath).replace(/\.ya?ml$/i, "");
		const newContent = readNewFileContent(reqRelPath);
		const oldContent = readOldFileContent(reqRelPath);
		const oldDoc = oldContent != null ? parseRequirementDocument(oldContent, fallbackId) : null;
		const newDoc = newContent != null ? parseRequirementDocument(newContent, fallbackId) : null;
		parsedChanges.set(reqRelPath, { newContent, oldContent, oldDoc, newDoc });
	}

	const renamedFromByNewPath = new Map();
	const handledOldMovePaths = new Set();
	for (const [oldRelPath, oldInfo] of parsedChanges.entries()) {
		if (oldInfo.newContent != null || !oldInfo.oldDoc) continue;
		for (const [newRelPath, newInfo] of parsedChanges.entries()) {
			if (newRelPath === oldRelPath || newInfo.oldContent != null || !newInfo.newDoc) continue;
			if (
				newInfo.newDoc.id === oldInfo.oldDoc.id &&
				newInfo.newDoc.hasExplicitDesignFields &&
				newInfo.newDoc.artifacts.length > 0
			) {
				handledOldMovePaths.add(oldRelPath);
				renamedFromByNewPath.set(newRelPath, oldInfo.oldDoc);
				break;
			}
		}
	}

	const violations = [];

	for (const reqRelPath of changedReqPaths) {
		if (handledOldMovePaths.has(reqRelPath)) continue;
		const info = parsedChanges.get(reqRelPath);
		const newContent = info.newContent;
		const oldDoc = renamedFromByNewPath.get(reqRelPath) || info.oldDoc;
		const newDoc = info.newDoc;

		// [보통-U3] Block direct deletion of a design-bearing requirement file
		if (newContent == null) {
			if (oldDoc && oldDoc.hasExplicitDesignFields && oldDoc.artifacts.length > 0) {
				const firstArt = oldDoc.artifacts[0];
				const label =
					firstArt.id && firstArt.path
						? `${firstArt.id} (${firstArt.path})`
						: `${oldDoc.id} (요구사항 파일 삭제됨)`;
				violations.push({
					ok: false,
					code: "deleted_design_requirement",
					reqId: oldDoc.id,
					reqRelPath,
					artifactLabel: label,
					reason:
						"(a) 설계와 산출물이 정의된 요구사항 파일을 직접 삭제할 수 없습니다. 파일 이름 이동은 동일한 id·설계를 유지해 `git mv`로 함께 스테이지하고, 정당한 폐기는 status: retired 로 바꾸고 산출물 의도 시험(또는 실행 영수증)을 함께 갱신하세요.",
				});
			}
			continue;
		}

		const retiredTransition =
			oldDoc !== null &&
			oldDoc.status !== "retired" &&
			newDoc.status === "retired" &&
			newDoc.hasExplicitDesignFields &&
			newDoc.artifacts.length > 0;

		const removedDesignOrArtifacts =
			oldDoc !== null &&
			(oldDoc.hasExplicitDesignFields || oldDoc.artifacts.length > 0) &&
			(!newDoc.hasExplicitDesignFields ||
				(oldDoc.artifacts.length > 0 && newDoc.artifacts.length < oldDoc.artifacts.length));

		const designChanged =
			oldDoc === null
				? newDoc.hasExplicitDesignFields
				: oldDoc.designDigest !== newDoc.designDigest ||
					retiredTransition ||
					removedDesignOrArtifacts;

		if (!designChanged) continue;

		// [보통-U3a] Block 2-step deletion bypass (stripping design/artifacts sections or dropping artifacts without status: retired)
		if (
			oldDoc !== null &&
			(oldDoc.hasExplicitDesignFields || oldDoc.artifacts.length > 0) &&
			newDoc.status !== "retired"
		) {
			if (!newDoc.hasExplicitDesignFields || newDoc.artifacts.length === 0) {
				const firstOldArt = oldDoc.artifacts[0];
				const label =
					firstOldArt && firstOldArt.id && firstOldArt.path
						? `${firstOldArt.id} (${firstOldArt.path})`
						: `${newDoc.id} (설계·산출물 섹션 제거됨)`;
				violations.push({
					ok: false,
					code: "empty_artifacts_on_design",
					reqId: newDoc.id,
					reqRelPath,
					artifactLabel: label,
					reason:
						"(a) 설계·산출물이 정의된 요구사항에서 design 또는 artifacts 섹션을 제거하거나 비울 수 없습니다(2단계 삭제 우회 차단). 정당한 폐기는 status: retired 전환과 의도 시험 재검증으로만 가능합니다.",
				});
				continue;
			}

			const newArtKeys = new Set(newDoc.artifacts.map((a) => a.id || a.path));
			const droppedArts = oldDoc.artifacts.filter((a) => !newArtKeys.has(a.id || a.path));
			if (droppedArts.length > 0) {
				for (const dropped of droppedArts) {
					const label =
						dropped.id && dropped.path
							? `${dropped.id} (${dropped.path})`
							: dropped.id || dropped.path || `${newDoc.id} (산출물 제거됨)`;
					violations.push({
						ok: false,
						code: "removed_artifact_without_retirement",
						reqId: newDoc.id,
						reqRelPath,
						artifactLabel: label,
						reason:
							"(a) 활성 요구사항에서 기존 산출물 항목을 임의로 삭제할 수 없습니다. 정당한 폐기는 status: retired 전환과 의도 시험 재검증으로만 가능합니다.",
					});
				}
				continue;
			}
		}

		const targetArtifacts = [...newDoc.artifacts];
		for (const [otherRel, otherDoc] of allReqDocs.entries()) {
			if (otherRel === reqRelPath) continue;
			for (const art of otherDoc.artifacts) {
				if (art.requirementRef && art.requirementRef === newDoc.id) {
					targetArtifacts.push(art);
				}
			}
		}

		if (targetArtifacts.length === 0 && newDoc.hasExplicitDesignFields) {
			violations.push({
				ok: false,
				code: "empty_artifacts_on_design",
				reqId: newDoc.id,
				reqRelPath,
				artifactLabel: `${newDoc.id} (산출물 목록 비어 있음)`,
				reason:
					"(a) 요구사항의 설계(design) 칸이 바뀌었으나 artifacts 목록에 산출물과 의도 시험이 적혀 있지 않습니다.",
			});
			continue;
		}

		for (const artifact of targetArtifacts) {
			const res = evaluateArtifactIntent({
				reqId: newDoc.id,
				reqRelPath,
				artifact,
				repoRoot: resolvedRoot,
				activeChangedFiles,
				readNewFileContent,
				designDigest: newDoc.designDigest,
				fullDigest: newDoc.fullDigest,
			});
			if (!res.ok) {
				violations.push(res);
			}
		}
	}

	if (violations.length === 0) {
		return { ok: true, violations: [] };
	}

	const lines = [
		"[Harness] 설계가 바뀐 요구사항의 산출물 의도 시험이 확인되지 않아 차단합니다 (intent-guard).",
		"",
		"다시 검사해야 할 앞 단계 산출물:",
	];
	for (const v of violations) {
		lines.push(`  - ${v.artifactLabel} [요구사항: ${v.reqId} (${v.reqRelPath})] → ${v.reason}`);
	}
	lines.push(
		"",
		"조치 방법:",
		"  1. 요구사항 파일(.agents/requirements/*.yaml)의 artifacts[].intent_test에 내용 지표·비교 연산을 포함한 조건(condition)과 실제 시험 파일 경로(test_path)를 적으세요 (파일 모양·개수만 보는 시험 및 공허한 상수 시험 금지).",
		"  2. 바뀐 설계 의도에 맞춰 의도 시험 파일(test_path)을 갱신해 같은 변경에 포함하거나, `node .claude/hooks/intent-guard.js --run-tests`로 실행기 영수증(.agents/intent-receipts/<REQ-ID>.json)을 발급받아 같은 커밋에 함께 스테이지하세요 (관문이 커밋 시점에 시험을 직접 재실행해 검증합니다).",
		"  3. 안내 문서: docs/guides/design-intent-guard.md",
	);

	return {
		ok: false,
		violations,
		reason: lines.join("\n"),
	};
}

const DESIGN_LANDING_SUBCOMMANDS = new Set([
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"am",
	"apply",
	"pull",
]);

function quoteShellToken(tok) {
	const s = String(tok ?? "");
	if (!s) return "''";
	if (/^[A-Za-z0-9_./:@=-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Expand in-command shell aliases (e.g. `alias g=git; g commit -m x`) using
 * clauses parsed by .claude/hooks/lib/git-command-parser.js.
 */
function expandInlineAliases(command) {
	if (!command || typeof command !== "string" || !/\balias\b/.test(command)) {
		return command;
	}
	const clauses = shellClauses(command);
	const aliases = new Map();
	for (const clause of clauses) {
		if (!Array.isArray(clause) || clause.length === 0) continue;
		if (clause[0] === "alias") {
			for (let i = 1; i < clause.length; i++) {
				const m = clause[i].match(/^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/);
				if (m) {
					const val = m[2].replace(/^['"]|['"]$/g, "").trim();
					if (val) aliases.set(m[1], val);
				}
			}
		}
	}
	if (aliases.size === 0) return command;

	let expanded = command;
	for (const [name, target] of aliases.entries()) {
		const re = new RegExp(`(^|[;&|()\\n]\\s*)${name}(?=\\s|$)`, "g");
		expanded = expanded.replace(re, `$1${target}`);
	}
	return expanded;
}

/**
 * Extract `find ... -exec <cmd> ... \;` subcommand entries from an effective command argv.
 */
function extractFindExecEntries(entry) {
	const argv = entry && Array.isArray(entry.argv) ? entry.argv : [];
	if (argv.length === 0 || path.basename(argv[0]) !== "find") return [];
	const results = [];
	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "-exec" || argv[i] === "-execdir") {
			const sub = [];
			let j = i + 1;
			while (j < argv.length && argv[j] !== ";" && argv[j] !== "\\;" && argv[j] !== "+") {
				if (argv[j].endsWith(";") && argv[j] !== ";") {
					sub.push(argv[j].replace(/\\?;$/, ""));
					break;
				}
				sub.push(argv[j]);
				j++;
			}
			if (sub.length > 0) {
				results.push({ argv: sub, dir: entry.dir });
			}
			i = j;
		}
	}
	return results;
}

/**
 * Extract nested shell commands from `npx`, `npm`/`pnpm`/`yarn` package scripts, and `make` targets.
 */
function extractBuildRunnerCommands(entry, defaultDir) {
	const argv = entry && Array.isArray(entry.argv) ? entry.argv : [];
	if (argv.length === 0) return [];
	const dir = entry.dir || defaultDir;
	const base = path.basename(argv[0] || "");
	const subCommands = [];

	if (base === "npx") {
		let idx = 1;
		while (idx < argv.length) {
			const tok = argv[idx];
			if (tok === "-p" || tok === "--package" || tok === "-c" || tok === "--call") {
				idx += 2;
				continue;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			break;
		}
		if (idx < argv.length) {
			subCommands.push(argv.slice(idx).map(quoteShellToken).join(" "));
		}
	} else if (base === "npm" || base === "pnpm" || base === "yarn") {
		let scriptName = null;
		const rest = argv.slice(1).filter((t) => !t.startsWith("-"));
		if (rest[0] === "run" || rest[0] === "run-script") {
			scriptName = rest[1] || null;
		} else if ((base === "pnpm" || base === "yarn") && rest[0]) {
			scriptName = rest[0];
		}
		if (scriptName) {
			const pkgPath = path.join(dir, "package.json");
			if (fs.existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
					if (pkg && pkg.scripts && typeof pkg.scripts[scriptName] === "string") {
						subCommands.push(pkg.scripts[scriptName]);
					}
				} catch {
					/* ignore */
				}
			}
		}
	} else if (base === "make" || base === "gmake") {
		const makefileNames = ["GNUmakefile", "makefile", "Makefile"];
		for (const mf of makefileNames) {
			const mfPath = path.join(dir, mf);
			if (!fs.existsSync(mfPath)) continue;
			try {
				const mfText = fs.readFileSync(mfPath, "utf8");
				const lines = mfText.split(/\r?\n/);
				for (const line of lines) {
					if (/^\t+/.test(line)) {
						subCommands.push(line.replace(/^\t+[@+-]*/, "").trim());
					}
				}
			} catch {
				/* ignore */
			}
			break;
		}
	}

	return subCommands;
}

/**
 * Recursively collect effective command entries, expanding `find -exec` nested shells
 * (`find ... -exec sh -c 'git commit ...' \;`) and build runner scripts (`npx`, `npm`, `pnpm`, `make`).
 */
function collectEffectiveEntries(command, baseDir, depth = 0) {
	if (!command || typeof command !== "string" || depth > 4) return [];
	const aliasExpanded = expandInlineAliases(command);
	const rawEntries = effectiveCommands(aliasExpanded, baseDir);
	const allEntries = [];

	for (const entry of rawEntries) {
		allEntries.push(entry);
		const entryDir = entry.dir || baseDir;

		const findSubs = extractFindExecEntries(entry);
		for (const fSub of findSubs) {
			allEntries.push(fSub);
			const nestedCmd = fSub.argv.map(quoteShellToken).join(" ");
			allEntries.push(...collectEffectiveEntries(nestedCmd, fSub.dir || entryDir, depth + 1));
		}

		const runnerCmds = extractBuildRunnerCommands(entry, entryDir);
		for (const rCmd of runnerCmds) {
			allEntries.push(...collectEffectiveEntries(rCmd, entryDir, depth + 1));
		}
	}

	return allEntries;
}

/**
 * Normalize a git/hub argv so `gitClauseDirectory` and `findGitSubcommandArgv`
 * handle `hub`, `-C=<dir>`, and `--work-tree=<dir>` without duplicate option sets.
 */
function normalizeGitEntryArgv(argv) {
	if (!Array.isArray(argv) || argv.length === 0) return null;
	const cmdBase = path.basename(argv[0] || "");
	if (!/^(?:git(?:\.exe)?|hub)$/i.test(cmdBase)) return null;

	const norm = ["git"];
	for (let i = 1; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === "--work-tree" && i + 1 < argv.length) {
			norm.push("-C", argv[++i]);
			continue;
		}
		if (tok.startsWith("--work-tree=")) {
			norm.push("-C", tok.slice("--work-tree=".length));
			continue;
		}
		if (tok.startsWith("-C=") && tok.length > 3) {
			norm.push("-C", tok.slice(3));
			continue;
		}
		norm.push(tok);
	}
	return norm;
}

/**
 * Extract `git commit` (and design-landing git subcommands) from a shell command
 * by reusing `effectiveCommands` + `gitClauseDirectory` (.claude/hooks/lib/effective-argv.js)
 * and `findGitSubcommandArgv` (.claude/hooks/lib/git-command-parser.js).
 */
function extractGitCommitInvocations(command, baseCwd) {
	if (!command || typeof command !== "string") return [];
	const resolvedBaseCwd = path.resolve(baseCwd || process.cwd());
	const allEntries = collectEffectiveEntries(command, resolvedBaseCwd, 0);

	const invocations = [];
	for (const entry of allEntries) {
		const normArgv = normalizeGitEntryArgv(entry && entry.argv);
		if (!normArgv) continue;

		const gitCwd = gitClauseDirectory(
			{ argv: normArgv, dir: entry.dir || resolvedBaseCwd },
			resolvedBaseCwd,
		);
		const clauseStr = normArgv.map(quoteShellToken).join(" ");

		const commitMatches = findGitSubcommandArgv(clauseStr, "commit");
		for (const commitArgs of commitMatches) {
			let isDryRun = false;
			let isInteractive = false;
			let includeWorktree = false;
			let includeStagedWithExplicit = false;
			const explicitPaths = [];

			for (let aIdx = 0; aIdx < commitArgs.length; aIdx++) {
				const arg = commitArgs[aIdx];
				if (arg === "--") {
					explicitPaths.push(
						...commitArgs.slice(aIdx + 1).filter((tok) => tok && !/^[;&|]+$/.test(tok)),
					);
					break;
				}
				if (arg === "--dry-run" || arg === "-n") {
					isDryRun = true;
					continue;
				}
				if (
					arg === "--interactive" ||
					arg === "--patch" ||
					arg === "-p" ||
					/^--(?:inter|pa)/.test(arg)
				) {
					isInteractive = true;
					includeWorktree = true;
					continue;
				}
				if (
					arg === "-a" ||
					arg === "--all" ||
					arg === "-i" ||
					arg === "--include" ||
					arg === "-o" ||
					arg === "--only" ||
					/^-(?!-)[A-Za-z]*[aio][A-Za-z]*$/.test(arg)
				) {
					includeWorktree = true;
					if (arg === "-i" || arg === "--include" || /^-(?!-)[A-Za-z]*i[A-Za-z]*$/.test(arg)) {
						includeStagedWithExplicit = true;
					}
					if (
						/^-(?!-)[A-Za-z]*[mFctC][A-Za-z]*$/.test(arg) &&
						aIdx + 1 < commitArgs.length
					) {
						aIdx++;
					}
					continue;
				}
				if (
					(arg === "-m" ||
						arg === "--message" ||
						arg === "-F" ||
						arg === "--file" ||
						arg === "-c" ||
						arg === "--reedit-message" ||
						arg === "-C" ||
						arg === "--reuse-message" ||
						arg === "--author" ||
						arg === "--date" ||
						arg === "--cleanup" ||
						arg === "-u" ||
						arg === "--untracked-files") &&
					aIdx + 1 < commitArgs.length
				) {
					aIdx++;
					continue;
				}
				if (arg.startsWith("-") || /^[;&|]+$/.test(arg)) continue;
				if (arg === "$?" || arg === "$X") continue;
				explicitPaths.push(arg);
			}

			if (!(isDryRun && !isInteractive)) {
				invocations.push({
					subcommand: "commit",
					cwd: gitCwd,
					includeWorktree,
					includeStagedWithExplicit,
					explicitPaths,
				});
			}
		}

		for (const landingSub of DESIGN_LANDING_SUBCOMMANDS) {
			const subMatches = findGitSubcommandArgv(clauseStr, landingSub);
			for (const subArgs of subMatches) {
				const isAbortOrReadOnly = subArgs.some((a) =>
					/^--(?:abort|quit|show-current-patch|check|stat|numstat|summary)$/.test(a),
				);
				if (!isAbortOrReadOnly) {
					invocations.push({
						subcommand: landingSub,
						cwd: gitCwd,
						includeWorktree: true,
						includeStagedWithExplicit: false,
						explicitPaths: [],
					});
				}
			}
		}
	}

	return invocations;
}

/**
 * Bash PreToolUse policy entrypoint: (command, data, opts?) → { reason } | null
 */
function designIntentRecheck(command, data, opts) {
	try {
		if (!command || typeof command !== "string") return null;
		const baseCwd = (opts && opts.cwd) || (data && data.cwd) || process.cwd();
		const invocations = extractGitCommitInvocations(command, baseCwd);
		if (invocations.length === 0) return null;

		for (const inv of invocations) {
			let mode = "staged";
			if (inv.subcommand !== "commit") {
				mode = "auto";
			} else if (inv.explicitPaths.length > 0 && !inv.includeStagedWithExplicit) {
				mode = "explicit";
			} else if (inv.includeWorktree) {
				mode = "tracked-worktree";
			}

			const res = checkRepositoryDesignIntent(inv.cwd, {
				mode,
				includeWorktree: inv.includeWorktree,
				explicitPaths: inv.explicitPaths,
			});
			if (!res.ok && res.reason) {
				return { reason: res.reason };
			}
		}
		return null;
	} catch (err) {
		process.stderr.write(
			`[intent-guard] fail-open error: ${err && err.message ? err.message : String(err)}\n`,
		);
		return null;
	}
}

module.exports = {
	designIntentRecheck,
	intentGuard: designIntentRecheck,
	checkRepositoryDesignIntent,
	runRequirementIntentTests,
	parseRequirementDocument,
	evaluateArtifactIntent,
	isShapeOrCountOnlyCondition,
	extractGitCommitInvocations,
};
