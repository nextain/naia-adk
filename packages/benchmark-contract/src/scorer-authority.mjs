import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "./price-snapshot.mjs";

export const SCORER_WORKER_DIGEST="530047dae2a7702ded607f89593a73e18e8026a268a23953efadb3f6065ad1c9";
export const scorerWorkerPath=path.join(packageRoot,"src","deterministic-scorer-worker.mjs");
export function assertScorerAuthority(workerPath=scorerWorkerPath){const digest=createHash("sha256").update(fs.readFileSync(workerPath)).digest("hex");if(digest!==SCORER_WORKER_DIGEST)throw Object.assign(new Error(`deterministic scorer worker digest mismatch: ${digest}`),{code:"scorer_worker_tampered"});return digest;}
