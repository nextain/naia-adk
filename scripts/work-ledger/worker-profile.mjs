import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import tierProfile from "../lib/tier-profile.cjs";
import { isNativeResult, requireFreshInvocation } from "./native-session-result.mjs";

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
    if (producer && !independentModels(producer, candidate) &&
        !(Number(assignment.tier) === 2 && pool.length === 1 && isNativeResult(candidate.result_mode))) continue;
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
  if (assignment.selection === "ordered") {
    if (Number(assignment.tier) !== 1 || context.producer || Object.hasOwn(assignment, "candidate")) {
      throw new Error("Ordered selection is for tier 1 sensor steps");
    }
    if (!pool.length) throw new Error("Ordered sensor step has no configured candidates");
    const seen = new Set();
    const ordered = pool.map(candidate => {
      const id = candidate.id ?? candidate.cli;
      const codes = candidate.unavailable_exit_codes ?? [];
      if (!tierProfile.validTierToken(id) || seen.has(id) || candidate.result_mode !== "stdout") {
        throw new Error("Ordered sensors require unique candidate IDs and stdout results");
      }
      if (!Array.isArray(codes) || !codes.every(n => Number.isInteger(n) && n > 0 && n < 126)) {
        throw new Error("Invalid unavailable_exit_codes for sensor " + id);
      }
      seen.add(id);
      return { ...bindCandidate(profile, step, assignment, candidate, context), unavailableExitCodes: codes };
    });
    return { ...ordered[0], ordered };
  }
  return bindCandidate(profile, step, assignment, selectCandidate(step, assignment, pool, context), context);
}

function bindCandidate(profile, step, assignment, candidate, context) {
  if (!tierProfile.validTierToken(candidate.family) || !tierProfile.validWorkerArgv(candidate)) {
    throw new Error(`Worker step ${step} needs a model family and explicit argv for the configured model and effort`);
  }
  const mode = candidate.result_mode ?? "file";
  if (!["file", "stdout"].includes(mode) && !isNativeResult(mode)) {
    throw new Error("Unknown worker result_mode: " + mode);
  }
  if (mode !== "file" && candidate.argv.some(arg => arg.includes("{result_file}"))) {
    throw new Error("A stdout worker cannot also write the result file");
  }
  const command = tierProfile.expandWorkerArgv(candidate, { work_dir: context.workDir, prompt_file: context.prompt, result_file: context.result });
  if (isNativeResult(mode)) requireFreshInvocation(mode, command);
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
      ...(mode !== "file" ? { result_mode: mode } : {}),
      ...(isNativeResult(mode) && Number(assignment.tier) === 2 && profile.document.tiers["2"].candidates.length === 1
        ? { single_model_review: true } : {}),
    },
  };
}

export function checkIndependentReviewer(producer, reviewer) {
  if (producer && !independentModels(producer, reviewer)) {
    if (producer.single_model_review && reviewer.single_model_review && producer.session_id &&
        producer.profile_sha256 === reviewer.profile_sha256 && producer.result_mode === reviewer.result_mode &&
        producer.cli === reviewer.cli && producer.model === reviewer.model && producer.family === reviewer.family) return;
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
