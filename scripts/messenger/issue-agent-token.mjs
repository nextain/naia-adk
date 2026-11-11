#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function updateTokens(file, command, role) {
  if (!file) throw new Error('NAIA_MESSENGER_AGENT_TOKENS_FILE을 설정하세요');
  // packages/server/src/routes/portal-messenger.ts 와 같은 규칙. 어긋나면 발급돼도 401 이 난다.
  if (!role || !/^[a-z][a-z0-9_-]{0,63}$/.test(role)) throw new Error('역할 이름은 영문 소문자로 시작하고 소문자·숫자·밑줄·붙임표만, 64자까지 씁니다');
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const lock = `${file}.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  try {
    let tokens = {};
    try { tokens = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!tokens || Array.isArray(tokens) || typeof tokens !== 'object' || Object.entries(tokens).some(([k,v]) => !/^[a-f0-9]{64}$/.test(k) || typeof v !== 'string')) throw new Error('토큰 파일 형식이 잘못됐습니다');
    const existing = Object.keys(tokens).filter(key => tokens[key] === role);
    if (command === 'issue' && existing.length) throw new Error('이미 발급된 역할입니다. rotate로 회전하세요');
    if (!['issue','rotate','revoke'].includes(command)) throw new Error('issue|rotate|revoke <역할>');
    if (command !== 'issue') for (const key of existing) delete tokens[key];
    const token = command === 'revoke' ? null : randomBytes(32).toString('base64url');
    if (token) tokens[hashToken(token)] = role;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
    return token;
  } finally { closeSync(fd); unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const command = ['issue','rotate','revoke'].includes(args[0]) ? args.shift() : 'issue';
    if (args.length !== 1) throw new Error('issue-agent-token.mjs [issue|rotate|revoke] <역할>');
    const token = updateTokens(process.env.NAIA_MESSENGER_AGENT_TOKENS_FILE, command, args[0]);
    console.log(token ?? '폐기했습니다');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
