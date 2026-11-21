import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import tierProfile from "../lib/tier-profile.cjs";

export function commandDigest(command) {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

export function workerProfilePath(root, config, role) {
  const roles = config.roles ?? [];
  const entry = roles.find(candidate => candidate.role === role);
  if (!entry && roles.some(candidate => Object.hasOwn(candidate, "tier_profile"))) {
    throw new Error("Role missing in configuration for installed tier profile");
  }
  const file = entry && Object.hasOwn(entry, "tier_profile") ? entry.tier_profile : config.tier_profile;
  if (file === undefined) {
    const conventionalFile = path.join(root, tierProfile.TIER_PROFILE_REL);
    if (!existsSync(conventionalFile)) return null;
    if (!entry) throw new Error("Role missing in configuration for installed tier profile");
    return conventionalFile;
  }
  if (!entry || typeof file !== "string" || !file.trim()) throw new Error("Role requires a configured tier_profile path");
  return path.resolve(root, file);
}

function independentModels(producer, reviewer) {
  const normalize = value => value.trim().toLowerCase();
  return normalize(producer.family) !== normalize(reviewer.family) && normalize(producer.model) !== normalize(reviewer.model);
}

// Rendezvous hashing gives each card a reproducible draw. Reordering a profile,
// inspecting a queued card, or retrying a launch cannot pick its producer anew.
function selectCandidate(step, assignment, pool, { role, card, producer }) {
  if (assignment.selection === undefined) {
    if (!tierProfile.validTierToken(assignment.candidate)) throw new Error(`Invalid tier or candidate for worker step: ${step}`);
    const matches = pool.filter(candidate => (candidate.id ?? candidate.cli) === assignment.candidate);
    if (matches.length !== 1) throw new Error(`Worker step ${step} must select one configured candidate`);
    return matches[0];
  }
  if (assignment.selection !== "shuffle" || Object.hasOwn(assignment, "candidate")) {
    throw new Error(`Choose a single candidate or shuffle the tier for worker step: ${step}`);
  }
  if (!role || !card?.id) throw new Error("Shuffled dispatch requires the original card and role");
  const ids = new Set();
  const candidates = [];
  for (const candidate of pool) {
    const id = candidate.id ?? candidate.cli;
    if (!tierProfile.validTierToken(id) || ids.has(id) || !tierProfile.validTierToken(candidate.family) || !tierProfile.validWorkerArgv(candidate)) {
      throw new Error("Shuffled candidates need unique IDs, model families and configured argv");
    }
    ids.add(id);
    if (producer && !independentModels(producer, candidate)) continue;
    const rank = createHash("sha256").update(JSON.stringify([role, card.id, card.from?.channel, card.from?.msg_id, String(assignment.tier), id])).digest("hex");
    candidates.push({ candidate, rank });
  }
  if (!candidates.length) throw new Error(producer ? "Independent review requires a different configured model family and model" : "Worker step has no configured candidates");
  candidates.sort((a, b) => a.rank.localeCompare(b.rank));
  return candidates[0].candidate;
}

export function resolveWorkerStep(file, step, context) {
  const profile = tierProfile.loadTierProfileFile(file);
  if (profile.status !== "ok") throw new Error(`Cannot load worker profile: ${file} (${profile.reason ?? profile.status})`);
  const steps = profile.document.worker_steps;
  if (!steps || !Object.hasOwn(steps, step)) throw new Error(`Unknown worker step: ${step}`);
  const assignment = steps[step];
  if (!assignment || !/^[1-4]$/.test(String(assignment.tier))) {
    throw new Error(`Invalid tier or candidate for worker step: ${step}`);
  }
  const pool = profile.document.tiers[assignment.tier]?.candidates ?? [];
  const candidate = selectCandidate(step, assignment, pool, context);
  if (!tierProfile.validTierToken(candidate.family) || !tierProfile.validWorkerArgv(candidate)) {
    throw new Error(`Worker step ${step} needs a model family and explicit argv for the configured model and effort`);
  }
  if (candidate.result_mode !== undefined && !["file", "stdout"].includes(candidate.result_mode)) {
    throw new Error("Worker result_mode must be file or stdout");
  }
  if (candidate.result_mode === "stdout" && candidate.argv.some(arg => arg.includes("{result_file}"))) {
    throw new Error("A stdout worker cannot also write the result file");
  }
  const command = tierProfile.expandWorkerArgv(candidate, { work_dir: context.workDir, prompt_file: context.prompt, result_file: context.result });
  return {
    command,
    binding: {
      step,
      ...(assignment.selection ? { selection: assignment.selection, candidate: candidate.id ?? candidate.cli } : {}),
      profile_sha256: profile.sha256,
      cli: candidate.cli,
      family: candidate.family,
      model: candidate.model,
      effort: candidate.effort ?? null,
      argv_sha256: commandDigest(command),
      ...(candidate.result_mode === "stdout" ? { result_mode: "stdout" } : {}),
    },
  };
}

export function checkIndependentReviewer(producer, reviewer) {
  if (producer && !independentModels(producer, reviewer)) {
    throw new Error("Independent review requires a different configured model family and model");
  }
}

// The resource supervisor executes the tracked launcher as its payload. It keeps
// its usual admission, disk accounting and process-group cleanup around it.
export async function supervisorCommand({ root, role, id, workDir, result, opts, command }) {
  const { loadLedgerConfig } = await import("./ledger.mjs");
  const { config } = await loadLedgerConfig({ root, role, requireRole: false });
  if (!workerProfilePath(root, config, role)) {
    if (opts.parent || opts.prompt || opts["review-of"]) throw new Error("Tracked dispatch requires an installed role profile");
    if (!command.length) throw new Error("Worker requires -- <command...>");
    return command;
  }
  if (command.length || ["model", "tool", "effort", "step", "profile"].some(key => Object.hasOwn(opts, key))) {
    throw new Error("The role profile supplies the worker command, model, effort and step");
  }
  const { startWorkerRun } = await import("./worker-run.mjs");
  const prompt = opts.prompt || opts.instruction;
  const args = {
    root, role, id, name: opts.name || id, parent: opts.parent, prompt,
    cwd: workDir, result, foreground: true, "review-of": opts["review-of"],
  };
  await startWorkerRun({ ...args, dry: true }, []);
  const launcher = fileURLToPath(new URL("./worker-run.mjs", import.meta.url));
  return [process.execPath, launcher, "start", "--foreground", "--root", root, "--role", role, "--id", id,
    "--name", args.name, "--parent", args.parent, "--cwd", workDir, "--prompt", prompt, "--result", result,
    ...(args["review-of"] ? ["--review-of", args["review-of"]] : [])];
}
