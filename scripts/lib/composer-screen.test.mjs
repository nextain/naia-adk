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
