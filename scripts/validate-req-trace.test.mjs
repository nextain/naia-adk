import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED_MARKERS = /폐기|삭제|제거|없앴|이전했|옮겼|더 이상|deprecated|removed|retired|no longer|legacy/i;
const EXPECTED_REQ_IDS = ["REQ-WAKE-001", "REQ-DASH-001", "REQ-DASH-002", "REQ-DASH-003", "REQ-GOV-001"];
const CHAIN_REQ_IDS = new Set(["REQ-DASH-001", "REQ-DASH-002", "REQ-DASH-003", "REQ-GOV-001"]);

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitFlowItems(inner) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowItems(inner).map((part) => parseScalar(part));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const part of splitFlowItems(inner)) {
      const kv = parseKeyValue(part);
      if (kv) obj[kv.key] = parseScalar(kv.rest);
    }
    return obj;
  }
  return s;
}

function parseKeyValue(content) {
  const idx = content.indexOf(":");
  if (idx < 0) return null;
  const key = content.slice(0, idx).trim();
  const rest = content.slice(idx + 1).trim();
  return { key, rest };
}

/**
 * Parses the subset of YAML used by `.agents/requirements/*.yaml` and `_index.yaml`
 * without external dependencies (mappings, sequences, inline arrays, `|` block scalars).
 */
export function parseReqYaml(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let idx = 0;

  function nextNonEmpty(start) {
    for (let i = start; i < lines.length; i += 1) {
      const cleaned = stripComment(lines[i]);
      if (cleaned.trim() !== "") return i;
    }
    return -1;
  }

  function indentOf(line) {
    const m = /^(\s*)/.exec(line);
    return m ? m[1].length : 0;
  }

  function parseBlock(minIndent) {
    const first = nextNonEmpty(idx);
    if (first < 0) return {};
    const firstLine = stripComment(lines[first]);
    const firstIndent = indentOf(firstLine);
    if (firstIndent < minIndent) return {};
    if (firstLine.trimStart().startsWith("- ")) {
      return parseSequence(firstIndent);
    }
    return parseMapping(firstIndent);
  }

  function parseLiteralScalar(parentIndent) {
    const chunk = [];
    let bodyIndent = null;
    while (idx < lines.length) {
      const raw = lines[idx];
      if (raw.trim() === "") {
        chunk.push("");
        idx += 1;
        continue;
      }
      const ind = indentOf(raw);
      if (ind <= parentIndent) break;
      if (bodyIndent === null) bodyIndent = ind;
      chunk.push(raw.slice(Math.min(bodyIndent, raw.length)));
      idx += 1;
    }
    while (chunk.length > 0 && chunk[chunk.length - 1] === "") chunk.pop();
    return chunk.join("\n");
  }

  function parseSequence(seqIndent) {
    const out = [];
    while (idx < lines.length) {
      const next = nextNonEmpty(idx);
      if (next < 0) break;
      idx = next;
      const line = stripComment(lines[idx]);
      const ind = indentOf(line);
      if (ind < seqIndent || !line.slice(ind).startsWith("- ")) break;
      if (ind > seqIndent) break;
      const itemText = line.slice(ind + 2).trim();
      idx += 1;
      const kv = !itemText.startsWith("{") && !itemText.startsWith("[") ? parseKeyValue(itemText) : null;
      if (kv && /^[A-Za-z0-9_-]+$/.test(kv.key)) {
        const obj = {};
        if (kv.rest === "|") {
          obj[kv.key] = parseLiteralScalar(ind + 2);
        } else if (kv.rest === "") {
          obj[kv.key] = parseBlock(ind + 3);
        } else {
          obj[kv.key] = parseScalar(kv.rest);
        }
        const contIndent = ind + 2;
        const more = parseMapping(contIndent, obj);
        out.push(more);
      } else {
        out.push(parseScalar(itemText));
      }
    }
    return out;
  }

  function parseMapping(mapIndent, target = {}) {
    while (idx < lines.length) {
      const next = nextNonEmpty(idx);
      if (next < 0) break;
      const line = stripComment(lines[next]);
      const ind = indentOf(line);
      if (ind < mapIndent) break;
      if (ind > mapIndent) {
        idx = next + 1;
        continue;
      }
      const trimmed = line.slice(ind);
      if (trimmed.startsWith("- ")) break;
      const kv = parseKeyValue(trimmed);
      if (!kv) {
        idx = next + 1;
        continue;
      }
      idx = next + 1;
      if (kv.rest === "|") {
        target[kv.key] = parseLiteralScalar(ind);
      } else if (kv.rest === "") {
        const peek = nextNonEmpty(idx);
        const peekLine = peek >= 0 ? stripComment(lines[peek]) : "";
        const peekInd = peek >= 0 ? indentOf(peekLine) : -1;
        const isSameIndentSeq = peekInd === ind && peekLine.trimStart().startsWith("- ");
        if (peek < 0 || (peekInd <= ind && !isSameIndentSeq)) {
          target[kv.key] = null;
        } else {
          target[kv.key] = parseBlock(isSameIndentSeq ? ind : ind + 1);
        }
      } else {
        target[kv.key] = parseScalar(kv.rest);
      }
    }
    return target;
  }

  return parseBlock(0);
}

function assertSafeRepoFile(rootDir, relPath, label, errors) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    errors.push(`${label}: path must be a non-empty string`);
    return null;
  }
  if (relPath.startsWith("/") || relPath.includes("\\")) {
    errors.push(`${label}: unsafe non-relative path "${relPath}"`);
    return null;
  }
  if (relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    errors.push(`${label}: path contains invalid segment "${relPath}"`);
    return null;
  }
  const abs = path.resolve(rootDir, relPath);
  if (abs !== rootDir && !abs.startsWith(`${rootDir}${path.sep}`)) {
    errors.push(`${label}: path escapes repository "${relPath}"`);
    return null;
  }
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) {
    errors.push(`${label}: missing file "${relPath}"`);
    return null;
  }
  if (st.isSymbolicLink()) {
    const real = fs.realpathSync(abs);
    if (!real.startsWith(`${rootDir}${path.sep}`) || !fs.statSync(real).isFile()) {
      errors.push(`${label}: symlink escapes repository or is not a file "${relPath}"`);
      return null;
    }
  } else if (!st.isFile()) {
    errors.push(`${label}: target is not a regular file "${relPath}"`);
    return null;
  }
  return abs;
}

function symbolAppearsInText(fileText, symbol) {
  if (!symbol || typeof symbol !== "string") return false;
  const trimmed = symbol.trim();
  if (!trimmed) return false;
  if (fileText.includes(trimmed)) return true;
  const beforeParen = trimmed.split(" (")[0].trim();
  if (beforeParen && fileText.includes(beforeParen)) return true;
  return false;
}

function extractRelativeMarkdownLinks(markdownText) {
  const links = [];
  const lines = String(markdownText || "").split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || RETIRED_MARKERS.test(line)) continue;
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const match of stripped.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let raw = match[1].trim();
      if (raw.startsWith("<") && raw.includes(">")) raw = raw.slice(1, raw.indexOf(">")).trim();
      else raw = raw.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "").trim();
      if (!raw || raw.startsWith("#")) continue;
      if (/^(?:https?:|mailto:|tel:|data:|javascript:|file:)/i.test(raw)) continue;
      if (/[*?<>{}]/.test(raw)) continue;
      const clean = raw.split("#")[0].split("?")[0].trim();
      if (!clean || clean === "...") continue;
      links.push({ target: clean, line: i + 1 });
    }
  }
  return links;
}

function collectExtraTracePaths(reqDoc) {
  const paths = [];
  for (const [key, val] of Object.entries(reqDoc)) {
    if (!key.endsWith("_trace") || !val || typeof val !== "object") continue;
    for (const field of ["code", "tests", "guide", "guides", "scenarios", "requirements"]) {
      const entry = val[field];
      if (typeof entry === "string") paths.push({ field: `${key}.${field}`, path: entry });
      else if (Array.isArray(entry)) {
        for (const item of entry) {
          if (typeof item === "string") paths.push({ field: `${key}.${field}`, path: item });
        }
      }
    }
  }
  return paths;
}

export function validateRequirementsChain(rootDir, { requireCanonicalIds = false } = {}) {
  const errors = [];
  const reqDir = path.join(rootDir, ".agents", "requirements");
  const indexPath = path.join(reqDir, "_index.yaml");
  if (!fs.existsSync(indexPath)) {
    return { ok: false, errors: ["Missing .agents/requirements/_index.yaml"], stats: null };
  }

  const indexData = parseReqYaml(fs.readFileSync(indexPath, "utf8"));
  const indexRows = Array.isArray(indexData?.requirements) ? indexData.requirements : [];
  if (indexRows.length === 0) {
    errors.push(".agents/requirements/_index.yaml must declare at least one requirement");
  }

  const diskReqFiles = fs
    .readdirSync(reqDir)
    .filter((name) => /^REQ-[A-Z0-9-]+\.ya?ml$/.test(name))
    .sort();

  const indexedById = new Map();
  const indexedPaths = new Set();
  for (const row of indexRows) {
    if (!row || typeof row.id !== "string" || typeof row.path !== "string") {
      errors.push(`Invalid entry in _index.yaml: ${JSON.stringify(row)}`);
      continue;
    }
    if (indexedById.has(row.id)) {
      errors.push(`Duplicate id in _index.yaml: ${row.id}`);
      continue;
    }
    indexedById.set(row.id, row.path);
    indexedPaths.add(row.path);
    const absEntry = path.join(reqDir, row.path);
    if (!fs.existsSync(absEntry)) {
      errors.push(`_index.yaml entry ${row.id} points to missing file: .agents/requirements/${row.path}`);
    }
  }

  for (const filename of diskReqFiles) {
    if (!indexedPaths.has(filename)) {
      errors.push(`Unregistered requirement file on disk (missing from _index.yaml): ${filename}`);
    }
  }

  if (requireCanonicalIds) {
    for (const expectedId of EXPECTED_REQ_IDS) {
      if (!indexedById.has(expectedId)) {
        errors.push(`Missing required specification ID in _index.yaml: ${expectedId}`);
      }
    }
  }

  let codeTraceCount = 0;
  let testTraceCount = 0;
  let testGapCount = 0;
  let documentCount = 0;
  const checkedMarkdownDocs = new Set();

  for (const [reqId, relFilename] of indexedById.entries()) {
    const absReq = path.join(reqDir, relFilename);
    if (!fs.existsSync(absReq)) continue;
    const reqDoc = parseReqYaml(fs.readFileSync(absReq, "utf8"));
    const label = `.agents/requirements/${relFilename}`;

    if (reqDoc.id !== reqId) {
      errors.push(`${label}: id "${reqDoc.id}" does not match _index.yaml id "${reqId}"`);
    }
    if (path.basename(relFilename).replace(/\.ya?ml$/, "") !== reqId) {
      errors.push(`${label}: filename does not match id "${reqId}"`);
    }
    for (const field of ["title", "product", "module", "status", "description"]) {
      if (typeof reqDoc[field] !== "string" || !reqDoc[field].trim()) {
        errors.push(`${label}: missing non-empty field "${field}"`);
      }
    }
    if (!Array.isArray(reqDoc.acceptance_criteria) || reqDoc.acceptance_criteria.length === 0) {
      errors.push(`${label}: acceptance_criteria must be a non-empty list`);
    }

    if (CHAIN_REQ_IDS.has(reqId) || reqId.startsWith("REQ-DASH-") || reqId.startsWith("REQ-GOV-")) {
      const desc = String(reqDoc.description || "");
      for (const marker of ["[목적]", "[기능 목록", "[사용자 시나리오]"]) {
        if (!desc.includes(marker)) {
          errors.push(`${label}: description must include section "${marker}"`);
        }
      }
      const fit = reqDoc.architecture_fit;
      if (!fit || typeof fit !== "object") {
        errors.push(`${label}: missing architecture_fit block`);
      } else {
        for (const k of ["original_request", "parent_structure", "acceptance_rationale"]) {
          if (typeof fit[k] !== "string" || fit[k].trim().length < 8) {
            errors.push(`${label}: architecture_fit.${k} must be present`);
          }
        }
      }
    }

    const trace = reqDoc.trace;
    if (!trace || typeof trace !== "object") {
      errors.push(`${label}: missing trace block`);
      continue;
    }

    const codeEntries = Array.isArray(trace.code) ? trace.code : [];
    if (codeEntries.length === 0) {
      errors.push(`${label}: trace.code must be a non-empty list`);
    }
    for (const entry of codeEntries) {
      const entryPath = entry?.path;
      if (entryPath === "없음") {
        errors.push(`${label}: trace.code cannot use "없음" (must point to real code files)`);
        continue;
      }
      const abs = assertSafeRepoFile(rootDir, entryPath, `${label} trace.code`, errors);
      if (abs && entry?.symbol) {
        const text = fs.readFileSync(abs, "utf8");
        if (!symbolAppearsInText(text, String(entry.symbol))) {
          errors.push(`${label}: trace.code symbol "${entry.symbol}" not found in "${entryPath}"`);
        }
      }
      codeTraceCount += 1;
    }

    const testEntries = Array.isArray(trace.tests) ? trace.tests : [];
    if (testEntries.length === 0) {
      errors.push(`${label}: trace.tests must be a non-empty list (use path: "없음" for declared gaps)`);
    }
    for (const entry of testEntries) {
      const entryPath = entry?.path;
      if (entryPath === "없음") {
        if (entry?.coverage !== "none") {
          errors.push(`${label}: trace.tests "없음" gap entry must set coverage: none`);
        }
        if (typeof entry?.symbol !== "string" || !entry.symbol.trim()) {
          errors.push(`${label}: trace.tests "없음" gap entry must describe the missing test in symbol`);
        }
        testGapCount += 1;
        continue;
      }
      const abs = assertSafeRepoFile(rootDir, entryPath, `${label} trace.tests`, errors);
      if (typeof entry?.symbol !== "string" || !entry.symbol.trim()) {
        errors.push(`${label}: trace.tests entry "${entryPath}" must declare a non-empty symbol`);
      } else if (abs && (reqId.startsWith("REQ-DASH-") || reqId.startsWith("REQ-GOV-"))) {
        const text = fs.readFileSync(abs, "utf8");
        if (!symbolAppearsInText(text, entry.symbol)) {
          errors.push(`${label}: trace.tests symbol "${entry.symbol}" not found in "${entryPath}"`);
        }
      }
      testTraceCount += 1;
    }

    const docEntries = Array.isArray(trace.documents) ? trace.documents : [];
    if (docEntries.length === 0) {
      errors.push(`${label}: trace.documents must be a non-empty list`);
    }
    for (const docRel of docEntries) {
      if (docRel === "없음") {
        errors.push(`${label}: trace.documents cannot use "없음"`);
        continue;
      }
      const abs = assertSafeRepoFile(rootDir, docRel, `${label} trace.documents`, errors);
      if (abs && docRel.toLowerCase().endsWith(".md")) {
        checkedMarkdownDocs.add(docRel);
      }
      documentCount += 1;
    }

    for (const extra of collectExtraTracePaths(reqDoc)) {
      assertSafeRepoFile(rootDir, extra.path, `${label} ${extra.field}`, errors);
    }
  }

  for (const docRel of [...checkedMarkdownDocs].sort()) {
    const absDoc = path.join(rootDir, docRel);
    const docDir = path.dirname(absDoc);
    const markdown = fs.readFileSync(absDoc, "utf8");
    for (const link of extractRelativeMarkdownLinks(markdown)) {
      const targetAbs = link.target.startsWith("/")
        ? path.resolve(rootDir, link.target.slice(1))
        : path.resolve(docDir, link.target);
      if (!targetAbs.startsWith(`${rootDir}${path.sep}`) && targetAbs !== rootDir) {
        errors.push(`Broken markdown link escaping repo in ${docRel}:${link.line} -> ${link.target}`);
      } else if (!fs.existsSync(targetAbs)) {
        errors.push(`Broken markdown link in ${docRel}:${link.line} -> ${link.target}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      requirements: indexedById.size,
      codeTraces: codeTraceCount,
      testTraces: testTraceCount,
      testGaps: testGapCount,
      documents: documentCount,
      markdownDocsChecked: checkedMarkdownDocs.size,
    },
  };
}

function makeFixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "naia-req-trace-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  write("src/widget.mjs", "export function renderWidget() { return true; }\n");
  write("src/widget.test.mjs", 'test("renderWidget works", () => {});\n');
  write("docs/design/widget-plan.md", "# Widget Plan\n\nSee [REQ](../../.agents/requirements/REQ-TEST-001.yaml).\n");
  write(
    ".agents/requirements/_index.yaml",
    ["requirements:", "  - id: REQ-TEST-001", "    path: REQ-TEST-001.yaml", ""].join("\n"),
  );
  write(
    ".agents/requirements/REQ-TEST-001.yaml",
    [
      "id: REQ-TEST-001",
      'title: "Widget spec"',
      "product: naia-adk",
      "module: widget",
      "status: candidate",
      "architecture_fit:",
      '  original_request: "Widget traceability request"',
      '  parent_structure: "packages/dashboard + docs/design"',
      '  acceptance_rationale: "Validates real trace paths and symbols"',
      "description: |",
      "  [목적]",
      "  테스트용 목적",
      "  [기능 목록]",
      "  1. 위젯",
      "  [사용자 시나리오]",
      "  - 시나리오 1",
      "acceptance_criteria:",
      '  - "위젯 시험 통과"',
      "trace:",
      "  code:",
      "    - path: src/widget.mjs",
      "      symbol: renderWidget",
      "      coverage: full",
      "  tests:",
      "    - path: src/widget.test.mjs",
      '      symbol: "renderWidget works"',
      "      coverage: full",
      '    - path: "없음"',
      '      symbol: "위젯 E2E 시험 없음"',
      "      coverage: none",
      "  documents:",
      "    - docs/design/widget-plan.md",
      "",
    ].join("\n"),
  );
  return { dir, write };
}

test("1. Repository .agents/requirements chain (REQ-WAKE-001, REQ-DASH-001..003, REQ-GOV-001) resolves every file, symbol, and doc link", () => {
  const result = validateRequirementsChain(REPO_ROOT, { requireCanonicalIds: true });
  assert.equal(result.ok, true, `Requirements chain validation failed:\n  - ${result.errors.join("\n  - ")}`);
  assert.ok(result.stats.requirements >= 5);
  assert.ok(result.stats.codeTraces >= 40);
  assert.ok(result.stats.testTraces >= 25);
  assert.ok(result.stats.testGaps >= 1);
  assert.ok(result.stats.markdownDocsChecked >= 10);
});

test("2. Negative cases: missing trace files, bad symbols, broken doc links, index mismatch, and misuse of 없음 fail validation", (t) => {
  // Valid baseline fixture passes
  {
    const { dir } = makeFixtureRepo(t);
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, true, res.errors.join("; "));
  }

  // Missing trace.code file
  {
    const { dir, write } = makeFixtureRepo(t);
    write(
      ".agents/requirements/REQ-TEST-001.yaml",
      fs.readFileSync(path.join(dir, ".agents/requirements/REQ-TEST-001.yaml"), "utf8").replace("src/widget.mjs", "src/missing.mjs"),
    );
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('missing file "src/missing.mjs"')));
  }

  // Missing symbol in trace.code
  {
    const { dir, write } = makeFixtureRepo(t);
    write(
      ".agents/requirements/REQ-TEST-001.yaml",
      fs.readFileSync(path.join(dir, ".agents/requirements/REQ-TEST-001.yaml"), "utf8").replace("renderWidget", "nonExistentSymbol"),
    );
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("nonExistentSymbol")));
  }

  // Missing trace.tests file
  {
    const { dir, write } = makeFixtureRepo(t);
    write(
      ".agents/requirements/REQ-TEST-001.yaml",
      fs.readFileSync(path.join(dir, ".agents/requirements/REQ-TEST-001.yaml"), "utf8").replace("src/widget.test.mjs", "src/missing.test.mjs"),
    );
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('missing file "src/missing.test.mjs"')));
  }

  // Misuse of "없음" in trace.code
  {
    const { dir, write } = makeFixtureRepo(t);
    write(
      ".agents/requirements/REQ-TEST-001.yaml",
      fs.readFileSync(path.join(dir, ".agents/requirements/REQ-TEST-001.yaml"), "utf8").replace("src/widget.mjs", "없음"),
    );
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('trace.code cannot use "없음"')));
  }

  // "없음" in trace.tests with non-none coverage fails
  {
    const { dir, write } = makeFixtureRepo(t);
    write(
      ".agents/requirements/REQ-TEST-001.yaml",
      fs
        .readFileSync(path.join(dir, ".agents/requirements/REQ-TEST-001.yaml"), "utf8")
        .replace('symbol: "위젯 E2E 시험 없음"\n      coverage: none', 'symbol: "위젯 E2E 시험 없음"\n      coverage: full'),
    );
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("must set coverage: none")));
  }

  // Broken relative markdown link inside traced document
  {
    const { dir, write } = makeFixtureRepo(t);
    write("docs/design/widget-plan.md", "# Widget Plan\n\n[Broken](../guides/does-not-exist.md)\n");
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("Broken markdown link")));
  }

  // Unregistered REQ file on disk fails
  {
    const { dir, write } = makeFixtureRepo(t);
    write(".agents/requirements/REQ-ORPHAN-001.yaml", "id: REQ-ORPHAN-001\n");
    const res = validateRequirementsChain(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("REQ-ORPHAN-001.yaml")));
  }
});
