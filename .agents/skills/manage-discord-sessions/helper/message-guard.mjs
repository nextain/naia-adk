import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultConfig = fileURLToPath(new URL('./message-guard-patterns.json', import.meta.url));
const suggestion = '사실을 적고 다음 행동 하나에 장치/파일/명령과 장부 기한을 적으세요.';
const method = /(?:https?:\/\/[^\s]+|(?:^|\s|[`(])(?:\.{0,2}\/|[\w.-]+\/)[\w./~-]+|`[^`]+`)/iu;
const deadline = /(?:\b\d{1,2}:\d{2}(?::\d{2})?(?:Z|\s*(?:UTC|KST))?|\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}월\s*\d{1,2}일)\s*(?:까지|전|이내)?/iu;
const action = /(?:수정|추가|연결|실행|검사|검증|작성|등록|배포|병합|확인|run|add|update|check|test)/iu;
const evidence = /(?:https?:\/\/[^\s`<>]+|\b[0-9a-f]{7,40}\b|(?:\bPR\s*#?\d+|#\d+))/iu;
const paths = /(?:^|[\s`(])((?:\.{0,2}\/|[\w.-]+\/)[\w./~-]*)/gu;
const worker = /(?:일꾼|작업자|worker)/iu;
const launch = /(?:띄웠|구동\s*(?:하였|했|되었|됐|중)|시작(?:하였|했|되었|됐)|launch(?:ed|ing)?|start(?:ed|ing)?)/iu;
const negation = /(?:안\s*(?:띄|구동|시작|병합|배포|해소)|(?:띄우|구동하|시작하|병합하|배포하|해소하)지\s*(?:않|못)|(?:실패|못\s*했)|\b(?:not|never|failed to)\b)/iu;

// A named unit must actually be active and tied to the reported directory.
function activeUnit(dir, sentence) {
  const unit = sentence.match(/\b([\w@.-]+\.service)\b/u)?.[1];
  if (!unit) return false;
  try {
    const out = execFileSync('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--property=WorkingDirectory'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const fields = Object.fromEntries(out.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    return fields.ActiveState === 'active' && fields.WorkingDirectory && resolve(fields.WorkingDirectory) === dir;
  } catch { return false; }
}

export function checkMessage(body, { configPath = defaultConfig, cwd = process.cwd(), unitStatus = activeUnit } = {}) {
  if (typeof body !== 'string') throw new TypeError('message body must be a string');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const compile = key => {
    if (!Array.isArray(config[key]) || config[key].some(x => typeof x !== 'string' || !x)) throw Error(`invalid ${key} patterns`);
    return config[key].map(p => new RegExp(p, 'iu'));
  };
  const abstract = compile('abstract'), progress = compile('progress'), issues = [];
  // Quoted statements are examples, not the author's assertions. Keep inline code for methods.
  const unquoted = body.replace(/(^|\s)@[\p{L}\p{N}_-]+/gu, '$1').replace(/```[\s\S]*?```/gu, ' ').replace(/“[^”]*”|"[^"\n]*"|'[^'\n]*'/gu, ' ');
  const paragraphs = unquoted.replace(/([^\n])\n(?!(?:\s*\n|\s*[-*#]\s))/gu, '$1 ');
  for (const sentence of paragraphs.split(/\n+|(?<=[.!?。！？])\s+/u).map(s => s.trim()).filter(Boolean)) {
    if (/[?？]\s*$/u.test(sentence) || negation.test(sentence)) continue;
    if (abstract.some(p => p.test(sentence)) && !(method.test(sentence) && deadline.test(sentence) && action.test(sentence)))
      issues.push({ code: 'abstract', sentence, reason: '구체 근거 없는 노력·다짐·반성 표현', suggestion });
    if (worker.test(sentence) && launch.test(sentence)) {
      const withoutUrls = sentence.replace(/https?:\/\/[^\s`<>]+/giu, ' ');
      const workerPaths = [...withoutUrls.matchAll(paths)].map(m => m[1].replace(/[.,!?。]+$/u, ''));
      const valid = workerPaths.some(path => {
        const dir = resolve(cwd, path);
        try { if (!statSync(dir).isDirectory()) return false; } catch { return false; }
        try { if (statSync(join(dir, 'run.done')).isFile()) return true; } catch {}
        return unitStatus(dir, sentence) === true;
      });
      if (!valid) issues.push({ code: 'unit_status', sentence, reason: '일꾼 폴더와 실행 중인 유닛 또는 run.done 확인 실패', suggestion });
    } else if (progress.some(p => p.test(sentence)) && !evidence.test(sentence)) {
      issues.push({ code: 'progress', sentence, reason: '진행 주장에 커밋 해시 또는 PR·배포 주소가 없음', suggestion });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertMessage(body, options) {
  const result = checkMessage(body, options);
  if (!result.ok) throw new Error(result.issues.map(i => `${i.reason}: ${i.sentence}\n${i.suggestion}`).join('\n'));
  return result;
}
