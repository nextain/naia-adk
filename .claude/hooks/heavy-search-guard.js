#!/usr/bin/env node
/** PreToolUse(Bash): bound searches of Claude conversation records. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const RECOMMENDATION = 'timeout 60 nice -n 19 grep -m 5 -F ...';
const resolveTarget = (cwd, target) => path.posix.resolve(cwd, target.replace(/^~(?=\/)/, os.homedir()).replaceAll('\\', '/'));

// Keep shell separators out of quoted arguments, especially bash -c payloads.
function clauses(command) {
  const result = []; let words = []; let word = ''; let quote = null;
  const flushWord = () => { if (word) words.push(word); word = ''; };
  const flushClause = () => { flushWord(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`\n]/.test(command[i + 1] || '')) word += command[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\' && i + 1 < command.length) word += command[++i];
    else if (/[;&|\n()]/.test(ch)) flushClause();
    else if (/\s/.test(ch)) flushWord();
    else word += ch;
  }
  flushClause(); return result;
}

function inspect(command, bounded = false, depth = 0, cwd = process.cwd()) {
  if (depth > 12) return { reason: `Search wrapper nesting is too deep; use ${RECOMMENDATION}` };
  let warning = false;
  for (const words of clauses(command)) {
    if (words[0] === 'cd') {
      const directory = words.slice(1).find(word => !word.startsWith('-'));
      if (directory) cwd = resolveTarget(cwd, directory);
      continue;
    }
    let i = 0; let timed = bounded;
    while (i < words.length) {
      const head = path.posix.basename(words[i]);
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(head) || ['env', 'command', 'exec', 'nohup'].includes(head)) { i++; continue; }
      if (head === 'timeout') {
        i++;
        while (words[i]?.startsWith('-')) {
          if (['-s', '--signal', '-k', '--kill-after'].includes(words[i])) i += 2;
          else i++;
        }
        if (/^(?:\d+(?:\.\d+)?|\.\d+)(?:s|m|h|d)?$/.test(words[i] || '') && parseFloat(words[i]) > 0) { timed = true; i++; continue; }
        // A disabled or malformed timeout does not protect the following search.
        if (words[i]) { i++; continue; }
        break;
      }
      if (head === 'nice') {
        i++;
        if (['-n', '--adjustment'].includes(words[i])) i += 2;
        else if (/^(?:-\d+|--adjustment=)/.test(words[i] || '')) i++;
        continue;
      }
      if (['bash', 'sh', 'zsh', 'dash'].includes(head)) {
        const c = words.findIndex((word, index) => index > i && /^-[a-z]*c[a-z]*$/.test(word));
        if (c >= 0 && words[c + 1]) {
          const nested = inspect(words[c + 1], timed, depth + 1, cwd);
          if (nested.reason) return nested;
          warning ||= nested.warning;
        }
        break;
      }
      if (!['grep', 'egrep', 'ugrep', 'rg', 'ag'].includes(head)) break;
      const args = words.slice(i + 1);
      const targets = []; let patternSeen = false;
      const valueOptions = new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--encoding', '--color', '--colors']);
      for (let j = 0; j < args.length; j++) {
        const arg = args[j];
        if (valueOptions.has(arg)) {
          if (['-e', '--regexp', '-f', '--file'].includes(arg)) patternSeen = true;
          j++; continue;
        }
        if (arg.startsWith('-') && arg !== '-') {
          if (/^(?:--(?:regexp|file)=|-[ef].+)/.test(arg)) patternSeen = true;
          continue;
        }
        if (!patternSeen) { patternSeen = true; continue; }
        targets.push(arg);
      }
      // A directory target can include JSONL recursively (rg/ag do so by default).
      const recursive = ['rg', 'ag'].includes(head) || args.some(arg => /^--(?:recursive|dereference-recursive)$/.test(arg) || /^-[^-]*[rR]/.test(arg));
      if (recursive && targets.length === 0) targets.push('.');
      const recordTarget = targets.some(arg => {
        const normalized = resolveTarget(cwd, arg);
        if (!/(?:^|\/)\.claude\/projects(?:\/|$)/.test(normalized)) return false;
        if (/\.jsonl(?:$|[?*\]])/.test(normalized)) return true;
        if (!recursive) return false;
        // Metadata only: preserve searches of existing non-JSONL files and
        // recognize directories regardless of their suffix. Unknown/glob
        // targets fall back to conservative lexical directory detection.
        try { return fs.statSync(normalized).isDirectory(); } catch {}
        return arg.endsWith('/') || !/\.(?:txt|md|js|cjs|mjs|ts|json|yaml|yml|csv|log)$/.test(normalized);
      });
      if (!recordTarget) break;
      if (!timed) return { reason: `Conversation JSONL searches require timeout <seconds> before the search. Recommended: ${RECOMMENDATION}` };
      const fixed = args.some(arg => arg === '--fixed-strings' || /^-[^-]*F/.test(arg));
      const limited = args.some(arg => /^--max-count(?:=|$)/.test(arg) || /^-[^-]*m/.test(arg));
      if (!fixed && !limited && args.some(arg => [...arg.matchAll(/\.\{(\d+)(?:,\d*)?\}/g)].some(match => Number(match[1]) >= 100))) warning = true;
      break;
    }
  }
  return { warning };
}

if (require.main === module) require('./_claude-bash-guard.js').start((command, data) => {
  const decision = inspect(command, false, 0, data.cwd || process.cwd());
  if (decision.warning) process.stderr.write(`Heavy search warning: large context regex; prefer ${RECOMMENDATION}\n`);
  return decision.reason ? decision : null;
});
module.exports = { inspect };
