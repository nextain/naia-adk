#!/usr/bin/env node
// systemd 단위가 요구하는 경로가 있는지 본다. '-' 없는 경로가 하나라도 없으면 서비스가 네임스페이스 준비에서 멈춘다.
// 사용: check-unit-paths.mjs <단위 파일>... (서비스를 시작하기 전에 돌린다. 없으면 종료 1)
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const PATH_KEYS = /^(ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|ExecPaths|NoExecPaths)=(.*)$/;
export function requiredPaths(unitText) {
  const paths = [];
  for (const line of unitText.split('\n')) {
    const match = PATH_KEYS.exec(line.trim());
    if (!match) continue;
    for (const word of match[2].split(/\s+/).filter(Boolean)) {
      // '-' 는 없어도 된다는 표시다. '+' 는 그 경로를 뿌리 기준으로 보라는 표시라 경로에 넣지 않는다.
      if (word.startsWith('-')) continue;
      paths.push({ key: match[1], path: word.replace(/^\+/, '') });
    }
  }
  return paths;
}
export function missingPaths(unitText, exists = existsSync) {
  return requiredPaths(unitText).filter(({ path }) => !exists(path));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('check-unit-paths.mjs <단위 파일>...'); process.exitCode = 2; }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const missing = missingPaths(text);
    for (const { key, path } of missing) console.error(`없음 ${file}: ${key} ${path}`);
    if (missing.length) process.exitCode = 1;
    else console.log(`맞음 ${file}: 요구 경로 ${requiredPaths(text).length}개 있음`);
  }
}
