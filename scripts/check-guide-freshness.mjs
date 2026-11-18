#!/usr/bin/env node
/**
 * 가이드가 설명하는 대상보다 낡았는지 센다.
 *
 * 2026-09-13 에 저장소 소유자가 짚은 악순환의 세 번째 고리입니다.
 *
 *   1. 가이드를 안 본다 → 코드를 뒤진다 → 그 탐색이 문맥을 채운다 (비용)
 *   2. 가이드를 안 본다 → 목적을 모른 채 코드가 말하는 방향으로 간다 (드리프트)
 *   3. 가이드를 안 보고 작업하니 **가이드를 갱신도 안 한다** → 가이드가 낡는다
 *   4. 낡은 가이드는 다음 사람도 안 본다 → 1 로
 *
 * 3 번의 실물 증거가 이 조사에서 나왔습니다. `discord-gateway-deployment.yaml` 의 한 인스턴스
 * `engine_source` 가 "custom Python gateway + OpenCode worker" 인데 현실은 grok 이었습니다.
 * 누군가 엔진을 바꾸면서 그 파일을 갱신하지 않았고, 저는 그 파일을 믿고 틀린 판단을 했습니다.
 *
 * 낡음을 두 가지로 셉니다.
 *
 *   **끊어진 참조** — 가이드가 가리키는 경로가 저장소에 없다. 확실한 낡음이다.
 *   **뒤처짐** — 가이드가 가리키는 파일이 가이드보다 나중에 바뀌었다. 후보일 뿐이다.
 *
 * 뒤처짐은 후보입니다. 가이드가 경로를 언급했다고 그 파일을 설명하는 것은 아니고, 사소한
 * 수정으로도 시각이 밀립니다. 그래서 기본은 보고만 하고, 끊어진 참조만 종료 코드로 막습니다.
 * 잠정 기준으로 CI 를 막으면 숫자를 검증하는 대신 숫자를 피해 가게 됩니다 —
 * `check-context-budget.mjs` 에서 배운 것입니다.
 *
 * 시각은 파일 mtime 이 아니라 **git 최종 커밋**으로 봅니다. 체크아웃이나 도구가 mtime 을
 * 건드려도 흔들리지 않습니다.
 *
 * 사용:
 *   node scripts/check-guide-freshness.mjs            # 끊어진 참조 + 뒤처짐 후보
 *   node scripts/check-guide-freshness.mjs --json
 *   node scripts/check-guide-freshness.mjs --days 30  # 뒤처짐 기준 (기본 14일)
 *   node scripts/check-guide-freshness.mjs --sync-check [--commit HEAD | --staged | --range main..HEAD | --files a,b]
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const daysIndex = argv.indexOf('--days');
const LAG_DAYS = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 14;

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

/** 가이드가 사는 곳. 진입점이 "행동하기 전에 읽어라"고 가리키는 자리다. */
const GUIDE_DIRS = ['.agents/context'];

/**
 * 가이드 본문에서 저장소 안의 경로를 뽑는다.
 *
 * 사람이 쓴 문장 안에 섞여 있으므로 완전하지 않다. 확실한 모양만 잡는다 — 슬래시가 있고
 * 확장자가 있거나 우리가 아는 최상위 디렉터리로 시작하는 것.
 */
const PATH_PATTERN = /(?:^|[\s"'`(\[<])((?:\.(?:agents|claude|codex|grok|opencode)|scripts|packages|projects|qa|docs)\/[\w./@-]+)/g;

/**
 * 그 줄이 "없어진 것"을 말하고 있는가.
 *
 * 가이드는 폐기·이전·삭제를 기록하기도 합니다. "projects/old-adk 는 폐기했다" 같은
 * 줄에서 그 경로가 없는 것은 정상이고, 그것을 끊어진 참조로 세면 매번 거짓 경보가 납니다.
 * 거짓 경보가 쌓이면 아무도 검사기를 안 보고, 그러면 진짜 낡음도 묻힙니다 — 한 운영 인스턴스의 검사기가
 * 15일간 발견을 보고했는데 아무도 안 본 사고가 그것이었습니다.
 */
const RETIRED_MARKERS = /폐기|삭제|제거|없앴|이전했|옮겼|더 이상|deprecated|removed|retired|no longer|legacy/i;

function lineOf(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

function referencedPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(PATH_PATTERN)) {
    let p = m[1].replace(/[.,;:)\]>'"`]+$/, '');
    if (!p || p.endsWith('/')) continue;
    // 와일드카드나 자리표시자는 대상이 아니다
    if (/[*?<>{}]/.test(p)) continue;
    // 없어졌다고 적은 줄의 경로는 끊어진 참조가 아니라 기록이다
    if (RETIRED_MARKERS.test(lineOf(text, m.index))) continue;
    out.add(p);
  }
  return [...out];
}

/** git 최종 커밋 시각(ms). 추적되지 않으면 null. */
const commitCache = new Map();
function lastCommitMs(rel) {
  if (commitCache.has(rel)) return commitCache.get(rel);
  let value = null;
  try {
    const out = cp.execFileSync('git', ['log', '-1', '--format=%ct', '--', rel],
      { cwd: ROOT, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) value = Number(out) * 1000;
  } catch { /* git 이 없거나 추적 밖 */ }
  commitCache.set(rel, value);
  return value;
}

function listGuides() {
  const out = [];
  for (const dir of GUIDE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!/\.(ya?ml|json|md)$/.test(name)) continue;
      out.push(`${dir}/${name}`);
    }
  }
  return out.sort();
}

export function scan({ lagDays = LAG_DAYS } = {}) {
  const guides = [];
  for (const rel of listGuides()) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    const guideAt = lastCommitMs(rel);
    const refs = referencedPaths(text);

    const missing = [];
    const newer = [];
    for (const ref of refs) {
      if (ref === rel) continue;
      const abs = path.join(ROOT, ref);
      if (!fs.existsSync(abs)) { missing.push(ref); continue; }
      if (guideAt === null) continue;
      const targetAt = lastCommitMs(ref);
      if (targetAt === null) continue;
      const lag = (targetAt - guideAt) / 86_400_000;
      if (lag > lagDays) newer.push({ ref, days: Math.round(lag) });
    }
    newer.sort((a, b) => b.days - a.days);
    guides.push({ rel, guideAt, refs: refs.length, missing, newer });
  }
  return guides;
}

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|sh)$/i;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|_(?:test|spec)\.(?:[cm]?[jt]sx?|py|sh)$|(?:^|\/)(?:test|selftest)[-_][^/]+\.(?:[cm]?[jt]sx?|py|sh)$|(?:^|\/)run-[^/]+-tests?\.[cm]?js$/i;
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|e2e|it)\//i;
const DOC_DIR_RE = /^(?:docs|rules|\.agents\/(?:context|requirements))\//i;
const DOC_FILE_RE = /(?:^|\/)(?:README|CHANGELOG|ARCHITECTURE|PLAN|FORK|AGENTS|CLAUDE|GEMINI|CONTRIBUTING)(?:\.[a-z0-9-]+)?\.md$|^scripts\/.+\.md$|^packages\/[^/]+\/(?:[^/]+\/)*README(?:\.[a-z0-9-]+)?\.md$|^\.agents\/skills\/[^/]+\/SKILL\.md$/i;
const CODE_PATH_RE = /^(?:packages\/[^/]+\/(?:(?:src|app|lib|bin|scripts)\/.+|[^/]+)|scripts\/.+|src\/.+)$/;
const DIR_STOPWORDS = new Set(['src', 'app', 'lib', 'bin', 'scripts', 'packages', 'docs', 'guides', 'design', 'specs', 'context', 'requirements', 'rules', 'tests', 'test', '__tests__', 'unit', 'integration', 'e2e', 'utils', 'helpers', 'common', 'shared']);
const STEM_STOPWORDS = new Set(['index', 'main', 'mod', 'types', 'constants', 'config']);

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function classifyChangedFile(filePath) {
  const rel = normalizeRel(filePath);
  if (!rel) return 'other';
  if (TEST_FILE_RE.test(rel) || (TEST_DIR_RE.test(rel) && CODE_EXT_RE.test(rel))) return 'test';
  if (DOC_DIR_RE.test(rel) || DOC_FILE_RE.test(rel)) return 'doc';
  if (CODE_EXT_RE.test(rel) && CODE_PATH_RE.test(rel)) return 'code';
  return 'other';
}

function stemOf(rel) {
  const base = path.posix.basename(normalizeRel(rel));
  return base
    .replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/i, '')
    .replace(/_(?:test|spec)\.(?:[cm]?[jt]sx?|py|sh)$/i, '')
    .replace(/^(?:test|selftest)[-_]/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/\.(?:ko|en)$/i, '');
}

function featureKeys(rel, { includePackage = false } = {}) {
  const norm = normalizeRel(rel);
  const parts = norm.split('/');
  const keys = new Set();
  const stem = stemOf(norm);
  if (stem.length >= 2 && !STEM_STOPWORDS.has(stem.toLowerCase())) {
    keys.add(stem.toLowerCase());
  }
  if (parts[0] === 'packages' && parts[1]) {
    if (includePackage) keys.add(parts[1].toLowerCase());
    const strippedPkg = parts[1].replace(/^naia-/, '');
    if (includePackage && strippedPkg.length >= 2) keys.add(strippedPkg.toLowerCase());
  }
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[0] === 'packages' && i <= 1) continue;
    const seg = parts[i].toLowerCase();
    if (seg.length >= 3 && !seg.startsWith('.') && !DIR_STOPWORDS.has(seg)) keys.add(seg);
  }
  return keys;
}

function shareKey(keysA, keysB) {
  for (const k of keysA) {
    if (keysB.has(k)) return true;
  }
  return false;
}

function readTextSafe(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
}

function targetMentionsCode(targetText, codeRel, { includePackage = false } = {}) {
  if (!targetText) return false;
  const norm = normalizeRel(codeRel);
  const base = path.posix.basename(norm);
  const stem = stemOf(norm);
  if (targetText.includes(norm) || targetText.includes(base)) return true;

  const candidates = [];
  if (stem.length >= 3 && !STEM_STOPWORDS.has(stem.toLowerCase())) {
    candidates.push(stem);
  } else {
    const parent = path.posix.basename(path.posix.dirname(norm));
    if (parent && parent.length >= 3 && !DIR_STOPWORDS.has(parent.toLowerCase())) {
      candidates.push(parent);
    }
  }
  for (const name of candidates) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^\\w-])${escaped}(?:$|[^\\w-])`, 'i').test(targetText)) return true;
  }

  if (includePackage) {
    const parts = norm.split('/');
    if (parts[0] === 'packages' && parts[1] && parts[1].length >= 3 && targetText.includes(parts[1])) {
      return true;
    }
  }
  return false;
}

export function extractMarkdownLinks(text) {
  const links = [];
  const lines = String(text || '').split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (RETIRED_MARKERS.test(line)) continue;
    const stripped = line.replace(/`[^`]*`/g, '');
    for (const m of stripped.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let raw = m[1].trim();
      if (raw.startsWith('<') && raw.includes('>')) raw = raw.slice(1, raw.indexOf('>')).trim();
      else raw = raw.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim();
      if (!raw || raw.startsWith('#')) continue;
      if (/^(?:https?:|mailto:|tel:|data:|javascript:|file:)/i.test(raw)) continue;
      if (/[*?<>{}]/.test(raw)) continue;
      const clean = raw.split('#')[0].split('?')[0].trim();
      if (!clean || clean === '...') continue;
      links.push({ target: clean, line: i + 1 });
    }
  }
  return links;
}

function collectBrokenDocLinks(root, docFiles) {
  const broken = [];
  for (const rel of docFiles) {
    if (!rel.toLowerCase().endsWith('.md')) continue;
    if (!rel.startsWith('docs/')) continue;
    const absDoc = path.join(root, rel);
    if (!fs.existsSync(absDoc)) continue;
    const text = readTextSafe(root, rel);
    const dirAbs = path.dirname(absDoc);
    for (const link of extractMarkdownLinks(text)) {
      const targetAbs = link.target.startsWith('/')
        ? path.resolve(root, link.target.slice(1))
        : path.resolve(dirAbs, link.target);
      if (!fs.existsSync(targetAbs)) {
        broken.push({ file: rel, target: link.target, line: link.line });
      }
    }
  }
  return broken;
}

function findUnmatchedCode(codeFiles, targetFiles, targetTexts, { includePackageKeys = false, directImportMap = new Map() } = {}) {
  const directlyCovered = new Set();
  const targetMeta = targetFiles.map((rel) => ({
    rel,
    keys: featureKeys(rel, { includePackage: includePackageKeys }),
    text: targetTexts.get(rel) || ''
  }));

  for (const codeRel of codeFiles) {
    const codeKeys = featureKeys(codeRel, { includePackage: includePackageKeys });
    for (const t of targetMeta) {
      if (shareKey(codeKeys, t.keys) || targetMentionsCode(t.text, codeRel, { includePackage: includePackageKeys })) {
        directlyCovered.add(codeRel);
        break;
      }
    }
  }

  // Transitive 1-hop: a changed helper/library module imported by a covered changed code module counts as covered
  const covered = new Set(directlyCovered);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const codeRel of codeFiles) {
      if (covered.has(codeRel)) continue;
      for (const parentRel of covered) {
        const parentText = directImportMap.get(parentRel) || '';
        if (targetMentionsCode(parentText, codeRel)) {
          covered.add(codeRel);
          expanded = true;
          break;
        }
      }
    }
  }

  return codeFiles.filter((rel) => !covered.has(rel));
}

export function checkChangeSync({ root = ROOT, files = [] } = {}) {
  const unique = [...new Set(files.map(normalizeRel).filter(Boolean))].sort();
  const classified = { code: [], tests: [], docs: [], other: [] };
  for (const rel of unique) {
    const kind = classifyChangedFile(rel);
    if (kind === 'test') classified.tests.push(rel);
    else if (kind === 'doc') classified.docs.push(rel);
    else if (kind === 'code') classified.code.push(rel);
    else classified.other.push(rel);
  }

  const testTexts = new Map(classified.tests.map((f) => [f, readTextSafe(root, f)]));
  const docTexts = new Map(classified.docs.map((f) => [f, readTextSafe(root, f)]));
  const codeTexts = new Map(classified.code.map((f) => [f, readTextSafe(root, f)]));

  const errors = [];
  let missingDocsFor = [];
  let missingTestsFor = [];

  if (classified.code.length > 0) {
    if (classified.docs.length === 0) {
      missingDocsFor = [...classified.code];
      errors.push({ code: 'missing_docs', files: missingDocsFor, message: '기능/스크립트 코드 변경에 대응하는 문서 변경이 없습니다.' });
    } else {
      missingDocsFor = findUnmatchedCode(classified.code, classified.docs, docTexts, { includePackageKeys: true, directImportMap: codeTexts });
      if (missingDocsFor.length > 0) {
        errors.push({ code: 'unmatched_doc', files: missingDocsFor, message: '변경된 코드와 연결되는 문서 변경을 찾지 못했습니다.' });
      }
    }

    if (classified.tests.length === 0) {
      missingTestsFor = [...classified.code];
      errors.push({ code: 'missing_tests', files: missingTestsFor, message: '기능/스크립트 코드 변경에 대응하는 시험 파일 변경이 없습니다.' });
    } else {
      missingTestsFor = findUnmatchedCode(classified.code, classified.tests, testTexts, { includePackageKeys: false, directImportMap: codeTexts });
      if (missingTestsFor.length > 0) {
        errors.push({ code: 'unmatched_test', files: missingTestsFor, message: '변경된 코드와 연결되는 시험 파일 변경을 찾지 못했습니다.' });
      }
    }
  }

  const brokenLinks = collectBrokenDocLinks(root, classified.docs);
  if (brokenLinks.length > 0) {
    errors.push({ code: 'broken_doc_link', links: brokenLinks, message: '변경된 문서 안에 깨진 상대 링크가 있습니다.' });
  }

  return {
    ok: errors.length === 0,
    files: unique,
    classified,
    missingDocsFor,
    missingTestsFor,
    brokenLinks,
    errors
  };
}

function readArgValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return null;
  const val = argv[idx + 1];
  return val.startsWith('--') ? null : val;
}

function readFilesArg() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--files') continue;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) {
      for (const part of argv[j].split(',')) {
        const t = part.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

function gitChangedFiles(root, gitArgs) {
  const out = cp.execFileSync('git', ['-c', 'core.quotepath=false', ...gitArgs], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function resolveSyncFiles(root) {
  if (argv.includes('--files')) return { source: 'files', files: readFilesArg() };
  if (argv.includes('--staged')) {
    return { source: 'staged', files: gitChangedFiles(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']) };
  }
  const range = readArgValue('--range');
  if (range) {
    return { source: `range:${range}`, files: gitChangedFiles(root, ['diff', '--name-only', '--diff-filter=ACMR', range]) };
  }
  const commit = readArgValue('--commit') || 'HEAD';
  return {
    source: `commit:${commit}`,
    files: gitChangedFiles(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '--diff-filter=ACMR', commit])
  };
}

function runSyncCheck() {
  const rootArg = readArgValue('--root');
  const targetRoot = rootArg ? path.resolve(rootArg) : ROOT;
  const { source, files } = resolveSyncFiles(targetRoot);
  const result = checkChangeSync({ root: targetRoot, files });

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ source, ...result }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  const c = result.classified;
  process.stdout.write(
    `변경 동기화 검사 (${source}) · 파일 ${result.files.length}개 `
    + `(code ${c.code.length}, test ${c.tests.length}, doc ${c.docs.length}, other ${c.other.length})\n`);

  if (result.ok) {
    process.stdout.write('변경된 코드·문서·시험 동기화 통과.\n');
    return 0;
  }

  for (const err of result.errors) {
    process.stdout.write(`\n[FAIL] ${err.code}: ${err.message}\n`);
    for (const f of err.files || []) process.stdout.write(`  - ${f}\n`);
    for (const l of err.links || []) process.stdout.write(`  - ${l.file}:${l.line} -> ${l.target}\n`);
  }
  return 1;
}

function main() {
  if (argv.includes('--sync-check')) return runSyncCheck();

  const guides = scan();
  const broken = guides.filter((g) => g.missing.length);
  const stale = guides.filter((g) => g.newer.length);
  const totalRefs = guides.reduce((s, g) => s + g.refs, 0);

  process.stdout.write(
    `가이드 ${guides.length}개 · 참조 ${totalRefs}개 · 끊어진 참조 ${broken.reduce((s, g) => s + g.missing.length, 0)}개 · `
    + `${LAG_DAYS}일 이상 뒤처진 가이드 ${stale.length}개\n`);

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ guides }, null, 2)}\n`);
    return broken.length ? 1 : 0;
  }

  if (broken.length) {
    process.stdout.write('\n끊어진 참조 — 가이드가 가리키는 파일이 없습니다\n');
    for (const g of broken) {
      process.stdout.write(`  ${g.rel}\n`);
      for (const m of g.missing.slice(0, 6)) process.stdout.write(`      ${m}\n`);
      if (g.missing.length > 6) process.stdout.write(`      … 외 ${g.missing.length - 6}개\n`);
    }
  }

  if (stale.length) {
    process.stdout.write(`\n뒤처짐 후보 — 대상이 가이드보다 ${LAG_DAYS}일 이상 나중에 바뀌었습니다\n`);
    process.stdout.write('  (후보일 뿐입니다. 언급했다고 설명하는 것은 아니므로 사람이 봐야 합니다)\n');
    for (const g of stale.sort((a, b) => b.newer[0].days - a.newer[0].days).slice(0, 12)) {
      const head = g.newer[0];
      process.stdout.write(`  ${g.rel}  (가장 큰 차이 ${head.days}일: ${head.ref}${g.newer.length > 1 ? ` 외 ${g.newer.length - 1}개` : ''})\n`);
    }
  }

  if (!broken.length && !stale.length) process.stdout.write('\n가이드가 대상보다 낡지 않았습니다.\n');
  // 끊어진 참조만 막는다. 뒤처짐은 후보라 보고만 한다.
  return broken.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
