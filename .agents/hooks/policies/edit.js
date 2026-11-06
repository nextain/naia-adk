/**
 * Tool-agnostic Edit|Write hook policies (G-OC01 part2 — neutralization).
 *
 * Pure: (data, opts?) → { allow:true } | { block:<reason> } |
 *   { postContext:<str> } | null.  No host I/O envelope, no process.exit.
 * Shared by .claude/hooks/_claude-edit-hook.js (Claude) and the pi
 * adapter. Behavior byte-identical to the part1 S3 adapters.
 *
 * design-doc unlock file is __dirname-dependent → adapter passes it via
 * opts.unlockFile (adapter knows its own __dirname). Others have no path
 * dependency.
 */
const fs = require("fs");
const { existsSync } = fs;
const path = require("path");
const { createHash } = require("crypto");

/** design-doc-guard. opts.unlockFile REQUIRED (adapter: resolve(__dirname,"..","design-doc-unlock")). */
function designDoc(data, opts) {
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";
	const normalized = filePath.replace(/\\/g, "/");
	const hasDesignExt = /\.(md|txt|yaml|json)$/.test(normalized);
	const isDesignDoc =
		(/\/docs\/design\//.test(normalized) && hasDesignExt) ||
		(/\/design\//.test(normalized) && hasDesignExt) ||
		(/\/spec\//.test(normalized) && hasDesignExt);
	if (!isDesignDoc) return null;
	if (existsSync(opts.unlockFile)) return { allow: true };
	return {
		block:
			`[Harness] 설계 문서 편집 차단: ${filePath}\n` +
			"\n" +
			"설계 문서에서 AI의 역할은 기본적으로 리뷰어입니다.\n" +
			"현재 사용자의 범위가 정해진 요청이 이 문서의 작성·수정·기록을 명시했다면\n" +
			"재승인을 묻지 말고 임시 unlock을 활성화해 요청 범위만 편집하세요.\n" +
			"그 외에는 아래 중 무엇인지 사용자에게 먼저 보고하세요:\n" +
			"\n" +
			"  (A) 오타/문법 수정        → 사용자에게 보고 후 진행 가능\n" +
			"  (B) 문서 내부 모순 수정   → 사용자에게 보고 후 진행 가능\n" +
			"  (C) 깨진 링크/참조 수정   → 사용자에게 보고 후 진행 가능\n" +
			"  (D) 설계 결정 변경        → 사용자 명시적 승인 필수\n" +
			"  (E) 구현이 설계와 다름    → 편집 금지. 에스컬레이션 경로 따를 것:\n" +
			"      1. GitHub Issue 코멘트: 설계-구현 괴리 발견 내용 + 선택지 제시\n" +
			"      2. 사용자 결정 대기\n" +
			"\n" +
			`명시 요청 또는 사용자 승인 후: ${(opts && opts.unlockHint) || ".claude/design-doc-unlock"} 파일 생성 → 편집 → 파일 삭제\n`,
	};
}

/** prod-gateway-guard */
function prodGateway(data) {
	const filePath = data.tool_input?.file_path || "";
	const isEnvLocal =
		filePath.endsWith(".env.local") ||
		filePath.endsWith("/.env") ||
		filePath === ".env";
	if (!isEnvLocal) return null;
	// Prod gateway host/key are NOT embedded as literals (this file is public).
	// URL is matched by its stable host prefix; the key is matched by SHA-256
	// digest so the literal secret never lives in the repo. The maintainer fork
	// may override the host prefix / key digest via env without code changes.
	const PROD_GATEWAY_HOST_FRAGMENT =
		process.env.PROD_GATEWAY_HOST_FRAGMENT || "naia-gateway-";
	const PROD_MASTER_KEY_SHA256 =
		process.env.PROD_MASTER_KEY_SHA256 ||
		"800749e91c9a52d265927d03d0b4281052da96c898a7607d3feb9c969e6230de";
	const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
	const contentToCheck =
		data.tool_input?.content || data.tool_input?.new_string || "";
	const hasProdUrl =
		/naia-gateway-\d{6,}\.[a-z0-9-]+\.run\.app/.test(contentToCheck) &&
		contentToCheck.includes(PROD_GATEWAY_HOST_FRAGMENT) &&
		!/naia-gateway-dev-/.test(contentToCheck);
	const hasProdKey = [...contentToCheck.matchAll(/[A-Za-z0-9_-]{20,}/g)].some(
		(m) => sha256(m[0]) === PROD_MASTER_KEY_SHA256,
	);
	if (hasProdUrl || hasProdKey) {
		const detected = [
			hasProdUrl ? "prod GATEWAY_URL" : null,
			hasProdKey ? "prod MASTER_KEY" : null,
		].filter(Boolean).join(", ");
		return {
			block:
				`[Harness] prod 게이트웨이 자격증명 차단: ${detected}\n` +
				".env.local에는 dev 게이트웨이를 사용해야 합니다.\n\n" +
				"  DEV URL:  <DEV_GATEWAY_URL — .env.local 에서 주입, 레포 커밋 금지>\n" +
				"  DEV KEY:  <DEV_GATEWAY_KEY — .env.local 에서 주입, 레포 커밋 금지>\n\n" +
				"prod 값은 .env.production.local에만 허용됩니다.",
		};
	}
	return null;
}

/** cascade-check (PostToolUse) — mirror reminders */
function cascadeCheck(data) {
	const filePath = data.tool_input?.file_path || data.parameters?.file_path || "";
	const reminders = [];
	const normalized = filePath.replace(/\\/g, "/");
	const agentsMatch = normalized.match(/\.agents\/context\/([^/]+)\.(yaml|json)$/);
	if (agentsMatch) {
		const baseName = agentsMatch[1];
		reminders.push(
			`[Harness] You edited .agents/context/${baseName}.${agentsMatch[2]}. ` +
				`Triple-mirror rule: also update .users/context/${baseName}.md and .users/context/en/${baseName}.md if they exist.`,
		);
	}
	const usersKoMatch = normalized.match(/\.users\/context\/([^/]+)\.md$/);
	if (usersKoMatch && !normalized.includes("/en/")) {
		const baseName = usersKoMatch[1];
		reminders.push(
			`[Harness] You edited .users/context/${baseName}.md. ` +
				`Triple-mirror rule: also update .agents/context/${baseName}.yaml (or .json) and .users/context/en/${baseName}.md if they exist.`,
		);
	}
	const usersEnMatch = normalized.match(/\.users\/context\/en\/([^/]+)\.md$/);
	if (usersEnMatch) {
		const baseName = usersEnMatch[1];
		reminders.push(
			`[Harness] You edited .users/context/en/${baseName}.md. ` +
				`Triple-mirror rule: also update .agents/context/${baseName}.yaml (or .json) and .users/context/${baseName}.md if they exist.`,
		);
	}
	const agentsSkillMatch = normalized.match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/);
	if (agentsSkillMatch) {
		const skillName = agentsSkillMatch[1];
		reminders.push(
			`[Harness] You edited .agents/skills/${skillName}/SKILL.md. ` +
				`Mirror rule: also update .users/skills/${skillName}/SKILL.md if it exists.`,
		);
	}
	const usersSkillMatch = normalized.match(/\.users\/skills\/([^/]+)\/SKILL\.md$/);
	if (usersSkillMatch) {
		const skillName = usersSkillMatch[1];
		reminders.push(
			`[Harness] You edited .users/skills/${skillName}/SKILL.md. ` +
				`Mirror rule: also update .agents/skills/${skillName}/SKILL.md if it exists.`,
		);
	}
	if (/(?:^|\/)agents-rules(?:-detail)?\.json$/.test(normalized)) {
		reminders.push(
			"[Harness] agents-rules.json and agents-rules-detail.json are the SoT. " +
				"You MUST update .users/context/agents-rules.md and .users/context/en/agents-rules.md to match.",
		);
	}
	if (reminders.length > 0) return { postContext: reminders.join("\n") };
	return null;
}

const DEFAULT_CODE_EXTENSIONS = [
	".py",
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".rs",
	".go",
	".sh",
];

const DEFAULT_ALLOWED_NUMERIC_STEMS = [
	"oauth1",
	"oauth2",
	"http1",
	"http2",
	"http3",
	"h2",
	"h3",
	"md5",
	"sha1",
	"sha224",
	"sha256",
	"sha384",
	"sha512",
	"blake2",
	"blake2b",
	"blake2s",
	"blake3",
	"crc32",
	"base16",
	"base32",
	"base58",
	"base62",
	"base64",
	"utf8",
	"utf16",
	"utf32",
	"i18n",
	"l10n",
	"g11n",
	"a11y",
	"o11y",
	"k8s",
	"p2p",
	"b2b",
	"b2c",
	"e2e",
	"web3",
	"webgl2",
	"ipv4",
	"ipv6",
	"x86",
	"x64",
	"arm64",
	"aarch64",
	"wasm32",
	"wasm64",
	"win32",
	"win64",
	"int8",
	"int16",
	"int32",
	"int64",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"float16",
	"float32",
	"float64",
	"f16",
	"f32",
	"f64",
	"i32",
	"i64",
	"u8",
	"u16",
	"u32",
	"u64",
	"s3",
	"ec2",
	"r2",
	"d3",
	"v8",
	"2d",
	"3d",
	"h264",
	"h265",
	"av1",
	"vp8",
	"vp9",
	"mp3",
	"mp4",
	"ed25519",
	"x25519",
	"p256",
	"p384",
	"p521",
	"secp256k1",
	"aes128",
	"aes256",
	"chacha20",
	"poly1305",
	"argon2",
	"pbkdf2",
	"sqlite3",
	"python2",
	"python3",
	"py2",
	"py3",
	"jinja2",
	"psycopg2",
	"boto3",
	"urllib3",
	"catch2",
	"ros2",
	"sdl2",
	"gtk3",
	"gtk4",
	"qt5",
	"qt6",
	"vue2",
	"vue3",
];

function readEditDriftConfigFromDir(dir) {
	if (!dir) return null;
	const driftJsonPath = path.join(dir, ".agents", "context", "drift-guard.json");
	if (existsSync(driftJsonPath)) {
		try {
			return JSON.parse(fs.readFileSync(driftJsonPath, "utf8"));
		} catch {
			/* ignore */
		}
	}
	for (const rulesFile of ["agents-rules.json", "agents-rules-detail.json"]) {
		const rulesPath = path.join(dir, ".agents", "context", rulesFile);
		if (!existsSync(rulesPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
			const dg = parsed?.conventions?.drift_guard || parsed?.drift_guard;
			if (dg && typeof dg === "object") return dg;
		} catch {
			/* ignore */
		}
	}
	return null;
}

function loadEditDriftConfig(cwd, opts) {
	let codeExts = null;
	if (opts && Array.isArray(opts.codeExtensions) && opts.codeExtensions.length > 0) {
		codeExts = opts.codeExtensions.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));
	}
	const allowedSet = new Set(DEFAULT_ALLOWED_NUMERIC_STEMS.map((s) => s.toLowerCase()));
	if (opts && Array.isArray(opts.allowedNumericStems)) {
		for (const s of opts.allowedNumericStems) {
			if (typeof s === "string" && s.trim()) allowedSet.add(s.trim().toLowerCase());
		}
	}

	const dirsToCheck = [];
	let cur = path.resolve(cwd || process.cwd());
	while (cur) {
		dirsToCheck.push(cur);
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	const wsRoot = path.resolve(__dirname, "..", "..", "..");
	if (!dirsToCheck.includes(wsRoot)) dirsToCheck.push(wsRoot);

	for (const d of dirsToCheck) {
		const cfg = readEditDriftConfigFromDir(d);
		if (!cfg) continue;
		if (!codeExts && Array.isArray(cfg.code_extensions) && cfg.code_extensions.length > 0) {
			codeExts = cfg.code_extensions
				.filter((e) => typeof e === "string" && e.trim())
				.map((e) => {
					const t = e.trim().toLowerCase();
					return t.startsWith(".") ? t : `.${t}`;
				});
		}
		if (Array.isArray(cfg.allowed_numeric_stems)) {
			for (const s of cfg.allowed_numeric_stems) {
				if (typeof s === "string" && s.trim()) allowedSet.add(s.trim().toLowerCase());
			}
		}
	}

	return {
		codeExts: codeExts && codeExts.length > 0 ? codeExts : DEFAULT_CODE_EXTENSIONS,
		allowedSet,
	};
}

function isTestFileName(name) {
	return (
		/^test_/i.test(name) ||
		/\.test\.[^.]+$/i.test(name) ||
		/_test\.[^.]+$/i.test(name)
	);
}

const ATTACHED_V_DIGIT_RE = /(?<=[A-Za-z])v\d+$/i;
const BARE_DIGIT_RE = /(?<=[A-Za-z])\d+$/i;

const VARIANT_SUFFIX_PATTERNS = [
	/\s*\(\d+\)$/i,
	/\s*\(copy(?:\s*\d+)?\)$/i,
	/[_.-]+v\d+(?:[._-]\d+)*$/i,
	ATTACHED_V_DIGIT_RE,
	/[_.-]+(?:new|old|copy|copied|backup|bak|fixed|fix|final|orig|original|temp|tmp|draft|alt|dup|duplicate|clone|mod|modified|patched|edited|wip|rev\d*|r\d+)(?:[_.-]*\d+)?$/i,
	/[_-]+\d+$/i,
	BARE_DIGIT_RE,
];

function isCanonicalNumericToken(stem, allowedSet) {
	if (!stem) return false;
	const set = allowedSet || new Set(DEFAULT_ALLOWED_NUMERIC_STEMS);
	const lower = stem.toLowerCase();
	if (set.has(lower)) return true;
	const parts = lower.split(/[_.-]+/);
	const lastPart = parts[parts.length - 1];
	return Boolean(lastPart && set.has(lastPart));
}

function stripVariantSuffixes(stem, allowedSet) {
	let current = stem;
	let changed = true;
	while (changed) {
		changed = false;
		for (const pattern of VARIANT_SUFFIX_PATTERNS) {
			if (
				(pattern === BARE_DIGIT_RE || pattern === ATTACHED_V_DIGIT_RE) &&
				isCanonicalNumericToken(current, allowedSet)
			) {
				continue;
			}
			const next = current.replace(pattern, "");
			if (next && next !== current) {
				current = next;
				changed = true;
				break;
			}
		}
	}
	return current;
}

function maskNonCanonicalNumbers(lowerStem, allowedSet) {
	const set = allowedSet || new Set(DEFAULT_ALLOWED_NUMERIC_STEMS);
	if (set.has(lowerStem)) return lowerStem;
	return lowerStem
		.split(/([_.-]+)/)
		.map((part) => {
			if (/^[_.-]+$/.test(part)) return part;
			if (set.has(part)) return part;
			return part.replace(/\d+/g, "#");
		})
		.join("");
}

function isVariantStem(newStem, existingStem, sameExt, allowedSet) {
	if (!newStem || !existingStem) return false;
	const newLower = newStem.toLowerCase();
	const existingLower = existingStem.toLowerCase();
	if (newLower === existingLower) return false;

	const newBase = stripVariantSuffixes(newStem, allowedSet).toLowerCase();
	const existingBase = stripVariantSuffixes(existingStem, allowedSet).toLowerCase();

	// New file has a variant suffix over the existing file's stem (or shared base stem)
	if (newBase !== newLower && (newBase === existingLower || (sameExt && newBase === existingBase))) {
		return true;
	}

	// Differ only by numbers (e.g. render_scale085 vs render_scale082, foo1 vs foo2)
	if (sameExt && /\d/.test(newLower) && /\d/.test(existingLower)) {
		const newSkeleton = maskNonCanonicalNumbers(newLower, allowedSet);
		const existingSkeleton = maskNonCanonicalNumbers(existingLower, allowedSet);
		if (
			newSkeleton.includes("#") &&
			newSkeleton === existingSkeleton &&
			/[a-z]{2,}/i.test(newSkeleton)
		) {
			return true;
		}
	}

	return false;
}

function collectCandidatePaths(data) {
	const out = [];
	const primary =
		data?.tool_input?.file_path ||
		data?.tool_input?.notebook_path ||
		data?.tool_input?.path ||
		data?.parameters?.file_path ||
		data?.parameters?.notebook_path ||
		"";
	if (primary && typeof primary === "string") out.push(primary);
	if (Array.isArray(data?.tool_input?.edits)) {
		for (const item of data.tool_input.edits) {
			const p = item && (item.file_path || item.notebook_path || item.path);
			if (p && typeof p === "string" && !out.includes(p)) out.push(p);
		}
	}
	return out;
}

/**
 * duplicateCodeFile — block creating a new code file in the same folder when its
 * name is a copy/version variant of an existing code file. Editing an existing
 * file, test files (test_*, *.test.*, *_test.*), and migrations/ are allowed.
 */
function duplicateCodeFile(data, opts) {
	const candidatePaths = collectCandidatePaths(data);
	if (candidatePaths.length === 0) return null;

	const cwd = (opts && opts.cwd) || (data && data.cwd) || process.cwd();
	const { codeExts, allowedSet } = loadEditDriftConfig(cwd, opts);
	const effectiveCodeExts =
		data?.tool_name === "NotebookEdit" && !codeExts.includes(".ipynb")
			? [...codeExts, ".ipynb"]
			: codeExts;

	for (const filePath of candidatePaths) {
		const absPath = path.resolve(cwd, filePath);

		// Only applies when creating a new file; editing an existing file is allowed
		if (existsSync(absPath)) continue;

		const ext = path.extname(absPath).toLowerCase();
		if (!effectiveCodeExts.includes(ext)) continue;

		const normalized = absPath.replace(/\\/g, "/");
		if (/(?:^|\/)migrations\//i.test(normalized)) continue;

		const baseName = path.basename(absPath);
		if (isTestFileName(baseName)) continue;

		const dir = path.dirname(absPath);
		const siblingNames = [];
		if (existsSync(dir)) {
			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isFile() || entry.isSymbolicLink()) {
						siblingNames.push(entry.name);
					}
				}
			} catch {
				/* ignore */
			}
		}
		if (opts && Array.isArray(opts.extraSiblings)) {
			for (const extra of opts.extraSiblings) {
				if (typeof extra === "string" && extra && !siblingNames.includes(extra)) {
					siblingNames.push(extra);
				}
			}
		}
		if (siblingNames.length === 0) continue;

		const newStem = baseName.slice(0, baseName.length - ext.length);

		for (const existingName of siblingNames) {
			if (existingName === baseName) continue;
			if (isTestFileName(existingName)) continue;

			const existingExt = path.extname(existingName).toLowerCase();
			if (!effectiveCodeExts.includes(existingExt)) continue;

			const existingStem = existingName.slice(0, existingName.length - existingExt.length);
			const sameExt = existingExt === ext;
			if (isVariantStem(newStem, existingStem, sameExt, allowedSet)) {
				return {
					block:
						`[Harness] 사본 코드 파일 생성 차단: ${filePath} (같은 폴더의 ${existingName} 변형)\n` +
						"새 사본 파일을 만들지 말고 원래 파일을 고치세요.",
				};
			}
		}
	}

	return null;
}

module.exports = {
	designDoc,
	prodGateway,
	cascadeCheck,
	duplicateCodeFile,
	isVariantStem,
	stripVariantSuffixes,
	DEFAULT_CODE_EXTENSIONS,
	DEFAULT_ALLOWED_NUMERIC_STEMS,
};
