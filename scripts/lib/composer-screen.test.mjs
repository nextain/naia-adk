import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { classifyComposerScreen, museComposerHints } from './composer-screen.mjs';
const gray = '\x1b[38;2;103;108;116m', blue = '\x1b[38;2;90;160;255m', white = '\x1b[38;2;204;211;219m', reset = '\x1b[0m';
const fixture = (text, color = gray) => `${gray}────────────────${reset}\n${blue}❯ ${reset}${color}${text}${reset}\n${gray}────────────────${reset}\n  muse-spark · effort`;

test('installed Muse hint catalog supports complete and clipped styled placeholders', () => {
  for (const hint of museComposerHints) for (const text of [hint, hint.slice(0, 29), hint.slice(0, 17)]) {
    assert.equal(classifyComposerScreen(fixture(text), 'muse'), 'idle', text);
    assert.equal(classifyComposerScreen(fixture(text, white), 'muse'), 'draft', `human: ${text}`);
  }
});
test('unknown slash, real goal, unstyled and other-tool input stay drafts', () => {
  assert.equal(classifyComposerScreen(fixture('/goal complete the project', white), 'muse'), 'draft');
  assert.equal(classifyComposerScreen(fixture('/unknown arbitrary input', white), 'muse'), 'draft');
  assert.equal(classifyComposerScreen('❯ /goal pins a session objective\n────────', 'muse'), 'draft');
  assert.equal(classifyComposerScreen(fixture('/goal pins a session objective'), 'codex'), 'draft');
});
test('current activity wins over an empty hint and multiline human input stays draft', () => {
  assert.equal(classifyComposerScreen('◈ Double checking (16s ·\n' + fixture('/goal pins a session objective'), 'muse'), 'busy');
  assert.equal(classifyComposerScreen(fixture('/goal pins a session objective\n' + white + 'with a progress bar'), 'muse'), 'draft');
});
test('CLI reads actual ANSI through stdin and outputs state without body', () => {
  const input = fixture('/goal pins a session objective');
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/composer-screen.mjs', '--tool', 'muse'], { input, encoding: 'utf8' }));
  assert.deepEqual(result, { tool: 'muse', state: 'idle' });
});

test('unknown styled hints defer explicitly and a different neutral palette also works', () => {
  assert.equal(classifyComposerScreen(fixture('/new-hint from a later release'), 'muse'), 'unknown');
  assert.equal(classifyComposerScreen(fixture('/goal pins a session objective').replaceAll('103;108;116', '128;128;128'), 'muse'), 'idle');
});

test('RGB/indexed background and underline colors never turn human text into a dim hint', () => {
  for (const color of ['48;2;10;20;30', '48;5;2', '58;2;10;20;30', '58;5;2']) {
    assert.equal(classifyComposerScreen(fixture('/goal pins a session objective', white + `\x1b[${color}m`), 'muse'), 'draft', color);
  }
});

const codexLiteral = 'Ask Codex to do anything';
const codexFrame = (text, style = '\x1b[2m', continuation = '') => {
  const background = '\x1b[48;2;41;41;41m';
  return `${reset}${background}            ${reset}\n` +
    `${reset}\x1b[1m${blue}${background}›${reset}${background} ${reset}${style}${background}${text}${reset}${background} ${reset}\n` +
    continuation + `${reset}${background}            ${reset}\n  GPT-6.2\n`;
};

test('Codex accepts only fully dim single-row known clipped hints starting at the complete product token', () => {
  for (let length = 9; length < codexLiteral.length; length++) {
    const text = codexLiteral.slice(0, length);
    assert.equal(classifyComposerScreen(codexFrame(text), 'codex'), 'idle', text);
    assert.equal(classifyComposerScreen(codexFrame(text, reset), 'codex'), 'draft', `human: ${text}`);
  }
  assert.equal(classifyComposerScreen(codexFrame(codexLiteral), 'codex'), 'idle');
  assert.equal(classifyComposerScreen(codexFrame(''), 'codex'), 'idle');
});

test('Codex preserves ambiguous short, altered, disabled and pasted input', () => {
  for (const text of [
    ...Array.from({ length: 8 }, (_, index) => codexLiteral.slice(0, index + 1)),
    'ask Codex', 'Ask Codex!', 'Ask  Codex', 'Ask Cоdex', 'Input disabled.',
    'Ask a follow-up question', '[Pasted Content 2000 chars]', 'Ask Codex [Pasted]',
  ]) assert.equal(classifyComposerScreen(codexFrame(text), 'codex'), 'draft', text);
  assert.equal(classifyComposerScreen('› Ask Codex\n  GPT-6', 'codex'), 'draft');
  assert.equal(classifyComposerScreen(codexFrame('Ask Codex', gray), 'codex'), 'draft');
});

test('Codex requires dim on every payload glyph and rejects additional nonblank input rows', () => {
  for (const text of ['Ask \x1b[22mCodex', 'Ask \x1b[0mCodex'])
    assert.equal(classifyComposerScreen(codexFrame(text), 'codex'), 'draft');
  assert.equal(classifyComposerScreen(codexFrame('Ask Codex', '\x1b[2m\x1b[22m'), 'codex'), 'draft');
  assert.equal(classifyComposerScreen(codexFrame('Ask Codex', '\x1b[2m', '\x1b[2mto do\x1b[0m\n'), 'codex'), 'draft');
  assert.equal(classifyComposerScreen(codexFrame('Ask Codex', '\x1b[2m', '[Pasted Content 2000 chars]\n'), 'codex'), 'draft');
});

test('Codex does not confuse RGB or indexed color components with explicit dim', () => {
  for (const style of ['38;2;2;2;2', '38;5;2', '48;2;2;2;2', '48;5;2', '58;2;2;2;2', '58;5;2'])
    assert.equal(classifyComposerScreen(codexFrame('Ask Codex', `\x1b[${style}m`), 'codex'), 'draft', style);
  assert.equal(classifyComposerScreen(codexFrame('Ask Codex', '\x1b[2m\x1b[38;2;80;90;100m'), 'codex'), 'idle');
});

test('Codex hint recognition preserves activity guards and other-provider fallback', () => {
  const screen = codexFrame('Ask Codex');
  for (const activity of ['• Working (2m • esc', '• Compacting context (50s • esc'])
    assert.equal(classifyComposerScreen(activity + '\n' + screen, 'codex'), 'busy');
  assert.equal(classifyComposerScreen(screen, 'muse'), 'unknown');
  for (const tool of ['claude', 'agy', '']) assert.equal(classifyComposerScreen(screen, tool), 'draft', tool);
});

test('Codex CLI reports the clipped styled hint without echoing screen contents', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/composer-screen.mjs', '--tool', 'codex'], { input: codexFrame('Ask Codex'), encoding: 'utf8' }));
  assert.deepEqual(result, { tool: 'codex', state: 'idle' });
});
