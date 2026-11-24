import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 14 languages per naia.land SUPPORTED_LOCALES (en + 13 translations).
// File names for the existing four are frozen for link/test compatibility.
const READMES = [
  { file: 'README.md', label: 'English' },
  { file: 'README.ko.md', label: '한국어' },
  { file: 'README.ja.md', label: '日本語' },
  { file: 'README.zh-CN.md', label: '简体中文' },
  { file: 'README.fr.md', label: 'Français' },
  { file: 'README.de.md', label: 'Deutsch' },
  { file: 'README.ru.md', label: 'Русский' },
  { file: 'README.es.md', label: 'Español' },
  { file: 'README.ar.md', label: 'العربية' },
  { file: 'README.hi.md', label: 'हिन्दी' },
  { file: 'README.bn.md', label: 'বাংলা' },
  { file: 'README.pt.md', label: 'Português' },
  { file: 'README.id.md', label: 'Bahasa Indonesia' },
  { file: 'README.vi.md', label: 'Tiếng Việt' },
];

const SIBLINGS = [
  'https://github.com/nextain/naia-shell',
  'https://github.com/nextain/naia-agent',
  'https://github.com/nextain/naia-memory',
  'https://github.com/nextain/naia-kb-compiler',
];

const REQUIRED_LINKS = [...SIBLINGS, 'https://nextain.io', 'https://naia.nextain.io'];

for (const { file } of READMES) {
  test(`${file} exists`, () => {
    assert.ok(existsSync(join(root, file)), `${file} is missing`);
  });
}

for (const { file, label } of READMES) {
  test(`${file} language bar links all 14 languages (self bold)`, () => {
    const body = readFileSync(join(root, file), 'utf8');
    const bar = body.split('\n').slice(0, 3).join('\n');
    // Self is bold, not a link.
    assert.ok(
      bar.includes(`**${label}**`),
      `${file} language bar must bold its own label **${label}**`,
    );
    // Every other language is a relative-file link.
    for (const target of READMES) {
      if (target.file === file) continue;
      assert.ok(
        bar.includes(`](${target.file})`),
        `${file} language bar is missing link to ${target.file}`,
      );
    }
    // All 14 languages are represented in the bar: self as a bold label,
    // the other 13 as relative-file links.
    for (const target of READMES) {
      if (target.file === file) continue;
      assert.ok(
        bar.includes(target.file),
        `${file} language bar is missing ${target.file}`,
      );
    }
  });

  test(`${file} links all four sibling repos plus nextain.io and naia.nextain.io`, () => {
    const body = readFileSync(join(root, file), 'utf8');
    for (const url of REQUIRED_LINKS) {
      assert.ok(body.includes(url), `${file} is missing ${url}`);
    }
  });

  test(`${file} has no legacy naia-os links`, () => {
    const body = readFileSync(join(root, file), 'utf8');
    assert.ok(
      !body.includes('naia-os'),
      `${file} still references the legacy naia-os repository`,
    );
  });
}
