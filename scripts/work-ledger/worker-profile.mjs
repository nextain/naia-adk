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

// The work step selects a configured candidate. CLI names, model names, and
// argv are installation data, shared with the role-session profile reader.
export function resolveWorkerStep(file, step, { workDir, prompt, result }) {
  const profile = tierProfile.loadTierProfileFile(file);
  if (profile.status !== "ok") throw new Error(`Cannot load worker profile: ${file} (${profile.reason ?? profile.status})`);
  const steps = profile.document.worker_steps;
  if (!steps || !Object.hasOwn(steps, step)) throw new Error(`Unknown worker step: ${step}`);
  const assignment = steps[step];
  if (!assignment || !tierProfile.validTierToken(assignment.candidate) || !/^[1-4]$/.test(String(assignment.tier))) {
    throw new Error(`Invalid tier or candidate for worker step: ${step}`);
  }
  const pool = profile.document.tiers[assignment.tier]?.candidates ?? [];
  const matches = pool.filter(candidate => (candidate.id ?? candidate.cli) === assignment.candidate);
  if (matches.length !== 1) throw new Error(`Worker step ${step} must select one configured candidate`);
  const [candidate] = matches;
  if (!tierProfile.validTierToken(candidate.family) || !tierProfile.validWorkerArgv(candidate)) {
    throw new Error(`Worker step ${step} needs a model family and explicit argv for the configured model and effort`);
  }
  const command = tierProfile.expandWorkerArgv(candidate, { work_dir: workDir, prompt_file: prompt, result_file: result });
  return {
    command,
    binding: {
      step,
      profile_sha256: profile.sha256,
      cli: candidate.cli,
      family: candidate.family,
      model: candidate.model,
      effort: candidate.effort ?? null,
      argv_sha256: commandDigest(command),
    },
  };
}

export function checkIndependentReviewer(producer, reviewer) {
  if (!producer) return;
  const normalize = value => value.trim().toLowerCase();
  if (normalize(producer.family) === normalize(reviewer.family) || normalize(producer.model) === normalize(reviewer.model)) {
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
