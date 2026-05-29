#!/usr/bin/env node
// scaffold.mjs — naia-template-project placeholder 치환 (결정론적).
//
// template-project base를 복제한 뒤, 텍스트 파일 전체에서 placeholder를 치환한다.
//   {{PROJECT_NAME}}        → --name
//   {{PROJECT_DESCRIPTION}} → --description
//   {{DATE}}                → --date (생략 시 오늘, YYYY-MM-DD)
//
// 사용:
//   node scaffold.mjs --root <dir> --name <name> --description <desc> [--date YYYY-MM-DD] [--dry]
//
// 의존성 없음(Node 내장만). 바이너리/무시 디렉토리는 건너뛴다.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', 'build']);
// 치환 대상 확장자(텍스트). 그 외는 안전을 위해 건너뜀.
const TEXT_EXT = new Set([
  '.md', '.json', '.yaml', '.yml', '.mjs', '.js', '.ts', '.sh',
  '.txt', '.html', '.css', '.toml', '.env', '',
]);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry') { a.dry = true; continue; }
    if (k.startsWith('--')) { a[k.slice(2)] = argv[++i]; }
  }
  return a;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile()) yield full;
  }
}

const args = parseArgs(process.argv.slice(2));
const root = args.root;
if (!root || !args.name || !args.description) {
  console.error('usage: node scaffold.mjs --root <dir> --name <name> --description <desc> [--date YYYY-MM-DD] [--dry]');
  process.exit(2);
}

const repl = {
  '{{PROJECT_NAME}}': args.name,
  '{{PROJECT_DESCRIPTION}}': args.description,
  '{{DATE}}': args.date || today(),
};
const keys = Object.keys(repl);

let filesChanged = 0;
let totalSubs = 0;
for (const file of walk(root)) {
  if (!TEXT_EXT.has(extname(file).toLowerCase())) continue;
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }
  let subs = 0;
  let out = content;
  for (const k of keys) {
    const parts = out.split(k);
    if (parts.length > 1) { subs += parts.length - 1; out = parts.join(repl[k]); }
  }
  if (subs > 0) {
    filesChanged++;
    totalSubs += subs;
    if (!args.dry) writeFileSync(file, out);
    console.log(`${args.dry ? '[dry] ' : ''}${file}: ${subs}건`);
  }
}

console.log(`\n${args.dry ? '[dry] ' : ''}완료: ${filesChanged}개 파일, ${totalSubs}건 치환`);
console.log(`치환값: name=${repl['{{PROJECT_NAME}}']}, date=${repl['{{DATE}}']}`);
