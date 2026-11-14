#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sections = ['회고', '목표 개선', '리서치', '잡생각', '계속 밀리는 일'];
export const periods = { daily: '매일', weekly: '주간', monthly: '월간', yearly: '연간' };

// Check structure, not whether claims, research, or completed actions are true.
export function checkRetro(text, { role, day, period = 'daily' }) {
  if (!role?.trim() || role !== role.trim() || /[\r\n]/.test(role) || !validDay(day) || !Object.hasOwn(periods, period)) {
    throw new Error('role, valid YYYY-MM-DD day, and supported period are required');
  }
  const problems = [];
  const lines = text.split(/\r?\n/);
  // Ignore headings and URLs inside fenced code blocks and HTML comments.
  let fence = null;
  let comment = false;
  const visible = lines.map((line) => {
    const marker = comment ? null : line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return '';
    }
    if (fence) return '';
    let rest = line;
    let result = '';
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->');
        if (end < 0) return result;
        comment = false;
        rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) return result + rest;
        result += rest.slice(0, start);
        comment = true;
        rest = rest.slice(start + 4);
      }
    }
    return result;
  });
  const expectedTitle = `# ${role} ${periods[period]} 회고 — ${day}`;
  if (visible.find((line) => /^#\s/.test(line)) !== expectedTitle) problems.push(`title must be: ${expectedTitle}`);
  if (!visible.some((line) => line.trim() === `쓴 역할: ${role}`)) problems.push('author must match the requested role');
  const required = period === 'daily' ? sections : [...sections, '되풀이된 문제', '다음 기간 목표'];
  const heads = visible.map((line, i) => ({ line, i })).filter(({ line }) => /^##\s/.test(line));
  let previous = -1;
  let researchIndex;
  for (const [index, name] of required.entries()) {
    const prefix = `## ${index + 1}. ${name}`;
    const found = heads.filter(({ line }) => line === prefix || line.startsWith(`${prefix} (`));
    if (found.length !== 1) {
      problems.push(`expected one heading: ${prefix}`);
      continue;
    }
    if (found[0].i < previous) problems.push(`heading out of order: ${prefix}`);
    previous = found[0].i;
    if (index === 2) researchIndex = found[0].i;
  }
  if (researchIndex !== undefined) {
    const next = heads.find(({ i }) => i > researchIndex);
    const body = visible.slice(researchIndex + 1, next?.i).join('\n');
    const candidates = body.match(/https?:\/\/[^\s<>\])]+/g) ?? [];
    if (!candidates.some((candidate) => {
      try { return Boolean(new URL(candidate).hostname); } catch { return false; }
    })) problems.push('research section requires an HTTP(S) source URL');
  }
  return problems;
}

export function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}

function main(args) {
  if (args.length !== 4 || !Object.hasOwn(periods, args[3])) {
    console.error('Usage: node scripts/retro-format-check.mjs <file|-> <role> <YYYY-MM-DD> <daily|weekly|monthly|yearly>');
    return 2;
  }
  try {
    const problems = checkRetro(readFileSync(args[0] === '-' ? 0 : args[0], 'utf8'), {
      role: args[1], day: args[2], period: args[3],
    });
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      return 1;
    }
    console.log('Retrospective format OK');
    return 0;
  } catch (error) {
    console.error(`Cannot check retrospective: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
