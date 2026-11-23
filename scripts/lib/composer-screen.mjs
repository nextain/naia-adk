// Empty-composer hints observed in the installed Muse 1.4.25 catalog. The UI
// clips these horizontally. Text alone is not proof: renderer styling must
// also identify a placeholder, so an actual slash command remains a draft.
export const museComposerHints = [
  'Type @ to search and insert workspace file paths',
  'Start a message with ! to run a shell command yourself',
  'Paste an image with Ctrl+V — file paths and URLs work too',
  'Press Alt+V to dictate instead of typing',
  'Tab queues or steers while a run is active',
  'Press ? on an empty composer to see keyboard shortcuts',
  'Press Ctrl+O to expand collapsed tool output',
  '/side asks a quick question without touching this thread',
  '/fork branches the conversation from the latest point',
  '/goal pins a session objective with a progress bar',
  '/resume reopens a past session (--last for the latest)',
  "Ask to 'use a workflow' to fan out parallel agents on big tasks",
  "Say 'use a workflow' to fan out agents on big tasks",
  'Ask to monitor a running build or log and get pinged on changes',
  '/agent opens the subagent command center',
  '/tasks shows workflows, subagents and terminals in one place',
  '/loop 10m <prompt> schedules a recurring prompt',
  'Ctrl+B sends the selected task to the background queue',
  '/skills browses ready-made skills for repeatable procedures',
  '/plugins marketplace installs new commands and skills',
  '/effort adjusts reasoning depth vs speed',
  "/usage shows this session's token usage",
  '/export saves the conversation to a text file',
];
const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const prompt = /^[ \t]*([❯›➜»>])(?:[ \t]+(.*)|$)/;
const footer = /^(?:[─━═]{3,}|GPT[- ]\d|muse[- ·]|claude[- ·]|gemini[- ·]|\[default\]|tab\s+to\s+queue|\?\s+for\s+shortcuts|\d+%\s+context)/i;
const placeholder = /^(?:type a message|ask anything|ask codex to do anything|\/usage shows this|메시지를 입력하세요)?$/i;
const active = /^[ \t]*(?:#[ \t]*)?(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒✶✳✢✻✽✼◈◇•][ \t]+[^\n]*\(\s*\d+(?:\.\d+)?\s*[smh]\b|(?:thinking|working|running|double\s+checking)(?:[.…]|\s*\()|(?:esc|escape)\s+to\s+(?:cancel|interr\w*))/im;
const clean = raw => raw.replace(ansi, '');

function ordinaryScreenState(screen) {
  if (typeof screen !== 'string' || !screen.trim()) return 'unknown';
  const lines = screen.replace(ansi, '').replaceAll('\r', '').split('\n');
  let index = -1, match;
  for (let i = 0; i < lines.length; i++) {
    const candidate = prompt.exec(lines[i]);
    if (candidate) { index = i; match = candidate; }
  }
  if (index < 0) return 'unknown';
  if (active.test(lines.slice(Math.max(0, index - 12), index).join('\n'))) return 'busy';
  const parts = [match[2] ?? ''];
  for (const line of lines.slice(index + 1)) {
    if (footer.test(line.trim())) break;
    parts.push(line.trim());
  }
  return placeholder.test(parts.join(' ').trim().replace(/\s+/g, ' ')) ? 'idle' : 'draft';
}

function styledChars(raw) {
  const chars = [];
  let fg = null, dim = false, position = 0;
  for (const escape of raw.matchAll(ansi)) {
    chars.push(...[...raw.slice(position, escape.index)].map(char => ({ char, fg, dim })));
    if (escape[0].endsWith('m')) {
      const values = escape[0].slice(2, -1).split(';').map(value => Number(value || 0));
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value === 0) { fg = null; dim = false; }
        else if (value === 2) dim = true;
        else if (value === 22) dim = false;
        else if (value === 39) fg = null;
        else if (value >= 30 && value <= 37 || value >= 90 && value <= 97) fg = String(value);
        else if ([38, 48, 58].includes(value)) {
          const count = values[index + 1] === 2 ? 4 : values[index + 1] === 5 ? 2 : 0;
          if (count && index + count < values.length) {
            if (value === 38) fg = values.slice(index, index + count + 1).join(';');
            index += count;
          }
        }
      }
    }
    position = escape.index + escape[0].length;
  }
  chars.push(...[...raw.slice(position)].map(char => ({ char, fg, dim })));
  return chars;
}

export function screenState(screen) {
  return classifyComposerScreen(screen, 'codex');
}

export function classifyComposerScreen(screen, tool) {
  const ordinary = ordinaryScreenState(screen);
  if (!['muse', 'codex'].includes(tool) || ['busy', 'unknown'].includes(ordinary)) return ordinary;
  const lines = screen.replaceAll('\r', '').split('\n');
  let index = -1, match;
  for (let line = 0; line < lines.length; line++) {
    const found = prompt.exec(clean(lines[line]));
    if (found) { index = line; match = found; }
  }
  if (index < 0) return 'unknown';
  const textParts = [match[2] ?? ''], payload = [];
  const first = styledChars(lines[index]);
  const marker = first.findIndex(({ char }) => '❯›➜»>'.includes(char));
  payload.push(...first.slice(marker + 1));
  for (const raw of lines.slice(index + 1)) {
    if (footer.test(clean(raw).trim())) break;
    textParts.push(clean(raw).trim()); payload.push(...styledChars(raw));
  }
  const text = textParts.join(' ').trim().replace(/\s+/g, ' ');
  const visible = payload.filter(({ char }) => !/\s/.test(char));
  if (tool === 'codex') {
    // Codex renders this hint dim on one clipped row; typed input is not dim.
    // The complete product token is nine ASCII characters including its space.
    const hint = 'Ask Codex to do anything', prefix = (match[2] ?? '').trim();
    const clipped = prefix.length >= 'Ask Codex'.length && prefix.length < hint.length && hint.startsWith(prefix);
    const singleRow = textParts.filter(part => part.trim()).length === 1;
    return clipped && singleRow && visible.length && visible.every(({ dim }) => dim) ? 'idle' : ordinary;
  }

  const borderColors = new Set([...lines.slice(Math.max(0, index - 2), index), ...lines.slice(index + 1, index + 3)]
    .flatMap(styledChars).filter(({ char, fg }) => '─━═'.includes(char) && fg !== null).map(({ fg }) => fg));

  const catalog = text.length >= 16 && museComposerHints.some(hint => hint.startsWith(text));
  const placeholderStyle = visible.length && visible.every(({ fg, dim }) => dim || fg !== null && borderColors.has(fg));
  if (catalog && placeholderStyle) return 'idle';
  if (text && placeholderStyle) return 'unknown';
  return text.startsWith('/') ? 'draft' : ordinary;
}
