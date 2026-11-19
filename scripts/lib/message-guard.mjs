import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultConfig = fileURLToPath(new URL('./message-guard-patterns.json', import.meta.url));
const suggestion = '사실을 적고 다음 행동 하나에 장치/파일/명령과 장부 기한을 적으세요.';
const concrete = /(?:https?:\/\/[^\s]+|(?:^|\s|[`(])(?:\.{0,2}\/|[\w.-]+\/)[\w./~-]+|\b[0-9a-f]{7,40}\b|\b(?:PR\s*#?\d+|#[0-9]+)\b|\b\d{1,2}:\d{2}(?::\d{2})?(?:Z|\s*(?:UTC|KST))?\b|`[^`]+`)/iu;
const url = /https?:\/\/[^\s`<>]+/giu;
const artifact = /(?:https?:\/\/[^\s`<>]+|\b[0-9a-f]{7,40}\b)/iu;
// Paths must be actual directories containing a worker entry file, not merely path-shaped text.
const paths = /(?:^|[\s`(])((?:\.{0,2}\/|[\w.-]+\/)[\w./~-]*)/gu;

export function checkMessage(body, { configPath = defaultConfig, cwd = process.cwd(), unitStatus } = {}) {
  if (typeof body !== 'string') throw new TypeError('message body must be a string');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const compile = key => {
    if (!Array.isArray(config[key]) || config[key].some(x => typeof x !== 'string' || !x)) throw Error(`invalid ${key} patterns`);
    return config[key].map(p => new RegExp(p, 'iu'));
  };
  const abstract = compile('abstract'), progress = compile('progress'), issues = [];
  for (const sentence of body.split(/\n+|(?<=[.!?。！？])\s+/u).map(s => s.trim()).filter(Boolean)) {
    if (abstract.some(p => p.test(sentence)) && !concrete.test(sentence))
      issues.push({ code: 'abstract', sentence, reason: '구체 근거 없는 노력·다짐·반성 표현', suggestion });
    if (progress.some(p => p.test(sentence))) {
      const withoutUrls = sentence.replace(url, ' ');
      const workerPaths = [...withoutUrls.matchAll(paths)].map(m => m[1].replace(/[.,!?。]+$/u, ''));
      let validWorker = false;
      for (const path of workerPaths) {
        const dir = resolve(cwd, path);
        const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
        if (!isFile(join(dir, 'brief.md')) && !isFile(join(dir, 'run.sh'))) {
          issues.push({ code: 'worker_empty', sentence, reason: `일꾼 폴더에 brief.md 또는 run.sh가 없음: ${path}`, suggestion });
        } else {
          validWorker = true;
          if (unitStatus && unitStatus(dir, sentence) !== true)
            issues.push({ code: 'unit_status', sentence, reason: `일꾼 유닛 상태 확인 실패: ${path}`, suggestion });
        }
      }
      if (!artifact.test(sentence) && !validWorker)
        issues.push({ code: 'progress', sentence, reason: '진행 주장에 일꾼 폴더, 커밋 해시 또는 PR·배포 주소가 없음', suggestion });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertMessage(body, options) {
  const result = checkMessage(body, options);
  if (!result.ok) throw new Error(result.issues.map(i => `${i.reason}: ${i.sentence}\n${i.suggestion}`).join('\n'));
  return result;
}
