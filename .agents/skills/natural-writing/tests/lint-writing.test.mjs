import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig, loadPacks, lintText, runCli } from "../scripts/lint-writing.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, "..");
const PACKS_DIR = path.join(SKILL_DIR, "scripts", "packs");
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function captureCli(args, cwd = SKILL_DIR) {
  let out = "";
  let err = "";
  const stdout = { write: (s) => { out += s; } };
  const stderr = { write: (s) => { err += s; } };
  const code = runCli(args, { cwd, stdout, stderr });
  return { code, stdout: out, stderr: err };
}

function makeTmpDirOrSkip(t, prefix = "nw-test-") {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  } catch (err) {
    t.skip(`os.tmpdir() (${os.tmpdir()}) is not writable in this environment: ${err.code || err.message}`);
    return null;
  }
}

describe("natural-writing rule packs (automated bad/good verification)", () => {
  const packFiles = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json")).sort();

  for (const packFile of packFiles) {
    const lang = path.basename(packFile, ".json");
    const rawPack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, packFile), "utf8"));
    const rules = Array.isArray(rawPack) ? rawPack : rawPack.rules || [];

    describe(`pack: ${lang} (${rules.length} rules)`, () => {
      const config = loadConfig({ langFlag: lang });
      const packs = loadPacks(config.languages);

      it(`pack [${lang}] defines detect metadata (script, minChars, minRatio)`, () => {
        assert.ok(!Array.isArray(rawPack) && rawPack.detect, `${packFile} must have a top-level detect object`);
        assert.equal(typeof rawPack.detect.script, "string");
        assert.equal(typeof rawPack.detect.minChars, "number");
        assert.equal(typeof rawPack.detect.minRatio, "number");
      });

      for (const rule of rules) {
        it(`rule [${rule.id}] has valid schema, bad examples match, good examples do not match`, () => {
          assert.ok(rule.id && typeof rule.id === "string");
          assert.ok(rule.pattern && typeof rule.pattern === "string");
          assert.ok(rule.severity === "warn" || rule.severity === "hint");
          assert.ok(rule.message && typeof rule.message === "string");
          assert.ok(rule.suggest && typeof rule.suggest === "string");
          assert.ok(Array.isArray(rule.bad) && rule.bad.length >= 1, `${rule.id} must have >= 1 bad example`);
          assert.ok(Array.isArray(rule.good) && rule.good.length >= 1, `${rule.id} must have >= 1 good example`);

          for (const badExample of rule.bad) {
            const findings = lintText(badExample, { filePath: "bad.md", config, packs });
            const matchedIds = findings.map((f) => f.id);
            assert.ok(
              matchedIds.includes(rule.id),
              `Expected rule '${rule.id}' to match bad example: "${badExample}", but got [${matchedIds.join(", ")}]`,
            );
          }

          for (const goodExample of rule.good) {
            const findings = lintText(goodExample, { filePath: "good.md", config, packs });
            const matchedIds = findings.map((f) => f.id);
            assert.ok(
              !matchedIds.includes(rule.id),
              `Expected rule '${rule.id}' NOT to match good example: "${goodExample}", but it matched`,
            );
          }
        });
      }
    });
  }
});

describe("fixtures verification", () => {
  it("ko-positive.md triggers at least one finding", () => {
    const res = captureCli(["--json", path.join(FIXTURES_DIR, "ko-positive.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    assert.ok(findings.length >= 10, `Expected >= 10 findings in ko-positive.md, got ${findings.length}`);
  });

  it("ko-negative.md has 0 warn findings", () => {
    const res = captureCli(["--json", path.join(FIXTURES_DIR, "ko-negative.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    const warns = findings.filter((f) => f.severity === "warn");
    assert.equal(warns.length, 0, `Expected 0 warns in ko-negative.md, got ${JSON.stringify(warns)}`);
  });

  it("en-positive.md triggers at least one finding", () => {
    const res = captureCli(["--json", path.join(FIXTURES_DIR, "en-positive.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    assert.ok(findings.length >= 10, `Expected >= 10 findings in en-positive.md, got ${findings.length}`);
  });

  it("en-negative.md has 0 warn findings", () => {
    const res = captureCli(["--json", path.join(FIXTURES_DIR, "en-negative.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    const warns = findings.filter((f) => f.severity === "warn");
    assert.equal(warns.length, 0, `Expected 0 warns in en-negative.md, got ${JSON.stringify(warns)}`);
  });

  it("protected.md has 0 findings across code blocks, inline code, URLs, blockquotes, and quotes", () => {
    const res = captureCli(["--json", path.join(FIXTURES_DIR, "protected.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    assert.equal(findings.length, 0, `Expected 0 findings in protected.md, got ${JSON.stringify(findings)}`);
  });
});

describe("language selection and configuration priority", () => {
  it("running with --lang en on a Korean file produces 0 findings", () => {
    const res = captureCli(["--lang", "en", "--json", path.join(FIXTURES_DIR, "ko-positive.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    assert.equal(findings.length, 0);
  });

  it("running with --lang ko on an English file produces 0 findings", () => {
    const res = captureCli(["--lang", "ko", "--json", path.join(FIXTURES_DIR, "en-positive.md")]);
    assert.equal(res.code, 0);
    const findings = JSON.parse(res.stdout);
    assert.equal(findings.length, 0);
  });

  it("disabling languages.ko in config prevents Korean rules from running", (t) => {
    const tmpDir = makeTmpDirOrSkip(t);
    if (!tmpDir) return;
    try {
      const cfgPath = path.join(tmpDir, "config.json");
      fs.writeFileSync(cfgPath, JSON.stringify({ languages: { ko: false, en: true } }), "utf8");

      const koRes = captureCli(["--config", cfgPath, "--json", path.join(FIXTURES_DIR, "ko-positive.md")]);
      assert.equal(koRes.code, 0);
      assert.equal(JSON.parse(koRes.stdout).length, 0);

      const enRes = captureCli(["--config", cfgPath, "--json", path.join(FIXTURES_DIR, "en-positive.md")]);
      assert.equal(enRes.code, 0);
      assert.ok(JSON.parse(enRes.stdout).length >= 1);

      // CLI --lang ko overrides config languages.ko=false
      const overrideRes = captureCli(["--config", cfgPath, "--lang", "ko", "--json", path.join(FIXTURES_DIR, "ko-positive.md")]);
      assert.equal(overrideRes.code, 0);
      assert.ok(JSON.parse(overrideRes.stdout).length >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("issue 2: adding a new language pack (fr) with detect works via config and --lang without code changes", (t) => {
    const scriptSource = fs.readFileSync(path.join(SKILL_DIR, "scripts", "lint-writing.mjs"), "utf8");
    assert.ok(!/\b(?:koCount|enCount|jaCount|SCRIPT_RANGES)\b/.test(scriptSource), "lint-writing.mjs must not hardcode SCRIPT_RANGES or language count branches");
    assert.ok(!/detected\s*=\s*["'](?:ko|en|ja|zh)["']/.test(scriptSource), "lint-writing.mjs must not branch on hardcoded language codes");

    const testPacksDir = path.join(FIXTURES_DIR, "packs");
    const enabledConfig = {
      languages: { ko: true, en: true, fr: true },
      protect: ["code", "inline_code", "url", "blockquote", "quoted"],
      forcedLang: null,
    };
    const enabledPacks = loadPacks(enabledConfig.languages, [testPacksDir, PACKS_DIR]);

    // en and fr share the Latin script, so plain Latin text is ambiguous and skipped for both
    const ambiguousFindings = lintText("bonjour monde", { filePath: "fr.md", config: enabledConfig, packs: enabledPacks });
    assert.equal(ambiguousFindings.length, 0);

    // Automatic detection catches "bonjour monde" when fr is the only Latin-script pack enabled
    const koFrConfig = { ...enabledConfig, languages: { ko: true, fr: true } };
    const koFrPacks = loadPacks(koFrConfig.languages, [testPacksDir, PACKS_DIR]);
    const autoOnFindings = lintText("bonjour monde", { filePath: "fr.md", config: koFrConfig, packs: koFrPacks });
    assert.equal(autoOnFindings.length, 1);
    assert.equal(autoOnFindings[0].id, "fr-il-convient-de-noter");
    assert.equal(autoOnFindings[0].lang, "fr");

    // Disabling fr prevents the rule from running
    const disabledConfig = {
      languages: { ko: true, en: true, fr: false },
      protect: ["code", "inline_code", "url", "blockquote", "quoted"],
      forcedLang: null,
    };
    const disabledPacks = loadPacks(disabledConfig.languages, [testPacksDir, PACKS_DIR]);
    const autoOffFindings = lintText("bonjour monde", { filePath: "fr.md", config: disabledConfig, packs: disabledPacks });
    assert.equal(autoOffFindings.length, 0);

    // Forcing --lang fr runs the fr pack on French text and skips Korean text
    const forcedConfig = {
      languages: { fr: true },
      protect: ["code", "inline_code", "url", "blockquote", "quoted"],
      forcedLang: "fr",
    };
    const forcedPacks = loadPacks(forcedConfig.languages, [testPacksDir, PACKS_DIR]);
    const forcedFrFindings = lintText("bonjour monde", { filePath: "fr.md", config: forcedConfig, packs: forcedPacks });
    assert.equal(forcedFrFindings.length, 1);
    assert.equal(forcedFrFindings[0].id, "fr-il-convient-de-noter");

    const forcedOnKoFindings = lintText("변경 사항이 오늘 적용되어졌다.", { filePath: "ko.md", config: forcedConfig, packs: forcedPacks });
    assert.equal(forcedOnKoFindings.length, 0);

    // Paragraph-level rule in fr pack works under both auto-detect and --lang fr
    const frParaPacks = {
      fr: {
        detect: { script: "[A-Za-z\\u00C0-\\u00FF]", minChars: 3, minRatio: 0.6 },
        rules: [
          {
            id: "fr-ensuite-repeat",
            lang: "fr",
            pattern: "\\bEnsuite,[\\s\\S]*?\\bEnsuite,",
            flags: "g",
            severity: "hint",
            message: "Repetition de Ensuite",
            suggest: "Varier les transitions",
            isParagraphRule: true,
          },
        ],
      },
    };
    const paraInput = "Ensuite, le module charge la configuration.\nEnsuite, il verifie chaque ligne.";
    const paraAuto = lintText(paraInput, {
      filePath: "fr-para.md",
      config: { languages: { fr: true }, protect: [], forcedLang: null },
      packs: frParaPacks,
    });
    assert.equal(paraAuto.length, 1);
    assert.equal(paraAuto[0].id, "fr-ensuite-repeat");

    const paraForced = lintText(paraInput, {
      filePath: "fr-para.md",
      config: { languages: { fr: true }, protect: [], forcedLang: "fr" },
      packs: frParaPacks,
    });
    assert.equal(paraForced.length, 1);
    assert.equal(paraForced[0].id, "fr-ensuite-repeat");
  });

  it("issue 2 (tmpdir CLI): temporary config in os.tmpdir() toggles fr pack and skips cleanly if read-only", (t) => {
    const testPacksDir = path.join(FIXTURES_DIR, "packs");
    const tmpDir = makeTmpDirOrSkip(t, "nw-fr-");
    if (!tmpDir) return;
    try {
      const samplePath = path.join(tmpDir, "sample.md");
      fs.writeFileSync(samplePath, "bonjour monde\n", "utf8");
      const cfgOnPath = path.join(tmpDir, "cfg-on.json");
      fs.writeFileSync(cfgOnPath, JSON.stringify({ languages: { en: false, fr: true }, packsDir: testPacksDir }), "utf8");
      const cfgOffPath = path.join(tmpDir, "cfg-off.json");
      fs.writeFileSync(cfgOffPath, JSON.stringify({ languages: { fr: false }, packsDir: testPacksDir }), "utf8");

      const resOn = captureCli(["--config", cfgOnPath, "--json", samplePath]);
      assert.equal(resOn.code, 0);
      assert.equal(JSON.parse(resOn.stdout).length, 1);

      const resOff = captureCli(["--config", cfgOffPath, "--json", samplePath]);
      assert.equal(resOff.code, 0);
      assert.equal(JSON.parse(resOff.stdout).length, 0);

      const resForced = captureCli(["--config", cfgOffPath, "--lang", "fr", "--json", samplePath]);
      assert.equal(resForced.code, 0);
      assert.equal(JSON.parse(resForced.stdout).length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("stateful protected regions and UTF-16/code-point alignment (issues 3, 4, 5, 6, 1, 7)", () => {
  it("issue 3: unclosed code fence, 3-opened/4-closed fence, and multiline quotes produce 0 warnings", () => {
    const config = loadConfig({});
    const packs = loadPacks(config.languages);

    // 1. Unclosed fence
    const unclosedFence = "```js\n적용되어졌다.";
    const f1 = lintText(unclosedFence, { filePath: "unclosed.md", config, packs });
    assert.equal(f1.filter((f) => f.severity === "warn").length, 0, `Expected 0 warns on unclosed fence, got ${JSON.stringify(f1)}`);

    // 2. Opened with 3 backticks, closed with 4 backticks
    const longerCloseFence = "```\n적용되어졌다.\n````\n정상 문장이다.";
    const f2 = lintText(longerCloseFence, { filePath: "longer-close.md", config, packs });
    assert.equal(f2.filter((f) => f.severity === "warn").length, 0, `Expected 0 warns on 3->4 fence, got ${JSON.stringify(f2)}`);

    // 3. Multiline curly quotes and straight quotes within a paragraph
    const multilineCurly = "“이 문장은\n적용되어졌다.\n라고 썼다.”";
    const f3 = lintText(multilineCurly, { filePath: "multiline-curly.md", config, packs });
    assert.equal(f3.filter((f) => f.severity === "warn").length, 0, `Expected 0 warns on multiline curly quote, got ${JSON.stringify(f3)}`);

    const multilineStraight = "\"이 문장은\n적용되어졌다.\n라고 썼다.\"";
    const f4 = lintText(multilineStraight, { filePath: "multiline-straight.md", config, packs });
    assert.equal(f4.filter((f) => f.severity === "warn").length, 0, `Expected 0 warns on multiline straight quote, got ${JSON.stringify(f4)}`);

    // Unmatched quote in one paragraph must not protect subsequent paragraphs
    const unmatchedQuote = "첫 문단에 짝 없는 \"따옴표가 있다.\n\n둘째 문단에서 변경 사항이 적용되어졌다.";
    const f5 = lintText(unmatchedQuote, { filePath: "unmatched.md", config, packs });
    assert.equal(f5.filter((f) => f.id === "ko-double-passive").length, 1);
  });

  it("issue 4: emojis (surrogate pairs) before protected spans keep masking offsets aligned", () => {
    const config = loadConfig({});
    const packs = loadPacks(config.languages);
    const emojis = "😀".repeat(10);

    // 10 emojis followed by quoted "되어졌다." -> 0 findings
    const quotedAfterEmojis = `${emojis} "되어졌다."`;
    assert.equal(lintText(quotedAfterEmojis, { filePath: "emoji1.md", config, packs }).length, 0);

    // 10 emojis line followed by blockquote "> 되어졌다." -> 0 findings
    const bqAfterEmojis = `${emojis}\n> 되어졌다.`;
    assert.equal(lintText(bqAfterEmojis, { filePath: "emoji2.md", config, packs }).length, 0);

    // 10 emojis followed by "safe" 되어졌다. -> 1 finding
    const unquotedAfterEmojis = `${emojis} "safe" 되어졌다.`;
    const findings = lintText(unquotedAfterEmojis, { filePath: "emoji3.md", config, packs });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "ko-double-passive");
  });

  it("issue 5: normal location/domain sentences do not trigger warn findings", () => {
    const config = loadConfig({});
    const packs = loadPacks(config.languages);

    const koLoc = lintText("책이 가방에 있어 바로 찾았다.", { filePath: "ko.md", config, packs });
    assert.equal(koLoc.filter((f) => f.severity === "warn").length, 0);

    const enSoil = lintText("The archaeologists delve into the soil.", { filePath: "en1.md", config, packs });
    assert.equal(enSoil.filter((f) => f.severity === "warn").length, 0);

    const enLoan = lintText("The company leveraged its assets to secure the loan.", { filePath: "en2.md", config, packs });
    assert.equal(enLoan.filter((f) => f.severity === "warn").length, 0);
  });

  it("issue 6: column is 1-based Unicode code-point index from start of line (tab = 1 column)", () => {
    const config = loadConfig({});
    const packs = loadPacks(config.languages);

    const emojiLine = lintText("😀 적용되어졌다.", { filePath: "col1.md", config, packs });
    assert.equal(emojiLine.length, 1);
    assert.equal(emojiLine[0].column, 5);

    const tabLine = lintText("\t적용되어졌다.", { filePath: "col2.md", config, packs });
    assert.equal(tabLine.length, 1);
    assert.equal(tabLine[0].column, 4);
  });

  it("issues 1 & 7 & recommendations: SKILL.md, references, and sources.md follow contextual & governance rules", () => {
    const skillMd = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    const commonMd = fs.readFileSync(path.join(SKILL_DIR, "references", "common.md"), "utf8");
    const koMd = fs.readFileSync(path.join(SKILL_DIR, "references", "ko.md"), "utf8");
    const enMd = fs.readFileSync(path.join(SKILL_DIR, "references", "en.md"), "utf8");
    const sourcesMd = fs.readFileSync(path.join(SKILL_DIR, "references", "sources.md"), "utf8");

    // Issue 1: contextual checklist in common.md, ko.md, en.md and paragraph review in SKILL.md
    assert.match(commonMd, /What the Linter Cannot Catch/i);
    assert.match(koMd, /검사기가 못 잡는 것/);
    assert.match(koMd, /빠르고, 쉽고, 안전합니다\./);
    assert.match(enMd, /What the Linter Cannot Catch/i);
    assert.match(skillMd, /contextual checklist/i);

    // Issue 6 & 7: column definition, detect thresholds, and human final review in SKILL.md
    assert.match(skillMd, /code.?point/i);
    assert.match(skillMd, /minRatio/);
    assert.match(skillMd, /minChars/);
    assert.ok(!/김정우/.test(sourcesMd), "sources.md must not include paper author personal names");
  });
});

describe("exit codes and output formatting", () => {
  it("returns exit code 0 by default even when warnings exist, and 1 with --strict", () => {
    const target = path.join(FIXTURES_DIR, "ko-positive.md");
    const defaultRes = captureCli([target]);
    assert.equal(defaultRes.code, 0);
    assert.match(defaultRes.stdout, /ko-positive\.md:\d+:\d+ \[ko-[a-z-]+\] .+ — .+ \(.+\)/);

    const strictRes = captureCli(["--strict", target]);
    assert.equal(strictRes.code, 1);

    const strictCleanRes = captureCli(["--strict", path.join(FIXTURES_DIR, "ko-negative.md")]);
    assert.equal(strictCleanRes.code, 0);
  });

  it("returns exit code 2 on argument or config errors", () => {
    assert.equal(captureCli([]).code, 2);
    assert.equal(captureCli(["--unknown-flag", "file.md"]).code, 2);
    assert.equal(captureCli(["--lang"]).code, 2);
    assert.equal(captureCli(["--config", "/nonexistent/config.json", path.join(FIXTURES_DIR, "ko-negative.md")]).code, 2);
    assert.equal(captureCli(["/nonexistent/target.md"]).code, 2);
  });
});

describe("review round 2 regressions", () => {
  it("--lang ko checks Korean text even when English letters dominate the line", () => {
    const config = { languages: { ko: true, en: true }, protect: [], forcedLang: "ko" };
    const packs = loadPacks({ ko: true }, [PACKS_DIR]);
    const findings = lintText("A documentation example that contains many English words and 적용되어졌다.", { filePath: "x.md", config, packs });
    assert.ok(findings.some((f) => f.id === "ko-double-passive"));
  });

  it("a fence indented four or more spaces is indented code and does not hide later prose", () => {
    const config = { languages: { ko: true }, protect: ["code"], forcedLang: null };
    const packs = loadPacks(config.languages, [PACKS_DIR]);
    const input = "    ```\n    example\n\n변경 사항이 적용되어졌다.\n";
    const findings = lintText(input, { filePath: "x.md", config, packs });
    assert.ok(findings.some((f) => f.id === "ko-double-passive" && f.line === 4));
  });

  it("a fence indented up to three spaces is still protected", () => {
    const config = { languages: { ko: true }, protect: ["code"], forcedLang: null };
    const packs = loadPacks(config.languages, [PACKS_DIR]);
    const findings = lintText("   ```\n적용되어졌다.\n   ```\n", { filePath: "x.md", config, packs });
    assert.equal(findings.length, 0);
  });

  it("with en and fr enabled, English rules do not run on an ambiguous Latin-script line", () => {
    const config = { languages: { en: true, fr: true }, protect: [], forcedLang: null };
    const packs = loadPacks(config.languages, [path.join(FIXTURES_DIR, "packs"), PACKS_DIR]);
    const findings = lintText("Cette expression utilise not just a game, but a test dans un exemple.", { filePath: "x.md", config, packs });
    assert.equal(findings.filter((f) => f.lang === "en").length, 0);
  });
});
