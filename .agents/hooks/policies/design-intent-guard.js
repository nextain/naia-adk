"use strict";

/**
 * Design-Change Upstream/Consumer Artifact Intent Recheck Policy (intent-guard).
 *
 * When a requirement file (.agents/requirements/*.yaml) changes its design
 * fields, every artifact produced by or consumed under that requirement must:
 *   (a) declare a machine-measurable intent test (condition + test_path),
 *       rejecting empty placeholders and file-shape/file-count-only checks,
 *   (b) have the declared test_path actually exist inside the repository, and
 *   (c) re-verify the intent test in the same change (either by updating the
 *       test file in the same commit/change set or by providing a fresh passing
 *       test receipt bound to the current design digest).
 *
 * If any artifact fails (a), (b), or (c), the guard blocks the commit/check and
 * outputs the "다시 검사해야 할 앞 단계 산출물" list.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REQ_PATH_RE = /(?:^|\/)\.agents\/requirements\/(?!_)[^/]+\.ya?ml$/;

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
	return crypto.createHash("sha256").update(input, "utf8").digest("hex");
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

/**
 * Detect conditions that only check superficial file existence, extension, byte size,
 * or count ("파일 모양·개수만 보는 시험") without measuring semantic design intent.
 */
function isShapeOrCountOnlyCondition(condition) {
	if (!condition || typeof condition !== "string") return true;
	const text = condition.trim();
	if (!text) return true;

	// Korean patterns indicating shape/count/existence-only checks
	const koShapeOnlyPatterns = [
		/파일\s*(?:모양|개수|존재|크기|유무|확장자|형식)(?:[·,\s/]|과|와|및|이나|만)*\s*만\s*(?:확인|검사|검증|체크|본다|봄|측정)/,
		/(?:모양|개수|존재|확장자|파일\s*크기|프레임\s*개수|프레임\s*수)\s*만\s*(?:확인|검사|검증|체크|본다|봄|측정)/,
		/^(?:산출물\s*|파일\s*|클립\s*|영상\s*)?(?:존재|생성|개수|크기|확장자|파일\s*모양|파일\s*개수|프레임\s*수|프레임\s*개수)(?:[·,\s/]|과|와|및)*(?:존재|생성|개수|크기|확장자|파일\s*모양|파일\s*개수|프레임\s*수|프레임\s*개수|여부)?\s*(?:만\s*)?(?:확인|검사|검증|체크)?\s*$/,
	];
	for (const re of koShapeOnlyPatterns) {
		if (re.test(text)) return true;
	}

	// English patterns indicating shape/count/existence-only checks
	const enShapeOnlyPatterns = [
		/\b(?:only\s+)?(?:check|verify|assert|test|validate)s?\s+(?:only\s+)?(?:that\s+)?(?:the\s+)?(?:file|artifact|output|clip|video)s?\s+(?:exist(?:s|ence)?|count|shape|size|extension|format|frame\s+count)(?:\s*(?:,|\/|and|or)\s*(?:file\s+)?(?:exist(?:s|ence)?|count|shape|size|extension|format|frame\s+count))*\s*(?:only)?\s*$/i,
		/^(?:file|artifact|output|clip)?\s*(?:exists?|existence|count|shape|size|extension|non-empty|frame\s+count)(?:\s*(?:,|\/|and|or|\+)\s*(?:file\s+)?(?:exists?|existence|count|shape|size|extension|non-empty|frame\s+count))*\s*(?:only|check|test|verification)?\s*$/i,
		/\b(?:file\s+shape|file\s+count|shape\s+and\s+count|existence\s+and\s+count)\s+only\b/i,
	];
	for (const re of enShapeOnlyPatterns) {
		if (re.test(text)) return true;
	}

	return false;
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

		// Sub-list item under intent_tests:
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

	// Filter out pure template placeholder items if and only if every field is a {placeholder}
	return items;
}

/**
 * Parse a requirement YAML document into its id, design digest, and declared artifacts.
 */
function parseRequirementDocument(yamlText, fallbackId = "") {
	const blocks = parseTopLevelBlocks(yamlText);
	const rawId = blocks.has("id") ? unquoteYaml(blocks.get("id").inline) : fallbackId;
	const id = rawId || fallbackId;

	const artifacts = [];
	for (const key of ARTIFACT_SECTION_KEYS) {
		if (blocks.has(key)) {
			artifacts.push(...parseArtifactsFromBlock(blocks.get(key)));
		}
	}

	// Compute canonical design digest from DESIGN_TOP_KEYS + artifact semantic fields (excluding receipts)
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

	const hasExplicitDesignFields = [...DESIGN_TOP_KEYS].some((k) => blocks.has(k)) || artifacts.length > 0;
	const designDigest = sha256Hex(designParts.join("\n---\n"));
	const fullDigest = sha256Hex(String(yamlText || ""));

	return {
		id,
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
	headChangedFiles,
	designDigest,
	fullDigest,
}) {
	const artifactLabel =
		artifact.id && artifact.path && artifact.id !== artifact.path
			? `${artifact.id} (${artifact.path})`
			: artifact.id || artifact.path || "(이름 없는 산출물)";

	// (a) Intent test must be declared with a non-placeholder, non-shape/count-only condition and test_path
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
				reason: `(a) 의도 시험 부적격(파일 모양·개수만 보는 시험): "${cond}" — 산출물이 바뀐 설계 의도를 지키는지 기계로 재는 의미 조건을 적으세요.`,
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
		if (!testContent.trim()) {
			return {
				ok: false,
				code: "missing_test_file",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일 내용이 비어 있습니다: "${normTestPath}".`,
			};
		}

		if (
			testSpec.symbol &&
			!isPlaceholderValue(testSpec.symbol) &&
			!testContent.includes(testSpec.symbol)
		) {
			return {
				ok: false,
				code: "missing_test_symbol",
				reqId,
				reqRelPath,
				artifactLabel,
				artifact,
				reason: `(b) 의도 시험 파일("${normTestPath}")에 선언된 시험 심볼("${testSpec.symbol}")이 없습니다.`,
			};
		}

		// (c) Must be re-verified in the same change:
		//     Either test_path is in activeChangedFiles, or a valid non-stale test receipt exists.
		const testChangedInSameChange = activeChangedFiles.has(normTestPath);
		const receiptCheck = verifyIntentReceipt({
			repoRoot,
			reqId,
			artifact,
			testSpec,
			normTestPath,
			activeChangedFiles,
			headChangedFiles,
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
	activeChangedFiles,
	headChangedFiles,
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
		if (!relReceipt || relReceipt.startsWith("/") || relReceipt.startsWith("..") || relReceipt.includes("/../")) {
			continue;
		}
		const absReceipt = path.resolve(repoRoot, relReceipt);
		if (absReceipt !== repoRoot && !absReceipt.startsWith(repoRoot + path.sep)) continue;
		if (!fs.existsSync(absReceipt)) {
			if (testSpec.receipt && relReceipt === testSpec.receipt.replace(/\\/g, "/").replace(/^\.\//, "")) {
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

		// Find matching entry if receipt contains an array of results/artifacts
		let targetEntry = parsed;
		if (Array.isArray(parsed.artifacts) || Array.isArray(parsed.results) || Array.isArray(parsed.receipts)) {
			const list = parsed.artifacts || parsed.results || parsed.receipts;
			const matched = list.find(
				(item) =>
					item &&
					(item.artifact_id === artifact.id ||
						item.id === artifact.id ||
						item.path === artifact.path ||
						item.test_path === normTestPath ||
						item.requirement_id === reqId ||
						item.req_id === reqId),
			);
			if (!matched) {
				lastDetail = `영수증(${relReceipt})에 산출물(${artifact.id || artifact.path}) 항목 없음`;
				continue;
			}
			targetEntry = { ...parsed, ...matched };
		}

		// Check pass verdict
		const statusVal = String(
			targetEntry.status ?? targetEntry.result ?? targetEntry.verdict ?? "",
		).toLowerCase();
		const passedBool =
			targetEntry.passed === true ||
			targetEntry.ok === true ||
			statusVal === "pass" ||
			statusVal === "passed" ||
			statusVal === "ok" ||
			statusVal === "clean";
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

		// Check test_path match if specified in receipt
		if (
			targetEntry.test_path &&
			targetEntry.test_path.replace(/\\/g, "/").replace(/^\.\//, "") !== normTestPath
		) {
			lastDetail = `영수증(${relReceipt})의 test_path가 ${normTestPath}와 다름`;
			continue;
		}

		// Check freshness / binding to the current design change:
		const recordedDigest =
			targetEntry.design_sha256 ||
			targetEntry.req_sha256 ||
			targetEntry.requirement_sha256 ||
			parsed.design_sha256 ||
			parsed.req_sha256 ||
			parsed.requirement_sha256 ||
			null;

		if (recordedDigest) {
			const cleanDigest = String(recordedDigest).replace(/^sha256:/, "");
			if (cleanDigest !== designDigest && cleanDigest !== fullDigest) {
				lastDetail = `영수증(${relReceipt})의 설계 해시가 현재 설계와 불일치(이전 설계 영수증)`;
				continue;
			}
			return { ok: true, receiptPath: relReceipt };
		}

		// If no explicit digest is in the receipt, the receipt file MUST be updated in the current change set
		if (activeChangedFiles.has(relReceipt) || (headChangedFiles && headChangedFiles.has(relReceipt))) {
			return { ok: true, receiptPath: relReceipt };
		}

		lastDetail = `영수증(${relReceipt})이 이번 설계 변경에서 갱신되지 않음(stale receipt)`;
	}

	return { ok: false, detail: lastDetail };
}

function runGit(repoRoot, args) {
	return spawnSync("git", ["-c", "core.quotePath=false", "-C", repoRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
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
 * @param {"auto"|"staged"|"worktree"|"commit"} [options.mode="auto"]
 * @param {string} [options.commitRev="HEAD"]
 * @param {boolean} [options.includeWorktree=false]
 * @param {string[]} [options.explicitPaths=[]]
 */
function checkRepositoryDesignIntent(repoRoot, options = {}) {
	const resolvedRoot = resolveGitRepoRoot(repoRoot);
	if (!resolvedRoot) return { ok: true, violations: [] };

	const mode = options.mode || "auto";
	const hasHeadRes = runGit(resolvedRoot, ["rev-parse", "--verify", "HEAD"]);
	const hasHead = hasHeadRes.status === 0;

	const stagedFiles = new Set(
		parseNullSeparatedPaths(runGit(resolvedRoot, ["diff", "--cached", "--name-only", "-z"]).stdout),
	);
	const unstagedFiles = new Set(
		parseNullSeparatedPaths(runGit(resolvedRoot, ["diff", "--name-only", "-z"]).stdout),
	);
	const untrackedFiles = new Set(
		parseNullSeparatedPaths(
			runGit(resolvedRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout,
		),
	);
	const worktreeFiles = new Set([...stagedFiles, ...unstagedFiles, ...untrackedFiles]);

	let candidateChangedFiles;
	let readNewFileContent;
	let readOldFileContent;

	if (mode === "commit") {
		const rev = options.commitRev || "HEAD";
		const parentRes = runGit(resolvedRoot, ["rev-parse", "--verify", `${rev}^`]);
		const hasParent = parentRes.status === 0;
		const commitChanged = hasParent
			? parseNullSeparatedPaths(
					runGit(resolvedRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", rev]).stdout,
				)
			: parseNullSeparatedPaths(
					runGit(resolvedRoot, ["ls-tree", "--name-only", "-r", "-z", rev]).stdout,
				);
		candidateChangedFiles = new Set(commitChanged);
		readNewFileContent = (relPath) => readGitBlob(resolvedRoot, `${rev}:${relPath}`);
		readOldFileContent = (relPath) => (hasParent ? readGitBlob(resolvedRoot, `${rev}^:${relPath}`) : null);
	} else {
		const useWorktree =
			mode === "worktree" ||
			options.includeWorktree === true ||
			stagedFiles.size === 0;

		candidateChangedFiles = useWorktree ? worktreeFiles : new Set([...stagedFiles]);

		// Also check if any requirement file was modified in working tree when running git commit
		for (const f of worktreeFiles) {
			if (REQ_PATH_RE.test(f)) {
				candidateChangedFiles.add(f);
			}
		}

		if (Array.isArray(options.explicitPaths) && options.explicitPaths.length > 0) {
			for (const p of options.explicitPaths) {
				const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
				if (norm) candidateChangedFiles.add(norm);
			}
		}

		readNewFileContent = (relPath) => {
			if (!useWorktree && stagedFiles.has(relPath) && !unstagedFiles.has(relPath)) {
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

		readOldFileContent = (relPath) => {
			if (!hasHead) return null;
			return readGitBlob(resolvedRoot, `HEAD:${relPath}`);
		};
	}

	const changedReqPaths = [...candidateChangedFiles].filter((f) => REQ_PATH_RE.test(f)).sort();
	if (changedReqPaths.length === 0) {
		return { ok: true, violations: [] };
	}

	// Load all requirement files in .agents/requirements/ so cross-requirement artifact references work too
	const allReqDocs = new Map();
	const reqDir = path.join(resolvedRoot, ".agents", "requirements");
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
		const newContent = readNewFileContent(reqRelPath);
		if (newContent == null) continue; // deleted requirement file
		const fallbackId = path.posix.basename(reqRelPath).replace(/\.ya?ml$/i, "");
		const newDoc = parseRequirementDocument(newContent, fallbackId);
		const oldContent = readOldFileContent(reqRelPath);
		const oldDoc = oldContent != null ? parseRequirementDocument(oldContent, fallbackId) : null;

		const designChanged =
			oldDoc === null
				? newDoc.hasExplicitDesignFields && newDoc.artifacts.length > 0
				: oldDoc.designDigest !== newDoc.designDigest;

		if (!designChanged) continue;

		// Determine which changed-files set governs (c) for this requirement:
		// If the requirement was staged and git commit is not -a/worktree, require test/receipt in stagedFiles
		// (unless nothing was staged at all, in which case worktreeFiles applies).
		let activeChangedFiles;
		if (mode === "commit") {
			activeChangedFiles = candidateChangedFiles;
		} else if (
			mode !== "worktree" &&
			!options.includeWorktree &&
			stagedFiles.size > 0 &&
			stagedFiles.has(reqRelPath)
		) {
			activeChangedFiles = stagedFiles;
		} else {
			activeChangedFiles = worktreeFiles;
		}

		// Collect artifacts from this requirement + any other requirement referencing this reqId
		const targetArtifacts = [...newDoc.artifacts];
		for (const [otherRel, otherDoc] of allReqDocs.entries()) {
			if (otherRel === reqRelPath) continue;
			for (const art of otherDoc.artifacts) {
				if (art.requirementRef && art.requirementRef === newDoc.id) {
					targetArtifacts.push(art);
				}
			}
		}

		// If the requirement explicitly has a `design` block in YAML and changed it,
		// but declared `artifacts: []` (zero artifacts), flag that upstream artifacts are missing.
		if (targetArtifacts.length === 0 && newDoc.blocks.has("design") && newDoc.blocks.has("artifacts")) {
			violations.push({
				ok: false,
				code: "empty_artifacts_on_design",
				reqId: newDoc.id,
				reqRelPath,
				artifactLabel: `${newDoc.id} (산출물 목록 비어 있음)`,
				reason: "(a) 요구사항의 설계(design) 칸이 바뀌었으나 artifacts 목록에 산출물과 의도 시험이 적혀 있지 않습니다.",
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
				headChangedFiles: candidateChangedFiles,
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
		"  1. 요구사항 파일(.agents/requirements/*.yaml)의 artifacts[].intent_test에 기계로 재는 조건(condition)과 실제 시험 파일 경로(test_path)를 적으세요 (파일 모양·개수만 보는 시험 금지).",
		"  2. 바뀐 설계 의도에 맞춰 의도 시험 파일(test_path)을 다시 돌려 같은 변경에 포함하거나 통과 시험 영수증(receipt, design_sha256 일치)을 갱신하세요.",
		"  3. 안내 문서: docs/guides/design-intent-guard.md",
	);

	return {
		ok: false,
		violations,
		reason: lines.join("\n"),
	};
}

/**
 * Shell command parser to extract `git commit` invocations across compound segments,
 * subshells, wrappers (env, sudo, timeout, nohup, time), and `sh -c` / `bash -c` / `eval`.
 */
function splitShellSegments(command) {
	const segments = [];
	let current = "";
	let quote = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				current += command[++i];
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
			continue;
		}
		if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
			segments.push({ text: current, sep: ch + ch });
			current = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|") {
			segments.push({ text: current, sep: ch });
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) segments.push({ text: current, sep: "" });
	return segments;
}

function tokenizeSegment(segmentText) {
	const tokens = [];
	let cur = "";
	let quote = null;
	for (let i = 0; i < segmentText.length; i++) {
		const ch = segmentText[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < segmentText.length) {
				cur += segmentText[++i];
			} else if (ch === quote) {
				quote = null;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < segmentText.length) {
			cur += segmentText[++i];
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur.length > 0) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur.length > 0) tokens.push(cur);
	return tokens;
}

function unwrapGroupTokens(rawTokens) {
	const tokens = [...rawTokens];
	let openParens = 0;
	let closeParens = 0;
	while (tokens.length > 0) {
		const first = tokens[0];
		if (first === "(" || first === "{") {
			if (first === "(") openParens++;
			tokens.shift();
			continue;
		}
		if (first.startsWith("(") && !first.startsWith("$(")) {
			const m = first.match(/^\(+/);
			if (m) openParens += m[0].length;
			tokens[0] = first.replace(/^\(+/, "");
			if (!tokens[0]) tokens.shift();
			continue;
		}
		break;
	}
	while (tokens.length > 0) {
		const last = tokens[tokens.length - 1];
		if (last === ")" || last === "}" || last === ";") {
			if (last === ")") closeParens++;
			tokens.pop();
			continue;
		}
		if (/[;)\}]+$/.test(last) && !/\$\{[^}]*\}$/.test(last) && !/\$\([^)]*\)$/.test(last)) {
			const m = last.match(/\)+$/);
			if (m) closeParens += m[0].length;
			tokens[tokens.length - 1] = last.replace(/[;)\}]+$/, "");
			if (!tokens[tokens.length - 1]) tokens.pop();
			continue;
		}
		break;
	}
	return { tokens, openParens, closeParens };
}

function extractCommandSubstitutions(command) {
	const subs = [];
	if (!command || typeof command !== "string") return subs;
	const dollarParenRe = /\$\(([^()]+)\)/g;
	let m;
	while ((m = dollarParenRe.exec(command)) !== null) {
		subs.push(m[1]);
	}
	const backtickRe = /`([^`]+)`/g;
	while ((m = backtickRe.exec(command)) !== null) {
		subs.push(m[1]);
	}
	return subs;
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

function extractGitCommitInvocations(command, baseCwd, depth = 0) {
	if (!command || typeof command !== "string" || depth > 6) return [];
	const invocations = [];
	let effectiveCwd = path.resolve(baseCwd || process.cwd());
	const cwdStack = [];

	// Check $(...) and `...` command substitutions
	for (const sub of extractCommandSubstitutions(command)) {
		invocations.push(...extractGitCommitInvocations(sub, effectiveCwd, depth + 1));
	}

	const segments = splitShellSegments(command);
	for (const seg of segments) {
		const rawTokens = tokenizeSegment(seg.text);
		const { tokens, openParens, closeParens } = unwrapGroupTokens(rawTokens);
		for (let p = 0; p < openParens; p++) cwdStack.push(effectiveCwd);

		const finishSeg = () => {
			for (let p = 0; p < closeParens; p++) {
				if (cwdStack.length > 0) effectiveCwd = cwdStack.pop();
			}
		};

		if (tokens.length === 0) {
			finishSeg();
			continue;
		}

		// Strip leading VAR=val and command wrappers
		let idx = 0;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
				idx++;
				continue;
			}
			const base = path.basename(tok);
			if (base === "command" || base === "builtin" || base === "exec" || tok === "!") {
				idx++;
				continue;
			}
			if (base === "env") {
				idx++;
				while (idx < tokens.length) {
					if (tokens[idx] === "--") {
						idx++;
						break;
					}
					if (
						(tokens[idx] === "-u" ||
							tokens[idx] === "--unset" ||
							tokens[idx] === "-C" ||
							tokens[idx] === "--chdir" ||
							tokens[idx] === "-S" ||
							tokens[idx] === "--split-string") &&
						idx + 1 < tokens.length
					) {
						if (tokens[idx] === "-C" || tokens[idx] === "--chdir") {
							effectiveCwd = path.resolve(effectiveCwd, tokens[idx + 1]);
						}
						idx += 2;
						continue;
					}
					if (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
						idx++;
						continue;
					}
					break;
				}
				continue;
			}
			if (base === "sudo") {
				idx++;
				while (idx < tokens.length && tokens[idx].startsWith("-")) {
					if (tokens[idx] === "--") {
						idx++;
						break;
					}
					if (
						(tokens[idx] === "-u" ||
							tokens[idx] === "-g" ||
							tokens[idx] === "-D" ||
							tokens[idx] === "-R" ||
							tokens[idx] === "-h" ||
							tokens[idx] === "-p") &&
						idx + 1 < tokens.length
					) {
						if (tokens[idx] === "-D") {
							effectiveCwd = path.resolve(effectiveCwd, tokens[idx + 1]);
						}
						idx += 2;
						continue;
					}
					idx++;
				}
				continue;
			}
			if (base === "nohup" || base === "time") {
				idx++;
				while (idx < tokens.length && tokens[idx].startsWith("-")) {
					if (tokens[idx] === "--") {
						idx++;
						break;
					}
					idx++;
				}
				continue;
			}
			if (base === "nice") {
				idx++;
				if ((tokens[idx] === "-n" || tokens[idx] === "--adjustment") && idx + 1 < tokens.length) {
					idx += 2;
				} else if (tokens[idx] && tokens[idx].startsWith("-")) {
					idx++;
				}
				continue;
			}
			if (base === "timeout") {
				idx++;
				while (idx < tokens.length && tokens[idx].startsWith("-")) {
					if (tokens[idx] === "--") {
						idx++;
						break;
					}
					if (
						(tokens[idx] === "-k" ||
							tokens[idx] === "--kill-after" ||
							tokens[idx] === "-s" ||
							tokens[idx] === "--signal") &&
						idx + 1 < tokens.length
					) {
						idx += 2;
						continue;
					}
					idx++;
				}
				if (idx < tokens.length) idx++; // skip duration
				continue;
			}
			break;
		}

		if (idx >= tokens.length) {
			finishSeg();
			continue;
		}

		const cmdToken = tokens[idx];
		const cmdBase = path.basename(cmdToken);

		// Handle cd
		if (cmdBase === "cd" && seg.sep !== "|") {
			let cdIdx = idx + 1;
			while (
				cdIdx < tokens.length &&
				(tokens[cdIdx] === "-P" || tokens[cdIdx] === "-L" || tokens[cdIdx] === "--")
			) {
				cdIdx++;
			}
			if (tokens[cdIdx]) {
				effectiveCwd = path.resolve(effectiveCwd, tokens[cdIdx]);
			}
			finishSeg();
			continue;
		}

		// Handle eval
		if (cmdBase === "eval") {
			const inner = tokens.slice(idx + 1).join(" ");
			if (inner) {
				invocations.push(...extractGitCommitInvocations(inner, effectiveCwd, depth + 1));
			}
			finishSeg();
			continue;
		}

		// Handle sh -c / bash -c / zsh -c
		if (/^(?:bash|sh|zsh|dash|ksh)$/i.test(cmdBase)) {
			let sIdx = idx + 1;
			while (sIdx < tokens.length) {
				const st = tokens[sIdx];
				if (st === "-c" && sIdx + 1 < tokens.length) {
					invocations.push(
						...extractGitCommitInvocations(tokens[sIdx + 1], effectiveCwd, depth + 1),
					);
					break;
				}
				if ((st === "-o" || st === "+o") && sIdx + 1 < tokens.length) {
					sIdx += 2;
					continue;
				}
				if (st.startsWith("-") && st.includes("c") && !st.startsWith("--") && sIdx + 1 < tokens.length) {
					invocations.push(
						...extractGitCommitInvocations(tokens[sIdx + 1], effectiveCwd, depth + 1),
					);
					break;
				}
				if (st.startsWith("-") || st.startsWith("+")) {
					sIdx++;
					continue;
				}
				break;
			}
			finishSeg();
			continue;
		}

		// Handle git commit
		if (/^git(?:\.exe)?$/i.test(cmdBase)) {
			let gIdx = idx + 1;
			let gitCwd = effectiveCwd;
			while (gIdx < tokens.length) {
				const gt = tokens[gIdx];
				if ((gt === "-C" || gt === "--work-tree") && gIdx + 1 < tokens.length) {
					gitCwd = path.resolve(gitCwd, tokens[gIdx + 1]);
					gIdx += 2;
					continue;
				}
				if (gt.startsWith("--work-tree=")) {
					gitCwd = path.resolve(gitCwd, gt.slice("--work-tree=".length));
					gIdx++;
					continue;
				}
				if (GIT_OPT_WITH_VALUE.has(gt) && gIdx + 1 < tokens.length) {
					gIdx += 2;
					continue;
				}
				if (
					GIT_OPT_NO_VALUE.has(gt) ||
					/^--(?:config-env|git-dir|work-tree|namespace)=\S+$/.test(gt)
				) {
					gIdx++;
					continue;
				}
				break;
			}

			if (tokens[gIdx] === "commit") {
				const commitArgs = tokens.slice(gIdx + 1);
				let isDryRun = false;
				let isInteractive = false;
				let includeWorktree = false;
				const explicitPaths = [];

				for (let aIdx = 0; aIdx < commitArgs.length; aIdx++) {
					const arg = commitArgs[aIdx];
					if (arg === "--") {
						explicitPaths.push(...commitArgs.slice(aIdx + 1));
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
					if (arg.startsWith("-")) continue;
					explicitPaths.push(arg);
					includeWorktree = true;
				}

				if (!(isDryRun && !isInteractive)) {
					invocations.push({
						cwd: gitCwd,
						includeWorktree,
						explicitPaths,
					});
				}
			}
		}

		finishSeg();
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
		const res = checkRepositoryDesignIntent(inv.cwd, {
			mode: "auto",
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
	parseRequirementDocument,
	evaluateArtifactIntent,
	isShapeOrCountOnlyCondition,
	extractGitCommitInvocations,
};
