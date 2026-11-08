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
 *       uncommented assertions, the declared symbol (outside comments), and
 *       numeric thresholds matching the declared condition, and
 *   (c) re-verify the intent test in the same change — either by updating the
 *       test file in the same change set or by providing a runner-issued
 *       execution receipt (--run-tests) bound to design_sha256, test_sha256,
 *       exit_code === 0, output_sha256, and run_proof.
 *
 * Shell parsing reuses .claude/hooks/lib/git-command-parser.js and
 * .claude/hooks/lib/effective-argv.js (no duplicate shell tokenizer).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const HOOKS_LIB_DIR = path.resolve(__dirname, "..", "..", "..", ".claude", "hooks", "lib");
const { shellClauses } = require(path.join(HOOKS_LIB_DIR, "git-command-parser.js"));
const { effectiveCommands, gitClauseDirectory } = require(path.join(HOOKS_LIB_DIR, "effective-argv.js"));

const REQ_PATH_RE = /(?:^|\/)\.agents\/requirements\/(?!_)[^/]+\.ya?ml$/;
const RUNNER_ID = "intent-guard-runner/v1";
const RECEIPT_PROOF_SALT = "naia-adk-intent-guard-receipt-v1";

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

function computeReceiptProof({
	runner,
	reqId,
	artifactId,
	testPath,
	designSha256,
	testSha256,
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
 *
 * Approach chosen: Positive structural verification of content-value metric +
 * comparison operator/bound (combined with superficial-metric rejection), rather
 * than a narrow phrase blacklist.
 */
function isShapeOrCountOnlyCondition(condition) {
	if (!condition || typeof condition !== "string") return true;
	const text = condition.trim();
	if (!text) return true;

	// Explicit "only shape/count/existence/size/extension" phrasing is always rejected
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
		// 1) Symbolic comparison: <subject> (<=|>=|==|!=|===|!==|<|>|=|±) <target>
		const symMatch = clause.match(
			/^(.+?)\s*(<=|>=|===|!==|==|!=|<|>|=|±)\s*(['"][^'"]+['"]|-?\d+(?:\.\d+)?(?:\s*[A-Za-z%]+)?|\b(?:true|false|null)\b)\s*$/i,
		);
		if (symMatch) {
			const subject = symMatch[1].trim();
			const rhs = symMatch[3].trim();
			// Reject pure byte-size unit comparisons like >= 100B / 10KB on file size
			const isByteUnitOnly = /^-?\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|bytes?)$/i.test(rhs);
			if (!isSuperficialSubject(subject) && !(isByteUnitOnly && /크기|용량|size|byte/i.test(subject))) {
				hasContentMetricComparison = true;
			}
			continue;
		}

		// 2) Korean quantitative bound: <subject> ... <number> (이하|이상|미만|초과|이내|동일|일치)
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

function extractConditionThresholds(condition) {
	if (!condition || typeof condition !== "string") return [];
	const matches = condition.match(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g) || [];
	return [...new Set(matches)];
}

function codeContainsNumericThreshold(uncommentedCode, numStr) {
	if (uncommentedCode.includes(numStr)) return true;
	const targetNum = Number(numStr);
	if (!Number.isFinite(targetNum)) return false;
	const codeNums =
		uncommentedCode.match(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g) || [];
	return codeNums.some((tok) => Number(tok) === targetNum);
}

function hasNonTautologicalAssertion(uncommentedCode) {
	if (!/\b(?:assert(?:\.[A-Za-z_]\w*)?|expect)\s*\(/.test(uncommentedCode)) {
		return false;
	}
	const strippedTautologies = uncommentedCode.replace(
		/\b(?:assert(?:\.ok)?|expect)\s*\(\s*(?:true|1|!0|['"][^'"]*['"])\s*\)/g,
		"",
	);
	return /\b(?:assert(?:\.[A-Za-z_]\w*)?|expect)\s*\(/.test(strippedTautologies);
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

		// Normalize and validate test_path inside repoRoot
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

		// (b) Actual test file must exist on disk and be a non-empty regular file inside repoRoot
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

		if (
			testSpec.symbol &&
			!isPlaceholderValue(testSpec.symbol) &&
			!uncommentedCode.includes(testSpec.symbol)
		) {
			return {
				ok: false,
				code: "missing_test_symbol",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일("${normTestPath}")의 실제 코드(주석 제외)에 선언된 시험 심볼("${testSpec.symbol}")이 없습니다.`,
			};
		}

		if (!hasNonTautologicalAssertion(uncommentedCode)) {
			return {
				ok: false,
				code: "weak_test_assertion",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일("${normTestPath}")에 실제 산출물 지표를 검증하는 단언문(assert/expect)이 없거나 동어반복 단언뿐입니다.`,
			};
		}

		const thresholds = extractConditionThresholds(cond);
		for (const numStr of thresholds) {
			if (!codeContainsNumericThreshold(uncommentedCode, numStr)) {
				return {
					ok: false,
					code: "condition_threshold_mismatch",
					reqId,
					reqRelPath,
					artifactLabel,
					artifact,
					reason: `(b) 의도 시험 내용 불일치: 조건("${cond}")의 수치 기준값("${numStr}")이 시험 파일("${normTestPath}")의 실제 코드(주석 제외)에 없습니다.`,
				};
			}
		}

		const actualTestSha256 = sha256Hex(testContent);

		// (c) Must be re-verified in the same change:
		//     Either test_path is updated in activeChangedFiles, or a runner-verified receipt exists
		//     matching design_sha256, test_sha256, exit_code === 0, and run_proof.
		const testChangedInSameChange = activeChangedFiles.has(normTestPath);
		const receiptCheck = verifyIntentReceipt({
			repoRoot,
			reqId,
			artifact,
			testSpec,
			normTestPath,
			actualTestSha256,
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
	actualTestSha256,
	designDigest,
	fullDigest,
}) {
	const candidates = [];
	if (testSpec.receipt && !isPlaceholderValue(testSpec.receipt)) {
		candidates.push(testSpec.receipt.replace(/\\/g, "/").replace(/^\.\//, ""));
	}
	if (reqId) {
		candidates.push(`.agents/progress/intent-receipts/${reqId}.json`);
	}
	if (artifact.id && !isPlaceholderValue(artifact.id)) {
		candidates.push(`.agents/progress/intent-receipts/${artifact.id}.json`);
	}
	candidates.push(".agents/intent-receipts.json");

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
		if (!fs.existsSync(absReceipt)) {
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
			parsed = JSON.parse(fs.readFileSync(absReceipt, "utf8"));
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

		// Verify runner execution fields (blocks hand-written receipts)
		const runner = targetEntry.runner || parsed.runner || "";
		const exitCode = targetEntry.exit_code;
		const ranAt = targetEntry.ran_at || parsed.ran_at || "";
		const outputSha256 = targetEntry.output_sha256 || "";
		const recordedTestSha256 = String(targetEntry.test_sha256 || "").replace(/^sha256:/, "");
		const recordedProof = String(targetEntry.run_proof || "");

		if (runner !== RUNNER_ID || exitCode !== 0 || !ranAt || !/^[a-f0-9]{64}$/.test(outputSha256)) {
			lastDetail = `영수증(${relReceipt})에 실행기 증명(runner/exit_code: 0/output_sha256)이 없음(수기 영수증 차단 — --run-tests로 생성하세요)`;
			continue;
		}

		if (!recordedTestSha256 || recordedTestSha256 !== actualTestSha256) {
			lastDetail = `영수증(${relReceipt})의 시험 파일 해시(test_sha256)가 현재 시험 파일("${normTestPath}")과 불일치`;
			continue;
		}

		const expectedProof = computeReceiptProof({
			runner,
			reqId: targetEntry.requirement_id || parsed.requirement_id || reqId,
			artifactId: targetEntry.artifact_id || artifact.id,
			testPath: normTestPath,
			designSha256: cleanDigest,
			testSha256: recordedTestSha256,
			exitCode,
			outputSha256,
			ranAt,
		});

		if (!recordedProof || recordedProof !== expectedProof) {
			lastDetail = `영수증(${relReceipt})의 실행 증명(run_proof) 검증 실패(수기 위조 차단)`;
			continue;
		}

		return { ok: true, receiptPath: relReceipt };
	}

	return { ok: false, detail: lastDetail };
}

/**
 * Execute declared intent tests for requirement files and write verified receipts
 * containing design_sha256, test_sha256, exit_code, output_sha256, and run_proof.
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
				const runRes = spawnSync(process.execPath, ["--test", absTestPath], {
					cwd: resolvedRoot,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30000,
				});
				const exitCode = typeof runRes.status === "number" ? runRes.status : 1;
				const outputText = `${runRes.stdout || ""}\n${runRes.stderr || ""}`;
				const outputSha256 = sha256Hex(outputText);
				const status = exitCode === 0 ? "pass" : "fail";
				const runProof = computeReceiptProof({
					runner: RUNNER_ID,
					reqId: doc.id,
					artifactId: artifact.id,
					testPath: normTestPath,
					designSha256: doc.designDigest,
					testSha256,
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
						reason: (runRes.stderr || runRes.stdout || "Test execution failed").trim(),
					});
				}
			}
		}

		if (artifactReceipts.length > 0) {
			const receiptDir = path.join(resolvedRoot, ".agents", "progress", "intent-receipts");
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
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {"auto"|"staged"|"worktree"|"tracked-worktree"|"explicit"|"commit"} [options.mode="auto"]
 * @param {string} [options.commitRev="HEAD"]
 * @param {boolean} [options.includeWorktree=false]
 * @param {string[]} [options.explicitPaths=[]]
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
					runGit(resolvedRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", rev])
						.stdout,
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
				runGit(resolvedRoot, ["diff", "--cached", "--name-only", "-z"]).stdout,
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
			// mode === "worktree" or mode === "auto" when nothing is staged
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

	const violations = [];

	for (const reqRelPath of changedReqPaths) {
		const fallbackId = path.posix.basename(reqRelPath).replace(/\.ya?ml$/i, "");
		const newContent = readNewFileContent(reqRelPath);
		const oldContent = readOldFileContent(reqRelPath);
		const oldDoc =
			oldContent != null ? parseRequirementDocument(oldContent, fallbackId) : null;

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
						"(a) 설계와 산출물이 정의된 요구사항 파일을 직접 삭제할 수 없습니다. 정당한 폐기는 파일 삭제 대신 status: retired 로 바꾸고 산출물 의도 시험(또는 실행 영수증)을 함께 갱신하세요.",
				});
			}
			continue;
		}

		const newDoc = parseRequirementDocument(newContent, fallbackId);
		const retiredTransition =
			oldDoc !== null &&
			oldDoc.status !== "retired" &&
			newDoc.status === "retired" &&
			newDoc.hasExplicitDesignFields &&
			newDoc.artifacts.length > 0;

		const designChanged =
			oldDoc === null
				? newDoc.hasExplicitDesignFields && newDoc.artifacts.length > 0
				: oldDoc.designDigest !== newDoc.designDigest || retiredTransition;

		if (!designChanged) continue;

		const targetArtifacts = [...newDoc.artifacts];
		for (const [otherRel, otherDoc] of allReqDocs.entries()) {
			if (otherRel === reqRelPath) continue;
			for (const art of otherDoc.artifacts) {
				if (art.requirementRef && art.requirementRef === newDoc.id) {
					targetArtifacts.push(art);
				}
			}
		}

		if (
			targetArtifacts.length === 0 &&
			newDoc.blocks.has("design") &&
			newDoc.blocks.has("artifacts")
		) {
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
		"  1. 요구사항 파일(.agents/requirements/*.yaml)의 artifacts[].intent_test에 내용 지표·비교 연산을 포함한 조건(condition)과 실제 시험 파일 경로(test_path)를 적으세요 (파일 모양·개수만 보는 시험 금지).",
		"  2. 바뀐 설계 의도에 맞춰 의도 시험 파일(test_path)을 갱신해 같은 변경에 포함하거나, `node .claude/hooks/intent-guard.js --run-tests`로 실행기 영수증(design_sha256·test_sha256·exit_code 일치)을 발급받으세요.",
		"  3. 안내 문서: docs/guides/design-intent-guard.md",
	);

	return {
		ok: false,
		violations,
		reason: lines.join("\n"),
	};
}

const GIT_OPT_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--config-env",
	"--git-dir",
	"--work-tree",
	"--namespace",
]);

const GIT_OPT_NO_VALUE = new Set([
	"-p",
	"--paginate",
	"-P",
	"--no-pager",
	"--bare",
	"--no-replace-objects",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
]);

const DESIGN_LANDING_SUBCOMMANDS = new Set([
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
	"am",
	"apply",
]);

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
 * Extract `git commit` (and design-landing git subcommands) from a shell command
 * by reusing .claude/hooks/lib/effective-argv.js and .claude/hooks/lib/git-command-parser.js.
 */
function extractGitCommitInvocations(command, baseCwd) {
	if (!command || typeof command !== "string") return [];
	const resolvedBaseCwd = path.resolve(baseCwd || process.cwd());
	const aliasExpanded = expandInlineAliases(command);
	const rawEntries = effectiveCommands(aliasExpanded, resolvedBaseCwd);
	const allEntries = [];
	for (const entry of rawEntries) {
		allEntries.push(entry);
		allEntries.push(...extractFindExecEntries(entry));
	}

	const invocations = [];
	for (const entry of allEntries) {
		const argv = entry && Array.isArray(entry.argv) ? entry.argv : [];
		if (argv.length === 0) continue;
		const cmdBase = path.basename(argv[0] || "");
		if (!/^(?:git(?:\.exe)?|hub)$/i.test(cmdBase)) continue;

		let gitCwd = gitClauseDirectory(entry, entry.dir || resolvedBaseCwd);
		let gIdx = 1;
		while (gIdx < argv.length) {
			const gt = argv[gIdx];
			if ((gt === "-C" || gt === "--work-tree") && gIdx + 1 < argv.length) {
				gitCwd = path.resolve(gitCwd, argv[gIdx + 1]);
				gIdx += 2;
				continue;
			}
			if (gt.startsWith("-C") && gt.length > 2) {
				const attached = gt.slice(2).replace(/^=/, "");
				if (attached) gitCwd = path.resolve(gitCwd, attached);
				gIdx++;
				continue;
			}
			if (gt.startsWith("--work-tree=")) {
				gitCwd = path.resolve(gitCwd, gt.slice("--work-tree=".length));
				gIdx++;
				continue;
			}
			if (GIT_OPT_WITH_VALUE.has(gt) && gIdx + 1 < argv.length) {
				gIdx += 2;
				continue;
			}
			if (
				GIT_OPT_NO_VALUE.has(gt) ||
				/^-c.+/.test(gt) ||
				/^--(?:config-env|git-dir|work-tree|namespace)=\S+$/.test(gt)
			) {
				gIdx++;
				continue;
			}
			break;
		}

		const subcmd = argv[gIdx];
		if (!subcmd) continue;

		if (subcmd === "commit") {
			const commitArgs = argv.slice(gIdx + 1);
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
				// Ignore placeholder markers produced by spawnedCommands when no file path was given
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
		} else if (DESIGN_LANDING_SUBCOMMANDS.has(subcmd)) {
			const subArgs = argv.slice(gIdx + 1);
			const isAbortOrReadOnly = subArgs.some((a) =>
				/^--(?:abort|quit|show-current-patch|check|stat|numstat|summary)$/.test(a),
			);
			if (!isAbortOrReadOnly) {
				invocations.push({
					subcommand: subcmd,
					cwd: gitCwd,
					includeWorktree: true,
					includeStagedWithExplicit: false,
					explicitPaths: [],
				});
			}
		}
	}

	return invocations;
}

/**
 * Bash PreToolUse policy entrypoint: (command, data, opts?) → { reason } | null
 */
function designIntentRecheck(command, data, opts) {
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
	computeReceiptProof,
};
