import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Compare filesystem paths so symlinked entrypoints still run their main. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
