#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ENTRY_POINTS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
// CLAUDE.md and GEMINI.md are one-line `@AGENTS.md` imports, not copies: some
// CLIs attach both AGENTS.md and CLAUDE.md, so a byte mirror is paid twice on
// every model call. AGENTS.md is capped at MAX_CANONICAL_BYTES; long procedures
// belong in on-demand docs (.agents/context/context-budget.json).
// Re-approved 2026-09-23 by the owner for the context-budget change: pointer
// mirrors, the size cap, and the where-to-write rule in Context Routing.
const POINTER = '@AGENTS.md\n';
const MAX_CANONICAL_BYTES = 12000;
const APPROVED_CANONICAL_SHA256 = '41ac3cb475e0a7683ba766e1b2aa0903e1d9093f204c7b9dcb20d8192fd97597';
const ALLOWED_H2 = new Set([
  'Repository Index', '저장소 인덱스',
  'Mandatory Reads', '필수 읽기',
  'Context Routing', '컨텍스트 라우팅',
  'Session Boundaries', '세션 경계',
  'Safety Boundaries', '안전 경계',
  'Mirrors', '미러',
]);
const SESSION_CONTENT_PATTERNS = [
	/^\s*(?:(?:[-*+]\s+|\d+\.\s+)?\*{0,2})(?:issue|phase|status|deadline|current task|current goal)\*{0,2}\s*[:—-]/gim,
	/^\s*(?:(?:[-*+]\s+|\d+\.\s+)?\*{0,2})(?:현재 작업|현재 목표|현재 단계|마감|완료 상태|구현 계획|제품 문구)\*{0,2}\s*[:—-]/gm,
	/<!--\s*(?:session|current-work|implementation-plan)\b/i,
];

function paragraphViolations(lines) {
	const violations = [];
	let section = "preamble";
	let paragraph = [];
	const flush = () => {
		if (paragraph.length === 0) return;
		const text = paragraph.join(" ").trim();
		if (section === "Repository Index" || section === "저장소 인덱스") {
			if (paragraph.some((line) => !/^-\s+/.test(line)) || !/`[^`]+`/.test(text)) violations.push("repository index accepts only path-bearing bullets");
		} else if (section === "Mandatory Reads" || section === "필수 읽기") {
			const intro = /^(?:Read these before acting|작업 전.*읽)/i.test(text);
			const ordered = paragraph.every((line) => /^\d+\.\s+/.test(line));
			if (!intro && !ordered && !/`[^`]+`/.test(text)) violations.push("mandatory reads paragraph lacks a routed path");
		} else if (section !== "preamble") {
			const stableBoundary = /^(?:These shared entrypoints are repository indexes|이 공유 진입점은 저장소 인덱스)/i.test(text);
			if (!stableBoundary && !/`[^`]+`/.test(text)) violations.push(`unrouted prose in ${section}`);
		} else if (text.length > 320) {
			violations.push("repository description exceeds preamble budget");
		}
		paragraph = [];
	};
	for (const line of lines.slice(1)) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) { flush(); section = heading[1]; continue; }
		if (!line.trim()) { flush(); continue; }
		paragraph.push(line.trim());
	}
	flush();
	return violations;
}

function findRepoRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function eventFilePath(event) {
  return event?.tool_response?.filePath || event?.tool_response?.file_path ||
    event?.tool_input?.file_path || event?.tool_input?.path || String();
}

function atomicWrite(destination, content) {
  const temp = `${destination}.sync-${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, destination);
}

function entrypointViolations(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
  const violations = [];
  const lines = text.split(/\r?\n/);
  const h1 = lines.filter((line) => /^#\s+\S/.test(line));
  if (h1.length !== 1) violations.push('exactly one repository title is required');
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match && !ALLOWED_H2.has(match[1])) violations.push(`disallowed section: ${match[1]}`);
    if (/^###\s+/.test(line)) violations.push(`detail section is not index-only: ${line.slice(4)}`);
  }
	for (const pattern of SESSION_CONTENT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) violations.push(`session-specific content: ${pattern.source}`);
	}
	violations.push(...paragraphViolations(lines));
  if (lines.length > 120) violations.push(`entrypoint exceeds index budget: ${lines.length} lines`);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CANONICAL_BYTES) violations.push(`entrypoint exceeds ${MAX_CANONICAL_BYTES} bytes: ${bytes}`);
  return [...new Set(violations)];
}

function approvedDigestViolation(content, root) {
  if (!root || path.resolve(root) !== findRepoRoot(__dirname)) return null;
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  return digest === APPROVED_CANONICAL_SHA256 ? null : `canonical digest is not approved: ${digest}`;
}

function validateEntryPoint(content, root = null) {
  const violations = entrypointViolations(content);
  const digestViolation = approvedDigestViolation(content, root);
  if (digestViolation) violations.push(digestViolation);
  if (violations.length) throw new Error(`Entrypoint boundary violation: ${violations.join('; ')}`);
  return true;
}

function syncEntryPoints(root, changed) {
  const changedName = path.basename(changed);
  if (!ENTRY_POINTS.includes(changedName) || path.dirname(path.resolve(changed)) !== path.resolve(root)) return [];
  // AGENTS.md is the only source of truth. Editing a tool-specific pointer must
  // never overwrite the canonical contract; restore every pointer instead.
  const source = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(source)) return [];
  validateEntryPoint(fs.readFileSync(source), root);
  const updated = [];
  for (const name of ENTRY_POINTS.slice(1)) {
    const target = path.join(root, name);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== POINTER) {
      atomicWrite(target, POINTER);
      updated.push(name);
    }
  }
  return updated;
}

function checkEntryPoints(root) {
  const canonical = fs.readFileSync(path.join(root, 'AGENTS.md'));
  const failures = entrypointViolations(canonical).map((violation) => `AGENTS.md: ${violation}`);
  const digestViolation = approvedDigestViolation(canonical, root);
  if (digestViolation) failures.push(`AGENTS.md: ${digestViolation}`);
  return failures.concat(ENTRY_POINTS.slice(1).filter((name) =>
    !fs.existsSync(path.join(root, name)) || fs.readFileSync(path.join(root, name), 'utf8') !== POINTER));
}

function readHookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

function runHook() {
  const root = findRepoRoot(process.cwd());
  if (!root) return 0;
  if (process.argv.includes('--check')) return checkEntryPoints(root).length ? 1 : 0;
  const applyIndex = process.argv.indexOf('--apply');
  if (applyIndex !== -1) {
    const candidate = process.argv[applyIndex + 1];
    if (!candidate) throw new Error('--apply requires a candidate file');
    const content = fs.readFileSync(path.resolve(candidate));
    validateEntryPoint(content, root);
    atomicWrite(path.join(root, 'AGENTS.md'), content);
    for (const name of ENTRY_POINTS.slice(1)) atomicWrite(path.join(root, name), POINTER);
    return 0;
  }
  const inputPath = eventFilePath(readHookInput());
  if (!inputPath) return 0;
  const changed = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
  const updated = syncEntryPoints(root, changed);
  if (updated.length) console.log('[entry-sync] updated ' + updated.join(', '));
  return 0;
}

if (require.main === module) process.exitCode = runHook();
module.exports = { APPROVED_CANONICAL_SHA256, ENTRY_POINTS, MAX_CANONICAL_BYTES, POINTER, approvedDigestViolation, checkEntryPoints, entrypointViolations, eventFilePath, findRepoRoot, paragraphViolations, syncEntryPoints, validateEntryPoint };
