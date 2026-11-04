// 받아쓰기 공통 함수: 설정 읽기·인자 풀기·결과 모양 바꾸기. 네트워크·파일 쓰기 없음(시험 대상).
import fs from 'node:fs';
import path from 'node:path';

export const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.opus', '.m4a', '.aac', '.webm', '.wma', '.amr']);
export const API_VERSION = '2024-11-15';

export function parseArgs(argv) {
  const o = { files: [], format: 'text', locales: null, out: null, config: null, diarize: 0, profanity: 'None', backend: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} 뒤에 값이 필요합니다`); return argv[++i]; };
    if (a === '--format') o.format = next();
    else if (a === '--locale' || a === '--locales') o.locales = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') o.out = next();
    else if (a === '--config') o.config = next();
    else if (a === '--diarize') o.diarize = Number(next());
    else if (a === '--profanity') o.profanity = next();
    else if (a === '--backend') o.backend = next();
    else if (a.startsWith('--')) throw new Error(`모르는 선택: ${a}`);
    else o.files.push(a);
  }
  if (!['text', 'srt', 'vtt', 'json'].includes(o.format)) throw new Error(`--format 은 text|srt|vtt|json 중 하나: ${o.format}`);
  if (!Number.isInteger(o.diarize) || o.diarize < 0 || o.diarize > 35) throw new Error('--diarize 는 0~35 사이 정수(화자 최대 수, 0=끔)');
  if (!['None', 'Masked', 'Removed', 'Tags'].includes(o.profanity)) throw new Error('--profanity 는 None|Masked|Removed|Tags');
  if (o.backend && !['gateway', 'azure'].includes(o.backend)) throw new Error('--backend 는 gateway|azure');
  if (o.files.length === 0) throw new Error('받아쓸 파일을 하나 이상 주십시오');
  if (o.out && o.files.length > 1) throw new Error('--out 은 파일 하나일 때만 씁니다');
  return o;
}

// 설정 찾는 차례: --config → TRANSCRIBE_CONFIG → 현재 폴더부터 위로 config/transcribe.json
export function findConfig(explicit, cwd = process.cwd(), env = process.env) {
  const p = explicit || env.TRANSCRIBE_CONFIG || (() => {
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      const c = path.join(d, 'config', 'transcribe.json');
      if (fs.existsSync(c)) return c;
      if (path.dirname(d) === d) return null;
    }
  })();
  if (!p) throw new Error('설정 config/transcribe.json 이 없습니다(예시: .agents/skills/transcribe/config.example.json)');
  return validateConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
}

export function validateConfig(c) {
  for (const k of ['region']) if (typeof c[k] !== 'string' || !c[k]) throw new Error(`설정에 ${k} 가 없습니다`);
  if (!/^[a-z0-9]+$/.test(c.region)) throw new Error(`region 모양이 틀립니다: ${c.region}`);
  if (!c.key_env && !(c.resource && c.resource_group)) throw new Error('설정에 key_env 또는 resource·resource_group 이 필요합니다');
  if (c.gateway) {
    if (!/^https:\/\/[^/]+(\/.*)?$/.test(c.gateway.base_url || '')) throw new Error('gateway.base_url 은 https 주소');
    if (!c.gateway.key_env) throw new Error('gateway.key_env 가 없습니다');
  }
  return { default_locales: ['ko-KR'], ...c };
}

// 기본=게이트웨이(서버별 열쇠로 크레딧이 서버마다 잡힘). 자막·화자·json 은 게이트웨이가 시각을 안 주므로 애저 직접.
export function chooseBackend(o, cfg, env = process.env) {
  const gwReady = !!(cfg.gateway && env[cfg.gateway.key_env]);
  const needsTiming = o.format !== 'text' || o.diarize > 0;
  if (o.backend === 'gateway') {
    if (!gwReady) throw new Error(`게이트웨이 열쇠 ${cfg.gateway ? cfg.gateway.key_env : '(설정 없음)'} 가 비었습니다`);
    if (needsTiming) throw new Error('게이트웨이는 글만 돌려줍니다 — 자막·화자·json 은 --backend azure');
    return { backend: 'gateway', why: '지정' };
  }
  if (o.backend === 'azure') return { backend: 'azure', why: '지정' };
  if (needsTiming) return { backend: 'azure', why: '자막·화자·json 은 게이트웨이가 시각을 안 줌' };
  if (gwReady) return { backend: 'gateway', why: '기본' };
  return { backend: 'azure', why: '게이트웨이 열쇠 없음' };
}

export function endpoint(region) {
  return `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
}

export function gatewayUrl(base) {
  return base.replace(/\/+$/, '') + '/audio/transcriptions';
}

export function definition(o, cfg) {
  const d = { locales: o.locales || cfg.default_locales, profanityFilterMode: o.profanity };
  if (o.diarize > 0) d.diarization = { enabled: true, maxSpeakers: o.diarize };
  return d;
}

function stamp(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60, r = t % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

// phrases: 응답의 phrases 배열(offsetMilliseconds·durationMilliseconds·text·speaker)
export function toSubtitles(phrases, kind) {
  const sep = kind === 'vtt' ? '.' : ',';
  const cues = (phrases || []).filter(p => p.text && p.text.trim()).map((p, i) => {
    const who = p.speaker != null ? `[${p.speaker}] ` : '';
    const range = `${stamp(p.offsetMilliseconds, sep)} --> ${stamp(p.offsetMilliseconds + p.durationMilliseconds, sep)}`;
    return kind === 'vtt' ? `${range}\n${who}${p.text.trim()}` : `${i + 1}\n${range}\n${who}${p.text.trim()}`;
  });
  return (kind === 'vtt' ? 'WEBVTT\n\n' : '') + cues.join('\n\n') + (cues.length ? '\n' : '');
}

export function toText(res) {
  const c = res.combinedPhrases || [];
  return c.map(x => x.text).join('\n').trim() + '\n';
}

export function render(res, format) {
  if (format === 'json') return JSON.stringify(res, null, 2) + '\n';
  if (format === 'srt' || format === 'vtt') return toSubtitles(res.phrases, format);
  return toText(res);
}

export function needsConvert(file) {
  return !AUDIO_EXT.has(path.extname(file).toLowerCase());
}
