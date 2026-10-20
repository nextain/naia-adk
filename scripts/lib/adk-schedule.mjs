/**
 * Naia ADK v2.0.0 — Work Document Schedule Parser & Validator
 *
 * Schedule truth lives in work document front matter (`마일스톤:`, `기한:`)
 * and the `## 할 일` markdown table (`할 일`, `담당`, `상태`).
 * Schedule shows and nudges; it grants no permissions.
 */

export function isValidCalendarDate(str) {
  if (typeof str !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function stripQuotesAndTicks(val) {
  if (typeof val !== 'string') return '';
  return val
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();
}

function splitTableCells(line) {
  const trimmed = line.trim();
  const withoutOuter = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutOuter.split('|').map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function extractScheduleInternals(markdownText) {
  const raw = typeof markdownText === 'string' ? markdownText.replace(/\r\n/g, '\n') : '';
  const lines = raw.split('\n');

  let hasYamlFence = false;
  const frontLines = [];

  if (lines[0]?.trim() === '---') {
    const endIdx = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (endIdx > 0) {
      hasYamlFence = true;
      for (let i = 1; i < endIdx; i++) {
        frontLines.push(lines[i]);
      }
    }
  }

  for (const line of lines) {
    if (/^##\s+/.test(line)) break;
    frontLines.push(line);
  }

  let milestone = null;
  let due = null;
  let hasMilestoneKey = false;
  let hasDueKey = false;

  for (const line of frontLines) {
    const mMatch = /^\s*(?:[-*]\s*)?(?:\*\*)?마일스톤(?:\*\*)?\s*:\s*(.*)$/.exec(line);
    if (mMatch && !hasMilestoneKey) {
      hasMilestoneKey = true;
      const v = stripQuotesAndTicks(mMatch[1]);
      milestone = v.length > 0 ? v : null;
    }
    const dMatch = /^\s*(?:[-*]\s*)?(?:\*\*)?기한(?:\*\*)?\s*:\s*(.*)$/.exec(line);
    if (dMatch && !hasDueKey) {
      hasDueKey = true;
      const v = stripQuotesAndTicks(dMatch[1]);
      due = v.length > 0 ? v : null;
    }
  }

  const hasFrontMatter = hasMilestoneKey || hasDueKey;

  let hasTodoSection = false;
  let header = [];
  const rows = [];

  const todoHeadingIdx = lines.findIndex((l) => /^##\s+할\s*일(?:\s|$)/.test(l.trim()));
  if (todoHeadingIdx >= 0) {
    hasTodoSection = true;
    const sectionLines = [];
    for (let i = todoHeadingIdx + 1; i < lines.length; i++) {
      if (/^#{1,2}\s+/.test(lines[i].trim())) break;
      sectionLines.push(lines[i]);
    }

    const tableLines = [];
    let inTable = false;
    for (const sl of sectionLines) {
      if (sl.includes('|')) {
        inTable = true;
        tableLines.push(sl);
      } else if (inTable) {
        if (sl.trim() === '') break;
        break;
      }
    }

    if (tableLines.length > 0) {
      header = splitTableCells(tableLines[0]);
      let dataStartIdx = 1;
      if (tableLines.length > 1 && isSeparatorRow(splitTableCells(tableLines[1]))) {
        dataStartIdx = 2;
      }
      for (let r = dataStartIdx; r < tableLines.length; r++) {
        const cells = splitTableCells(tableLines[r]);
        if (cells.every((c) => c === '')) continue;
        const rowObj = {};
        for (let c = 0; c < header.length; c++) {
          rowObj[header[c]] = cells[c] ?? '';
        }
        rows.push(rowObj);
      }
    }
  }

  const total = rows.length;
  const done = rows.filter((row) => stripQuotesAndTicks(row['상태'] || '') === '완료').length;

  return {
    hasFrontMatter,
    hasTodoSection,
    schedule: {
      milestone,
      due,
      todo: {
        header,
        rows,
        done,
        total,
      },
    },
  };
}

export function parseWorkDocSchedule(markdownText) {
  return extractScheduleInternals(markdownText).schedule;
}

export function validateWorkDocSchedule(markdownText, { milestoneIds = [], milestoneNames = [] } = {}) {
  const errors = [];
  const warnings = [];
  const { hasFrontMatter, hasTodoSection, schedule } = extractScheduleInternals(markdownText);

  if (!hasFrontMatter) {
    warnings.push('Missing schedule front matter (마일스톤: / 기한:)');
  } else {
    const idSet = new Set(milestoneIds || []);
    const nameSet = new Set(milestoneNames || []);
    const hasDefinedMilestones = idSet.size > 0 || nameSet.size > 0;

    if (!schedule.milestone) {
      errors.push('Front matter "마일스톤:" is required when front matter is present');
    } else if (hasDefinedMilestones && !idSet.has(schedule.milestone) && !nameSet.has(schedule.milestone)) {
      errors.push(
        `Front matter "마일스톤: ${schedule.milestone}" must equal a defined milestone id or name`,
      );
    }

    if (!schedule.due || !isValidCalendarDate(schedule.due)) {
      errors.push(
        `Front matter "기한: ${schedule.due ?? ''}" must be a valid YYYY-MM-DD calendar date`,
      );
    }
  }

  if (hasTodoSection) {
    const requiredColumns = ['할 일', '담당', '상태'];
    const missing = requiredColumns.filter((col) => !schedule.todo.header.includes(col));
    if (schedule.todo.header.length === 0 || missing.length > 0) {
      errors.push(
        `"## 할 일" table header must contain columns: ${requiredColumns.join(', ')} (missing: ${missing.join(', ')})`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
