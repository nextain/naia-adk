import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestCanonical } from "./validate-bundle.mjs";

export const PRICE_SNAPSHOT_DIGEST = "ce2e719b7fa8d289d9a23b46a1fc6a7b29ab8c74b5daa647b46c147daa3f5ff7";
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const priceSnapshotPath = path.join(packageRoot,"baselines","openai-price-snapshot-2026-07-29.json");

export function loadPriceSnapshot(snapshotPath=priceSnapshotPath) {
  const snapshot=JSON.parse(fs.readFileSync(snapshotPath,"utf8"));
  const digest=digestCanonical(snapshot);
  if (digest !== PRICE_SNAPSHOT_DIGEST) throw Object.assign(new Error(`price snapshot digest mismatch: ${digest}`),{code:"price_snapshot_tampered"});
  return {snapshot,digest};
}

export const {snapshot:priceSnapshot}=loadPriceSnapshot();
