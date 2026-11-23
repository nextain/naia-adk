import fs from 'node:fs';
import path from 'node:path';
import { readWorkLedgerMetaSync } from '../../packages/core/work-ledger-meta.mjs';
import { validateConfig as validateSessionHealth } from '../session-health.mjs';
import { isWorkerItem, ledgerPath, readLedgerFileSync, safeName } from '../work-ledger/ledger.mjs';
import { parseLedgerYaml, validateWorkLedger } from './ledger.mjs';
import { resolveWakeDir, validateRoleJsonLedger } from './stalled-cards-ledger.mjs';

function samePath(a, b) {
  if (!a || !b) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); }
  catch { return false; }
}

// Use the ledger named by the owner. The common ledger directory can also
// contain a real role file after that role disappears from the routing registry.
function ownerLedgers(registry, findings) {
  const roleFiles = new Map();
  const directory = path.dirname(ledgerPath(registry.root, 'role'));
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json') || entry.name === 'watch-state.json') continue;
      const id = entry.name.slice(0, -5);
      try { safeName(id); } catch { continue; }
      if (entry.isFile() || (entry.isSymbolicLink() && registry.roles.some(role => role.id === id))) {
        roleFiles.set(id, path.join(directory, entry.name));
      } else if (entry.isSymbolicLink()) {
        findings.push({ level: 'error', code: 'open-card-ledger-unavailable', role: id, detail: 'Cannot identify the owner of the linked ledger' });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') findings.push({ level: 'error', code: 'open-card-ledger-unavailable', role: null, detail: 'Cannot enumerate the owner ledger directory' });
  }
  for (const role of registry.roles) if (role.ledger) roleFiles.set(role.id, role.ledger);
  const owners = new Map();
  for (const [id, file] of roleFiles) {
    try {
      if (!fs.statSync(file).isFile()) throw Error('not a ledger file');
      const ledger = readLedgerFileSync(file, id);
      const cards = ledger.items.filter(item => !isWorkerItem(item) && item.status === 'open').map(item => item.id);
      if (cards.length) owners.set(id, { file, ledger, cards: new Set(cards) });
    } catch {
      findings.push({ level: 'error', code: 'open-card-ledger-unavailable', role: id, detail: 'Cannot read a valid owner ledger' });
    }
  }
  return owners;
}

export function cardWatchRole(config) {
  safeName(config.role);
  safeName(config.card);
  for (const field of ['workspace', 'ledgerFile', 'wakeDir']) {
    if (typeof config[field] !== 'string' || !path.isAbsolute(config[field])) throw Error('Invalid card watcher path');
  }
  return { id: config.role };
}

export function inspectOpenCardWatches(registry, registeredViews, now) {
  const findings = [];
  const owners = ownerLedgers(registry, findings);
  const open = [...owners.values()].reduce((count, owner) => count + owner.cards.size, 0);
  const summary = { open, configured: 0, matches: [] };
  if (!owners.size) return { summary, findings };
  const roles = new Map(registry.roles.map(role => [role.id, role]));
  for (const { view, config } of registeredViews) {
    const record = (id, file, wakeDir, workspace, card) => {
      const owner = owners.get(id);
      const role = roles.get(id);
      if (!owner?.cards.size || !role || (view.roles && !view.roles.includes(id))) return;
      if (!samePath(owner.file, file)) return;
      if (workspace) {
        const ownerRoot = path.resolve(path.dirname(owner.file), '../../..');
        const expected = samePath(ledgerPath(ownerRoot, id), owner.file) ? ownerRoot : role.cwd;
        if (!samePath(expected, workspace)) return;
      }
      const boxes = [role.wakeDir, role.routedWakeDir, ...role.extraBoxes.map(box => box.dir)];
      if (!boxes.some(box => samePath(box, wakeDir))) return;
      if (view.kind === 'session-health') {
        try { validateRoleJsonLedger(owner.ledger, id); }
        catch {
          findings.push({ level: 'error', code: 'open-card-watch-unavailable', role: id, detail: 'Session health cannot read this owner ledger' });
          return;
        }
      }
      const before = owner.cards.size;
      if (card) owner.cards.delete(card);
      else owner.cards.clear();
      const count = before - owner.cards.size;
      if (count) {
        summary.configured += count;
        summary.matches.push({ role: id, kind: view.kind, config: view.path, count, ...(card && { card }) });
      }
    };
    try {
      if (view.kind === 'ledger-watch') {
        const root = view.root ?? registry.root;
        for (const { role } of config.roles) record(role, ledgerPath(root, role), path.join(root, '.agents/work/l4/wake'));
      } else if (view.kind === 'card-watch') {
        record(config.role, config.ledgerFile, config.wakeDir, config.workspace, config.card);
      } else {
        validateSessionHealth(config);
        const meta = readWorkLedgerMetaSync(config);
        if (config.workLedger) validateWorkLedger(parseLedgerYaml(fs.readFileSync(config.workLedger, 'utf8')), now);
        for (const role of config.roles) {
          const file = role.ledgerFile ?? (meta && path.join(meta.dir, safeName(role.id) + '.json'));
          const ledgerRole = meta?.config?.roles.find(entry => entry.role === role.id);
          record(role.id, file, resolveWakeDir(role, ledgerRole, meta), role.workspace);
        }
      }
    } catch {
      findings.push({ level: 'error', code: 'open-card-watch-unavailable', role: null, detail: `Cannot verify registered ${view.kind} configuration or ledger at ${view.path}` });
    }
  }
  for (const [role, owner] of owners) {
    if (owner.cards.size) findings.push({ level: 'error', code: 'open-card-unwatched', role,
      cards: [...owner.cards].sort(), detail: `${owner.cards.size} open card(s) have no matching registered watcher for this ledger and wake box` });
  }
  return { summary, findings };
}
