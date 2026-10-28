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

describe("natural-writing rule packs (automated bad/good verification)", () => {
  const packFiles = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json")).sort();

  for (const packFile of packFiles) {
    const lang = path.basename(packFile, ".json");
    const rules = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, packFile), "utf8"));

    describe(`pack: ${lang} (${rules.length} rules)`, () => {
      const config = loadConfig({ langFlag: lang });
      const packs = loadPacks(config.languages);

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

  it("disabling languages.ko in config prevents Korean rules from running", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-test-"));
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
