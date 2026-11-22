import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safeName } from './ledger.mjs';

// The inbox consumes notices by moving or deleting them. An attempt therefore
// needs a receipt outside the stream of readable .md files. Publishing moves
// the only pending copy into the inbox, even across a crash or concurrent polls.
export async function publishScheduledCompletion({ wakeDir, role, cardId, startedAt, pid, resultFile, now }) {
  safeName(cardId);
  const suffix = `-route-${safeName(role)}.md`;
  const key = createHash('sha256').update(JSON.stringify([role, cardId, startedAt, pid, resultFile])).digest('hex');
  const stamp = new Date(now).toISOString().replace(/\D/g, '');
  const prefix = `${stamp}-ledger-done-${key}`;
  const available = 255 - Buffer.byteLength(suffix);
  if (available < 16) throw new Error('Role too long for completion wake filename');
  const name = prefix.length <= available ? prefix : key.slice(0, available);
  const wakeFile = path.join(wakeDir, name + suffix);
  const receipts = path.join(wakeDir, '.work-watch-completions');
  const receipt = path.join(receipts, key);
  const pending = path.join(receipt, 'pending');
  if (!existsSync(receipt)) {
    await fsp.mkdir(receipts, { recursive: true, mode: 0o700 });
    const staging = await fsp.mkdtemp(path.join(receipts, '.prepare-'));
    try {
      // Keep the directory nonempty after publication so a competing rename cannot replace it.
      await fsp.writeFile(path.join(staging, 'run'), JSON.stringify({ role, cardId, startedAt, pid }), { mode: 0o600 });
      await fsp.writeFile(path.join(staging, 'pending'),
        `[장부] 결과 나옴: ${cardId}\n역할: ${role}\n결과: ${resultFile}\n읽고 닫기: done ${cardId} --result <결과 주소>\n`, { mode: 0o600 });
      try {
        await fsp.rename(staging, receipt);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }
  try {
    await fsp.rename(pending, wakeFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsp.access(path.join(receipt, 'run')); // A retained receipt with no pending file was delivered.
    return null;
  }
  return wakeFile;
}
