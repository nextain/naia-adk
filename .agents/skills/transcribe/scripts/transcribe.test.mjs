import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, validateConfig, chooseBackend, gatewayUrl, findConfig, endpoint, definition, toSubtitles, toText, render, needsConvert } from './lib.mjs';

const phrases = [
  { offsetMilliseconds: 0, durationMilliseconds: 1500, text: '안녕하세요', speaker: 1 },
  { offsetMilliseconds: 3661001, durationMilliseconds: 999, text: ' 다음 문장 ' },
  { offsetMilliseconds: 5000, durationMilliseconds: 100, text: '  ' },
];

test('인자: 기본값과 선택', () => {
  const o = parseArgs(['a.wav']);
  assert.equal(o.format, 'text');
  assert.equal(o.locales, null);
  const p = parseArgs(['a.mp4', '--format', 'srt', '--locale', 'ko-KR, en-US', '--diarize', '2', '--out', 'x.srt']);
  assert.deepEqual(p.locales, ['ko-KR', 'en-US']);
  assert.equal(p.diarize, 2);
  assert.equal(p.out, 'x.srt');
});

test('인자: 틀린 값은 거절', () => {
  assert.throws(() => parseArgs([]), /하나 이상/);
  assert.throws(() => parseArgs(['a.wav', '--format', 'doc']), /format/);
  assert.throws(() => parseArgs(['a.wav', '--diarize', '99']), /diarize/);
  assert.throws(() => parseArgs(['a.wav', 'b.wav', '--out', 'x']), /하나일 때/);
  assert.throws(() => parseArgs(['a.wav', '--what']), /모르는 선택/);
  assert.throws(() => parseArgs(['a.wav', '--format']), /값이 필요/);
});

test('설정: 검사와 기본 언어', () => {
  const c = validateConfig({ region: 'koreacentral', resource: 'r', resource_group: 'g' });
  assert.deepEqual(c.default_locales, ['ko-KR']);
  assert.throws(() => validateConfig({ resource: 'r', resource_group: 'g' }), /region/);
  assert.throws(() => validateConfig({ region: 'korea central', key_env: 'K' }), /모양/);
  assert.throws(() => validateConfig({ region: 'koreacentral' }), /key_env/);
});

test('설정: 위 폴더에서 찾기', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'transcribe.json'), JSON.stringify({ region: 'eastus2', key_env: 'K' }));
  assert.equal(findConfig(null, path.join(root, 'a', 'b'), {}).region, 'eastus2');
  fs.rmSync(root, { recursive: true, force: true });
});

test('요청: 주소와 정의', () => {
  assert.match(endpoint('koreacentral'), /^https:\/\/koreacentral\.api\.cognitive\.microsoft\.com\/speechtotext\/transcriptions:transcribe\?api-version=/);
  const cfg = { default_locales: ['ko-KR'] };
  assert.deepEqual(definition(parseArgs(['a.wav']), cfg), { locales: ['ko-KR'], profanityFilterMode: 'None' });
  assert.deepEqual(definition(parseArgs(['a.wav', '--diarize', '3']), cfg).diarization, { enabled: true, maxSpeakers: 3 });
});

test('자막: srt 번호·시각·빈 구절 빼기·화자', () => {
  assert.equal(toSubtitles(phrases, 'srt'),
    '1\n00:00:00,000 --> 00:00:01,500\n[1] 안녕하세요\n\n2\n01:01:01,001 --> 01:01:02,000\n다음 문장\n');
});

test('자막: vtt 머리와 점 시각', () => {
  assert.equal(toSubtitles(phrases.slice(0, 1), 'vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n[1] 안녕하세요\n');
  assert.equal(toSubtitles([], 'srt'), '');
});

test('글: 합친 구절', () => {
  const res = { combinedPhrases: [{ text: '첫 줄' }, { text: '둘째 줄' }], phrases };
  assert.equal(toText(res), '첫 줄\n둘째 줄\n');
  assert.equal(JSON.parse(render(res, 'json')).combinedPhrases.length, 2);
});

test('영상은 소리로 바꿈', () => {
  assert.equal(needsConvert('a.mp4'), true);
  assert.equal(needsConvert('a.MOV'), true);
  assert.equal(needsConvert('a.WAV'), false);
  assert.equal(needsConvert('a.m4a'), false);
});

test('길 고르기: 게이트웨이 기본, 자막은 애저', () => {
  const cfg = validateConfig({ region: 'koreacentral', key_env: 'K', gateway: { base_url: 'https://gw.example/v1/', key_env: 'GW' } });
  const env = { GW: 'x' };
  assert.equal(chooseBackend(parseArgs(['a.wav']), cfg, env).backend, 'gateway');
  assert.equal(chooseBackend(parseArgs(['a.wav']), cfg, {}).backend, 'azure');
  assert.equal(chooseBackend(parseArgs(['a.wav', '--format', 'srt']), cfg, env).backend, 'azure');
  assert.equal(chooseBackend(parseArgs(['a.wav', '--diarize', '2']), cfg, env).backend, 'azure');
  assert.equal(chooseBackend(parseArgs(['a.wav', '--backend', 'azure']), cfg, env).backend, 'azure');
  assert.throws(() => chooseBackend(parseArgs(['a.wav', '--backend', 'gateway']), cfg, {}), /열쇠/);
  assert.throws(() => chooseBackend(parseArgs(['a.wav', '--backend', 'gateway', '--format', 'srt']), cfg, env), /글만/);
  assert.throws(() => parseArgs(['a.wav', '--backend', 'x']), /backend/);
  assert.equal(gatewayUrl('https://gw.example/v1/'), 'https://gw.example/v1/audio/transcriptions');
  assert.throws(() => validateConfig({ region: 'koreacentral', key_env: 'K', gateway: { base_url: 'http://x', key_env: 'GW' } }), /https/);
});
