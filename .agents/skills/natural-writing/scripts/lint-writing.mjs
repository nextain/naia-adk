#!/usr/bin/env node
/**
 * lint-writing.mjs — Language-selectable translationese & AI-writing candidate finder.
 * Uses Node.js standard library only. Never modifies source files.
 *
 * Column numbering: 1-based Unicode code-point offset from the start of the line
 * (each code point, including a tab '\t' or a non-BMP emoji, counts as 1 column).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, "..");
const PACKS_DIR = path.join(__dirname, "packs");
const DEFAULT_CONFIG_PATH = path.join(SKILL_DIR, "defaults.json");

const UNICODE_LETTER_RE = /\p{L}/gu;

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

function normalizePack(raw, lang) {
  const detect = Array.isArray(raw) ? null : raw.detect || null;
  const rulesList = Array.isArray(raw) ? raw : raw.rules || [];
  let scriptRe = null;
  if (detect && typeof detect.script === "string") {
    const flags = detect.flags && detect.flags.includes("g") ? detect.flags : (detect.flags || "u") + "g";
    scriptRe = new RegExp(detect.script, flags);
  }
  const rules = rulesList.map((r) => ({
    ...r,
    lang,
    isParagraphRule: r.pattern.includes("[\\s\\S]"),
  }));
  return { detect, scriptRe, rules };
}

/**
 * Return all enabled language codes whose pack `detect` criteria match `text`.
 * Each pack defines `detect: { script, minChars, minRatio }`.
 * Ratio denominator is total Unicode letters (\p{L}) in `text`.
 */
export function detectLanguages(text, packs, candidateLangs = Object.keys(packs || {})) {
  if (!packs || !candidateLangs || candidateLangs.length === 0) return [];
  const totalLetters = countMatches(text, UNICODE_LETTER_RE);
  if (totalLetters === 0) return [];

  const matched = [];
  for (const lang of candidateLangs) {
    const rawPack = packs[lang];
    if (!rawPack) continue;
    const pack = Array.isArray(rawPack) ? normalizePack(rawPack, lang) : rawPack;
    const detect = pack.detect;
    if (!detect || !detect.script) {
      matched.push(lang);
      continue;
    }
    const re =
      pack.scriptRe ||
      new RegExp(detect.script, detect.flags && detect.flags.includes("g") ? detect.flags : (detect.flags || "u") + "g");
    const count = countMatches(text, re);
    const minChars = typeof detect.minChars === "number" ? detect.minChars : 1;
    const minRatio = typeof detect.minRatio === "number" ? detect.minRatio : 0;
    if (count >= minChars && count / totalLetters >= minRatio) {
      matched.push(lang);
    }
  }
  return matched;
}

/**
 * Detect the first matching language for `text` among `packs`.
 */
export function detectLanguage(text, packs, candidateLangs) {
  const langs = detectLanguages(text, packs, candidateLangs);
  return langs.length > 0 ? langs[0] : null;
}

/**
 * Replace protected spans with spaces in UTF-16 code units (preserving \n and \r)
 * so UTF-16 offsets remain 1-to-1 with the original content string.
 */
export function maskProtectedRegions(content, protectList = ["code", "inline_code", "url", "blockquote", "quoted"]) {
  const protect = new Set(protectList);
  // Split into UTF-16 code units so indices match RegExp.prototype.exec / matchAll indices exactly.
  const units = content.split("");

  const blankRange = (start, end) => {
    for (let i = start; i < end; i++) {
      if (units[i] !== "\n" && units[i] !== "\r") {
        units[i] = " ";
      }
    }
  };

  // 1. Fenced code blocks (``` or ~~~), tracked statefully line by line.
  //    Closing fence must use the same character (` or ~) with length >= opening length.
  //    Unclosed fences protect through the end of the file.
  if (protect.has("code")) {
    let inFence = false;
    let fenceChar = "";
    let fenceLen = 0;
    let lineStart = 0;

    while (lineStart <= content.length) {
      let lineEnd = content.indexOf("\n", lineStart);
      if (lineEnd === -1) lineEnd = content.length;
      const lineStr = content.slice(lineStart, lineEnd);

      if (!inFence) {
        const openMatch = lineStr.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
        if (openMatch) {
          const marker = openMatch[1];
          const info = openMatch[2] || "";
          // CommonMark: backtick fence info string cannot contain backticks on the same line
          if (marker[0] !== "`" || !info.includes("`")) {
            inFence = true;
            fenceChar = marker[0];
            fenceLen = marker.length;
            blankRange(lineStart, lineEnd);
          }
        }
      } else {
        blankRange(lineStart, lineEnd);
        const closeMatch = lineStr.match(/^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/);
        if (closeMatch) {
          const marker = closeMatch[1];
          if (marker[0] === fenceChar && marker.length >= fenceLen) {
            inFence = false;
            fenceChar = "";
            fenceLen = 0;
          }
        }
      }

      if (lineEnd === content.length) break;
      lineStart = lineEnd + 1;
    }
  }

  const afterCode = units.join("");

  // 2. Blockquote lines (> ...)
  if (protect.has("blockquote")) {
    const bqRe = /^[ \t]*>[^\n]*$/gm;
    for (const match of afterCode.matchAll(bqRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterBq = units.join("");

  // 3. Inline code (`...`)
  if (protect.has("inline_code")) {
    const inlineRe = /(`+)([^`\n]+?)\1/g;
    for (const match of afterBq.matchAll(inlineRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterInline = units.join("");

  // 4. URLs (http://, https://)
  if (protect.has("url")) {
    const urlRe = /https?:\/\/[^\s)>\]"']+/g;
    for (const match of afterInline.matchAll(urlRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterUrl = units.join("");

  // 5. Quoted text ("..." and “...”), tracked across lines within each paragraph.
  //    Unclosed quotes are capped at the paragraph boundary so a stray quote never masks the rest of the file.
  if (protect.has("quoted")) {
    const paraRe = /(?:^|\n[ \t]*\r?\n+)([^\n]+(?:\n(?![ \t]*\r?\n)[^\n]+)*)/g;
    for (const pm of afterUrl.matchAll(paraRe)) {
      const fullMatch = pm[0];
      const paraText = pm[1];
      const pStart = pm.index + (fullMatch.length - paraText.length);
      const pEnd = pStart + paraText.length;

      let openCloseChar = null;
      let quoteStart = -1;
      for (let i = pStart; i < pEnd; i++) {
        const ch = afterUrl[i];
        if (openCloseChar === null) {
          if (ch === "\u201C") {
            openCloseChar = "\u201D";
            quoteStart = i;
          } else if (ch === '"') {
            openCloseChar = '"';
            quoteStart = i;
          }
        } else if (ch === openCloseChar) {
          blankRange(quoteStart, i + 1);
          openCloseChar = null;
          quoteStart = -1;
        }
      }
    }
  }

  return units.join("");
}

function globToRegExp(glob) {
  const normalized = glob.replace(/\\/g, "/");
  let reStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        reStr += "(?:.*/)?";
        i += 3;
      } else {
        reStr += ".*";
        i += 2;
      }
    } else if (c === "*") {
      reStr += "[^/]*";
      i += 1;
    } else if (c === "?") {
      reStr += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(c)) {
      reStr += "\\" + c;
      i += 1;
    } else {
      reStr += c;
      i += 1;
    }
  }
  reStr += "$";
  return new RegExp(reStr);
}

function matchesAnyGlob(relPath, globs) {
  const norm = relPath.replace(/\\/g, "/");
  for (const g of globs || []) {
    if (globToRegExp(g).test(norm)) return true;
  }
  return false;
}

export function loadConfig({ configPath, langFlag, cwd = process.cwd() } = {}) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  let projectConfig = {};
  let configBaseDir = cwd;

  if (configPath) {
    const resolved = path.resolve(cwd, configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    projectConfig = JSON.parse(fs.readFileSync(resolved, "utf8"));
    configBaseDir = path.dirname(resolved);
  } else {
    const implicitPath = path.resolve(cwd, ".agents/context/natural-writing.json");
    if (fs.existsSync(implicitPath)) {
      projectConfig = JSON.parse(fs.readFileSync(implicitPath, "utf8"));
      configBaseDir = path.dirname(implicitPath);
    }
  }

  const packsDirs = [];
  if (projectConfig.packsDir) {
    packsDirs.push(path.resolve(configBaseDir, projectConfig.packsDir));
  }
  packsDirs.push(PACKS_DIR);

  const merged = {
    languages: { ...defaults.languages, ...(projectConfig.languages || {}) },
    include: projectConfig.include || defaults.include,
    exclude: projectConfig.exclude || defaults.exclude,
    protect: projectConfig.protect || defaults.protect,
    packsDirs,
    forcedLang: null,
  };

  if (langFlag) {
    merged.forcedLang = langFlag;
    for (const k of Object.keys(merged.languages)) {
      merged.languages[k] = false;
    }
    merged.languages[langFlag] = true;
  }

  return merged;
}

export function loadPacks(languagesMap, packsDirs = PACKS_DIR) {
  const searchDirs = Array.isArray(packsDirs) ? packsDirs : [packsDirs];
  const packs = {};
  for (const [lang, enabled] of Object.entries(languagesMap || {})) {
    if (!enabled) continue;
    let foundFile = null;
    for (const dir of searchDirs) {
      const candidate = path.join(dir, `${lang}.json`);
      if (fs.existsSync(candidate)) {
        foundFile = candidate;
        break;
      }
    }
    if (!foundFile) {
      throw new Error(`Language pack not found for '${lang}': ${path.join(searchDirs[0], `${lang}.json`)}`);
    }
    const raw = JSON.parse(fs.readFileSync(foundFile, "utf8"));
    packs[lang] = normalizePack(raw, lang);
  }
  return packs;
}

function codePointColumn(lineStr, utf16Offset) {
  return Array.from(lineStr.slice(0, utf16Offset)).length + 1;
}

function buildLineIndex(origText) {
  const lines = origText.split("\n");
  const starts = [0];
  for (let i = 0; i < origText.length; i++) {
    if (origText[i] === "\n") starts.push(i + 1);
  }
  return {
    lines,
    starts,
    offsetToLineCol(utf16Offset) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= utf16Offset) lo = mid + 1;
        else hi = mid - 1;
      }
      const lineIdx = Math.max(0, hi);
      const utf16Col = utf16Offset - starts[lineIdx];
      return {
        line: lineIdx + 1,
        column: codePointColumn(lines[lineIdx] || "", utf16Col),
      };
    },
  };
}

export function lintText(content, { filePath = "<input>", config, packs }) {
  const enabledLangs = Object.keys(packs || {});
  if (enabledLangs.length === 0) return [];

  const masked = maskProtectedRegions(content, config.protect);
  const lineIndex = buildLineIndex(content);
  const maskedLines = masked.split("\n");
  const origLines = lineIndex.lines;
  const findings = [];

  const candidateLangs = config.forcedLang ? [config.forcedLang] : enabledLangs;

  // 1. Line-level rules
  for (let i = 0; i < maskedLines.length; i++) {
    const lineText = maskedLines[i];
    const origLineText = origLines[i] || "";
    const activeLangs = detectLanguages(lineText, packs, candidateLangs);

    for (const lang of activeLangs) {
      const rawPack = packs[lang];
      if (!rawPack) continue;
      const pack = Array.isArray(rawPack) ? normalizePack(rawPack, lang) : rawPack;
      for (const rule of pack.rules) {
        if (rule.isParagraphRule) continue;
        const flags = rule.flags && rule.flags.includes("g") ? rule.flags : (rule.flags || "") + "g";
        const re = new RegExp(rule.pattern, flags);
        for (const m of lineText.matchAll(re)) {
          findings.push({
            file: filePath,
            line: i + 1,
            column: codePointColumn(origLineText, m.index),
            id: rule.id,
            lang,
            severity: rule.severity,
            match: m[0].replace(/\s+/g, " ").trim(),
            message: rule.message,
            suggest: rule.suggest,
          });
        }
      }
    }
  }

  // 2. Paragraph-level rules (blocks separated by blank lines)
  const paraRe = /(?:^|\n\n+)([^\n]+(?:\n(?!\n)[^\n]+)*)/g;
  for (const pm of masked.matchAll(paraRe)) {
    const fullMatch = pm[0];
    const paraText = pm[1];
    const paraStart = pm.index + (fullMatch.length - paraText.length);
    const activeLangs = detectLanguages(paraText, packs, candidateLangs);

    for (const lang of activeLangs) {
      const rawPack = packs[lang];
      if (!rawPack) continue;
      const pack = Array.isArray(rawPack) ? normalizePack(rawPack, lang) : rawPack;
      for (const rule of pack.rules) {
        if (!rule.isParagraphRule) continue;
        const flags = rule.flags && rule.flags.includes("g") ? rule.flags : (rule.flags || "") + "g";
        const re = new RegExp(rule.pattern, flags);
        for (const m of paraText.matchAll(re)) {
          const absOffset = paraStart + m.index;
          const { line, column } = lineIndex.offsetToLineCol(absOffset);
          const firstToken = m[0].split(/\s+/)[0];
          findings.push({
            file: filePath,
            line,
            column,
            id: rule.id,
            lang,
            severity: rule.severity,
            match: firstToken,
            message: rule.message,
            suggest: rule.suggest,
          });
        }
      }
    }
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.id.localeCompare(b.id));
  return findings;
}

function collectFiles(targets, config, cwd = process.cwd()) {
  const files = [];
  const walk = (dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relPath = path.relative(cwd, fullPath).replace(/\\/g, "/");
      if (matchesAnyGlob(relPath, config.exclude) || matchesAnyGlob(entry.name, config.exclude)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (matchesAnyGlob(relPath, config.include) || matchesAnyGlob(entry.name, config.include)) {
          files.push(fullPath);
        }
      }
    }
  };

  for (const target of targets) {
    const resolved = path.resolve(cwd, target);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Target path does not exist: ${target}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      walk(resolved);
    } else if (stat.isFile()) {
      files.push(resolved);
    }
  }
  return files;
}

export function formatFinding(f) {
  return `${f.file}:${f.line}:${f.column} [${f.id}] ${f.match} — ${f.message} (${f.suggest})`;
}

export function parseArgs(argv) {
  const opts = {
    lang: null,
    json: false,
    strict: false,
    config: null,
    targets: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--strict") {
      opts.strict = true;
    } else if (arg === "--lang") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("Missing value for --lang");
      }
      opts.lang = val;
    } else if (arg.startsWith("--lang=")) {
      opts.lang = arg.slice("--lang=".length);
      if (!opts.lang) throw new Error("Missing value for --lang");
    } else if (arg === "--config") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error("Missing value for --config");
      }
      opts.config = val;
    } else if (arg.startsWith("--config=")) {
      opts.config = arg.slice("--config=".length);
      if (!opts.config) throw new Error("Missing value for --config");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      opts.targets.push(arg);
    }
  }

  if (opts.targets.length === 0) {
    throw new Error("Usage: node lint-writing.mjs [--lang <lang>] [--json] [--strict] [--config <file>] <files_or_dirs...>");
  }

  return opts;
}

export function runCli(argv = process.argv.slice(2), { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  let config, packs, files;
  try {
    config = loadConfig({ configPath: opts.config, langFlag: opts.lang, cwd });
    packs = loadPacks(config.languages, config.packsDirs);
    files = collectFiles(opts.targets, config, cwd);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  const allFindings = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const rel = path.relative(cwd, file) || path.basename(file);
    const displayPath = rel.startsWith("..") ? file : rel.replace(/\\/g, "/");
    const fileFindings = lintText(content, { filePath: displayPath, config, packs });
    allFindings.push(...fileFindings);
  }

  if (opts.json) {
    stdout.write(JSON.stringify(allFindings, null, 2) + "\n");
  } else {
    for (const f of allFindings) {
      stdout.write(formatFinding(f) + "\n");
    }
  }

  if (opts.strict && allFindings.some((f) => f.severity === "warn")) {
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  process.exitCode = runCli();
}
