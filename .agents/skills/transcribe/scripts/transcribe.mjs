#!/usr/bin/env node
// 받아쓰기: 소리·영상 파일 → 글·자막. 기본은 게이트웨이(any-llm 호환, /v1/audio/transcriptions)(서버별 열쇠, 크레딧 차감), 자막·화자는 애저 AI 서비스 직접(애저 크레딧).
// 사용: node transcribe.mjs <파일...> [--format text|srt|vtt|json] [--locale ko-KR,en-US] [--diarize N] [--backend gateway|azure] [--out 파일]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, findConfig, endpoint, gatewayUrl, chooseBackend, definition, render, needsConvert } from './lib.mjs';

function apiKey(cfg) {
  if (cfg.key_env && process.env[cfg.key_env]) return process.env[cfg.key_env];
  if (!cfg.resource) throw new Error(`환경 변수 ${cfg.key_env} 가 비었습니다`);
  // 열쇠는 az 로그인 권한으로 그때그때 받고, 화면·파일에 남기지 않는다.
  return execFileSync('az', ['cognitiveservices', 'account', 'keys', 'list', '-g', cfg.resource_group, '-n', cfg.resource, '--query', 'key1', '-o', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// 영상 등 소리 파일이 아닌 것은 16kHz 한 채널 wav 로 바꿔 보낸다(소리만 올라가 크기도 줄어든다).
function prepare(file, tmp) {
  if (!needsConvert(file)) return file;
  const out = path.join(tmp, path.basename(file) + '.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

async function transcribe(file, o, cfg, key) {
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append('definition', JSON.stringify(definition(o, cfg)));
  const res = await fetch(endpoint(cfg.region), { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key }, body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`받아쓰기 실패 ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
}

async function viaGateway(file, o, cfg) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append('language', (o.locales || cfg.default_locales)[0]);
  const res = await fetch(gatewayUrl(cfg.gateway.base_url), { method: 'POST', headers: { Authorization: `Bearer ${process.env[cfg.gateway.key_env]}` }, body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`게이트웨이 받아쓰기 실패 ${res.status}: ${body.slice(0, 400)}`);
  const r = JSON.parse(body);
  return { combinedPhrases: [{ text: r.text }], durationMilliseconds: Math.round((r.duration_seconds || 0) * 1000), costUsd: r.cost_usd };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = findConfig(o.config);
  const pick = chooseBackend(o, cfg);
  process.stderr.write(`받아쓰기 길: ${pick.backend} (${pick.why})\n`);
  const key = pick.backend === 'azure' ? apiKey(cfg) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-'));
  try {
    for (const f of o.files) {
      if (!fs.existsSync(f)) throw new Error(`파일이 없습니다: ${f}`);
      const audio = prepare(f, tmp);
      const res = pick.backend === 'gateway' ? await viaGateway(audio, o, cfg) : await transcribe(audio, o, cfg, key);
      const text = render(res, o.format);
      if (o.out) fs.writeFileSync(o.out, text);
      else process.stdout.write((o.files.length > 1 ? `== ${f}\n` : '') + text);
      process.stderr.write(`받아쓰기 끝: ${f} (${((res.durationMilliseconds || 0) / 1000).toFixed(1)}초${res.costUsd != null ? `, $${res.costUsd.toFixed(4)}` : ''})\n`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
