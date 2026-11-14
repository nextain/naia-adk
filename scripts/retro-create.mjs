#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRetro, periods, validDay } from './retro-format-check.mjs';

const baseSections = ['회고', '목표 개선', '리서치', '잡생각', '계속 밀리는 일'];
const scope = {
  daily: '해당 날짜의 일을 돌아본다.',
  weekly: '지난 7일의 매일 회고를 모으고 빠진 회고를 기록한다.',
  monthly: '지난달 주간 회고를 모으고 빠진 회고를 기록한다.',
  yearly: '지난해 월간 회고를 모으고 빠진 회고를 기록한다.',
};

export function template(role, day, period) {
  validate(role, day, period);
  const sections = period === 'daily' ? baseSections : [...baseSections, '되풀이된 문제', '다음 기간 목표'];
  return [`# ${role} ${periods[period]} 회고 — ${day}`, '', `쓴 역할: ${role}`, '',
    ...sections.flatMap((name, index) => [`## ${index + 1}. ${name}`, '', ''])].join('\n');
}

export function request(role, day, period, artifact, problems = []) {
  validate(role, day, period);
  if (!artifact?.trim() || /[\r\n]/.test(artifact)) throw new Error('artifact path is required and must be one line');
  return [
    `# 회고 ${problems.length ? '교정' : '작성'} 요청`, '',
    `- 담당 역할: ${role}`, `- 기간 끝 날짜: ${day}`, `- 단위: ${period}`,
    `- 결과 문서: ${artifact}`, `- 할 일: ${scope[period]}`,
    '- 다섯 칸을 작성한다: 회고, 목표 개선, 리서치, 잡생각, 계속 밀리는 일.',
    '- 리서치는 인터넷 검색을 하고 출처 주소를 기록한다.',
    '- 근거 없는 원인은 추정으로 표시하고, 빠진 회고와 계속 밀리는 일을 기록한다.',
    ...(period === 'daily' ? [] : ['- 되풀이된 문제와 다음 기간 목표를 추가한다.']),
    ...problems.map((problem) => `- 교정: ${problem}`), '',
  ].join('\n');
}

function validate(role, day, period) {
  if (!role?.trim() || role !== role.trim() || /[\r\n]/.test(role) || !validDay(day) || !Object.hasOwn(periods, period)) {
    throw new Error('role, valid YYYY-MM-DD day, and supported period are required');
  }
}

function main(argv) {
  const args = [...argv];
  let output;
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1) {
    if (outputIndex !== args.length - 2 || !args[outputIndex + 1]) throw new Error('--output requires a final file path');
    output = args[outputIndex + 1];
    args.splice(outputIndex);
  }
  const [mode, role, day, period, artifact] = args;
  if (!['template', 'request', 'repair'].includes(mode) || args.length !== (mode === 'template' ? 4 : 5)) {
    throw new Error('Usage: retro-create.mjs <template|request|repair> <role> <YYYY-MM-DD> <daily|weekly|monthly|yearly> [artifact] [--output file]');
  }
  validate(role, day, period);
  let text;
  if (mode === 'template') text = template(role, day, period);
  else if (mode === 'request') text = request(role, day, period, artifact);
  else {
    let problems;
    try { problems = checkRetro(readFileSync(artifact, 'utf8'), { role, day, period }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      problems = ['회고 문서가 없음'];
    }
    if (!problems.length) {
      console.log('Retrospective format OK; no repair request needed');
      return;
    }
    text = request(role, day, period, artifact, problems);
  }
  if (output) writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Cannot create retrospective: ${error.message}`); process.exitCode = 2; }
}
