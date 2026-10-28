#!/usr/bin/env node
/**
 * lint-writing.mjs — Language-selectable translationese & AI-writing candidate finder.
 * Uses Node.js standard library only. Never modifies source files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, "..");
const PACKS_DIR = path.join(__dirname, "packs");
const DEFAULT_CONFIG_PATH = path.join(SKILL_DIR, "defaults.json");

// Character script ranges used only by the line-level language detector.
// Rule packs themselves are loaded dynamically from packs/<lang>.json.
const SCRIPT_RANGES = {
  ko: /[\uAC00-\uD7A3\u3131-\u318E]/g,
  en: /[A-Za-z]/g,
  ja: /[\u3040-\u309F\u30A0-\u30FF]/g,
  zh: /[\u4E00-\u9FFF]/g,
};

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

/**
 * Detect the dominant language of a text segment among enabled languages.
 * Returns null if ambiguous or if no script characters are sufficient.
 */
export function detectLanguage(text, enabledLangs) {
  if (!enabledLangs || enabledLangs.length === 0) return null;
  const scores = {};
  let totalScriptChars = 0;

  for (const [lang, regex] of Object.entries(SCRIPT_RANGES)) {
    const count = countMatches(text, regex);
    scores[lang] = count;
    totalScriptChars += count;
  }

  if (totalScriptChars < 2) return null;

  // Korean Hangul is distinctive: if Hangul accounts for >= 15% of script chars (or >= 2 chars when Hangul >= Latin),
  // classify as 'ko' if 'ko' is enabled; if 'ko' is disabled, do not misclassify a Korean line as 'en'.
  const koCount = scores.ko || 0;
  const enCount = scores.en || 0;
  const jaCount = scores.ja || 0;

  let detected = null;
  if (jaCount >= 2 && jaCount >= koCount) {
    detected = "ja";
  } else if (koCount >= 2 && koCount / totalScriptChars >= 0.15) {
    detected = "ko";
  } else if (enCount >= 3 && enCount / totalScriptChars >= 0.6 && koCount === 0 && jaCount === 0) {
    detected = "en";
  } else {
    // Fallback for any other language in SCRIPT_RANGES
    let bestLang = null;
    let bestScore = 0;
    let secondScore = 0;
    for (const [lang, score] of Object.entries(scores)) {
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestLang = lang;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    if (bestLang && bestScore >= 3 && bestScore > secondScore * 2) {
      detected = bestLang;
    }
  }

  if (!detected) return null;
  return enabledLangs.includes(detected) ? detected : null;
}

/**
 * Replace protected spans with spaces (preserving newlines and character offsets)
 * so line and column numbers stay exact while protected regions are never matched.
 */
export function maskProtectedRegions(content, protectList = ["code", "inline_code", "url", "blockquote", "quoted"]) {
  const protect = new Set(protectList);
  const chars = Array.from(content);

  const blankRange = (start, end) => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") {
        chars[i] = " ";
      }
    }
  };

  // 1. Fenced code blocks (``` or ~~~)
  if (protect.has("code")) {
    const fenceRe = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
    for (const match of content.matchAll(fenceRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterCode = chars.join("");

  // 2. Blockquote lines (> ...)
  if (protect.has("blockquote")) {
    const bqRe = /^[ \t]*>[^\n]*$/gm;
    for (const match of afterCode.matchAll(bqRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterBq = chars.join("");

  // 3. Inline code (`...`)
  if (protect.has("inline_code")) {
    const inlineRe = /`+[^`\n]+`+/g;
    for (const match of afterBq.matchAll(inlineRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterInline = chars.join("");

  // 4. URLs (http://, https://, and markdown link targets)
  if (protect.has("url")) {
    const urlRe = /https?:\/\/[^\s)>\]"']+/g;
    for (const match of afterInline.matchAll(urlRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  const afterUrl = chars.join("");

  // 5. Quoted text ("..." and “...”)
  if (protect.has("quoted")) {
    const curlyQuoteRe = /\u201C[^\u201D\n]*\u201D/g;
    for (const match of afterUrl.matchAll(curlyQuoteRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
    const straightQuoteRe = /"[^"\n]*"/g;
    const afterCurly = chars.join("");
    for (const match of afterCurly.matchAll(straightQuoteRe)) {
      blankRange(match.index, match.index + match[0].length);
    }
  }

  return chars.join("");
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

  if (configPath) {
    const resolved = path.resolve(cwd, configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    projectConfig = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } else {
    const implicitPath = path.resolve(cwd, ".agents/context/natural-writing.json");
    if (fs.existsSync(implicitPath)) {
      projectConfig = JSON.parse(fs.readFileSync(implicitPath, "utf8"));
    }
  }

  const merged = {
    languages: { ...defaults.languages, ...(projectConfig.languages || {}) },
    include: projectConfig.include || defaults.include,
    exclude: projectConfig.exclude || defaults.exclude,
    protect: projectConfig.protect || defaults.protect,
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

export function loadPacks(languagesMap, packsDir = PACKS_DIR) {
  const packs = {};
  for (const [lang, enabled] of Object.entries(languagesMap || {})) {
    if (!enabled) continue;
    const packFile = path.join(packsDir, `${lang}.json`);
    if (!fs.existsSync(packFile)) {
      throw new Error(`Language pack not found for '${lang}': ${packFile}`);
    }
    const rules = JSON.parse(fs.readFileSync(packFile, "utf8"));
    packs[lang] = rules.map((r) => ({
      ...r,
      lang,
      isParagraphRule: r.pattern.includes("[\\s\\S]"),
    }));
  }
  return packs;
}

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return {
    starts,
    offsetToLineCol(offset) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= offset) lo = mid + 1;
        else hi = mid - 1;
      }
      const lineIdx = Math.max(0, hi);
      return {
        line: lineIdx + 1,
        column: offset - starts[lineIdx] + 1,
      };
    },
  };
}

export function lintText(content, { filePath = "<input>", config, packs }) {
  const enabledLangs = Object.keys(packs);
  if (enabledLangs.length === 0) return [];

  const masked = maskProtectedRegions(content, config.protect);
  const lineIndex = buildLineIndex(masked);
  const lines = masked.split("\n");
  const findings = [];

  // Determine active language per line
  const lineLangs = lines.map((lineText) => {
    if (config.forcedLang) {
      // Even when --lang is forced, only run if the line actually contains characters of that language
      const scriptRegex = SCRIPT_RANGES[config.forcedLang];
      if (scriptRegex) {
        const detected = detectLanguage(lineText, [config.forcedLang]);
        return detected;
      }
      return config.forcedLang;
    }
    return detectLanguage(lineText, enabledLangs);
  });

  // 1. Line-level rules
  let lineOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lang = lineLangs[i];
    if (lang && packs[lang]) {
      for (const rule of packs[lang]) {
        if (rule.isParagraphRule) continue;
        const flags = rule.flags && rule.flags.includes("g") ? rule.flags : (rule.flags || "") + "g";
        const re = new RegExp(rule.pattern, flags);
        for (const m of lineText.matchAll(re)) {
          findings.push({
            file: filePath,
            line: i + 1,
            column: m.index + 1,
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
    lineOffset += lineText.length + 1;
  }

  // 2. Paragraph-level rules (blocks separated by blank lines)
  const paraRe = /(?:^|\n\n+)([^\n]+(?:\n(?!\n)[^\n]+)*)/g;
  for (const pm of masked.matchAll(paraRe)) {
    const fullMatch = pm[0];
    const paraText = pm[1];
    const paraStart = pm.index + (fullMatch.length - paraText.length);
    const lang = config.forcedLang
      ? detectLanguage(paraText, [config.forcedLang])
      : detectLanguage(paraText, enabledLangs);
    if (!lang || !packs[lang]) continue;

    for (const rule of packs[lang]) {
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
    packs = loadPacks(config.languages);
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
