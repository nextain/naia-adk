// scripts/stage-gate/v1/fixtures.mjs
//
// Deterministic fixtures for the P0 stage-gate core. Pure data + builders that
// use ONLY the public core API, so every produced chain is self-consistent by
// construction. No I/O, no clock, no randomness.

import {
  ARTIFACT_SPEC,
  RECEIPT_SPEC,
  digestArtifact,
  digestReceipt,
  digestRequest,
  digestScope,
} from './core.mjs';

const encoder = new TextEncoder();

/** UTF-8 encode a string to bytes. */
export function bytes(string) {
  return encoder.encode(string);
}

export const ARTIFACT_IDS = Object.freeze(Object.keys(ARTIFACT_SPEC));

/** Fixed request/scope byte payloads. */
export const REQUEST_BYTES = bytes('naia-adk stage-gate request payload v1');
export const SCOPE_BYTES = bytes('naia-adk stage-gate scope payload v1');

/** Fixed per-artifact byte payloads. */
export const ARTIFACT_BYTES = Object.freeze({
  D01: bytes('# Expert design\nfixed content for D01\n'),
  R01: bytes('# Adversarial review\nfixed content for R01\n'),
  I01: bytes('# Main integration\nfixed content for I01\n'),
  A01: bytes('# Operator approval\nfixed content for A01\n'),
  P01: bytes('scenarios:\n  - fixed P01\n'),
  P02: bytes('coverage:\n  - fixed P02\n'),
  P03: bytes('requirements:\n  - fixed P03\n'),
});

/** A fresh, valid State ({requestBytes, scopeBytes}). */
export function makeState() {
  return {
    requestBytes: REQUEST_BYTES.slice(),
    scopeBytes: SCOPE_BYTES.slice(),
  };
}

/** Build the full, spec-correct artifact array (all seven). */
export function makeArtifacts() {
  return ARTIFACT_IDS.map((id) => ({
    id,
    kind: ARTIFACT_SPEC[id].kind,
    path: ARTIFACT_SPEC[id].path,
    bytes: ARTIFACT_BYTES[id].slice(),
  }));
}

/**
 * Build a valid, ordered five-receipt chain over the given state + artifacts.
 * Returns { artifacts, receipts } (an Observation).
 */
export function makeObservation(state = makeState(), artifacts = makeArtifacts()) {
  const requestDigest = digestRequest(state.requestBytes);
  const scopeDigest = digestScope(state.scopeBytes);
  const artifactDigest = new Map();
  for (const artifact of artifacts) {
    artifactDigest.set(artifact.id, digestArtifact(artifact));
  }
  const receipts = [];
  let previousDigest = null;
  for (const spec of RECEIPT_SPEC) {
    const manifest = spec.manifest.map((id) => ({ id, digest: artifactDigest.get(id) }));
    const core = {
      stage: spec.stage,
      previousDigest,
      requestDigest,
      scopeDigest,
      manifest,
    };
    const digest = digestReceipt(core);
    receipts.push({ ...core, digest });
    previousDigest = digest;
  }
  return { artifacts, receipts };
}

/** Deep structural clone of an Observation (preserving Uint8Array copies). */
export function cloneObservation(observation) {
  return {
    artifacts: observation.artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      path: a.path,
      bytes: a.bytes.slice(),
    })),
    receipts: observation.receipts.map((r) => ({
      stage: r.stage,
      previousDigest: r.previousDigest,
      requestDigest: r.requestDigest,
      scopeDigest: r.scopeDigest,
      manifest: r.manifest.map((m) => ({ id: m.id, digest: m.digest })),
      digest: r.digest,
    })),
  };
}

/** An Observation truncated to the first `n` receipts (a valid prefix chain). */
export function observationPrefix(n, state = makeState()) {
  const full = makeObservation(state);
  return { artifacts: full.artifacts, receipts: full.receipts.slice(0, n) };
}

// ---------------------------------------------------------------------------
// Canonical JSON goldens (exact expected strings)
// ---------------------------------------------------------------------------

export const CANONICAL_GOLDENS = Object.freeze([
  Object.freeze({
    name: 'primitives-and-nesting',
    value: { z: null, a: true, m: false, n: -0, k: [1, -2, 9007199254740991] },
    json: '{"a":true,"k":[1,-2,9007199254740991],"m":false,"n":0,"z":null}',
  }),
  Object.freeze({
    name: 'utf16-code-unit-key-sort',
    value: { b: 1, a: 2, Z: 3, '10': 4, '2': 5 },
    // Code-unit order: digits '1','2' (0x31,0x32) < uppercase 'Z' (0x5A) < lowercase 'a','b'.
    json: '{"10":4,"2":5,"Z":3,"a":2,"b":1}',
  }),
  Object.freeze({
    name: 'unicode-unescaped-controls-escaped',
    value: { s: 'a"b\\c\nd\te\u0001\u001f\u00e9\u{1f600}' },
    json: '{"s":"a\\"b\\\\c\\nd\\te\\u0001\\u001f\u00e9\u{1f600}"}',
  }),
  Object.freeze({
    name: 'empty-containers',
    value: { arr: [], obj: {} },
    json: '{"arr":[],"obj":{}}',
  }),
  Object.freeze({
    name: 'nested-arrays-of-objects',
    value: [{ id: 'D01', digest: 'ab' }, { id: 'R01', digest: 'cd' }],
    json: '[{"digest":"ab","id":"D01"},{"digest":"cd","id":"R01"}]',
  }),
]);

// ---------------------------------------------------------------------------
// Canonical JSON rejects (each entry produces a value canonicalJson must reject)
// ---------------------------------------------------------------------------

export const CANONICAL_REJECTS = Object.freeze([
  Object.freeze({ name: 'NaN', make: () => NaN }),
  Object.freeze({ name: 'Infinity', make: () => Infinity }),
  Object.freeze({ name: '-Infinity', make: () => -Infinity }),
  Object.freeze({ name: 'fraction', make: () => 1.5 }),
  Object.freeze({ name: 'unsafe-integer', make: () => 9007199254740992 }),
  Object.freeze({ name: 'bigint', make: () => 1n }),
  Object.freeze({ name: 'undefined', make: () => undefined }),
  Object.freeze({ name: 'function', make: () => () => 0 }),
  Object.freeze({ name: 'symbol', make: () => Symbol('x') }),
  Object.freeze({ name: 'nested-undefined', make: () => ({ a: undefined }) }),
  Object.freeze({ name: 'array-hole', make: () => [1, , 3] }),
  Object.freeze({ name: 'nonplain-Map', make: () => new Map() }),
  Object.freeze({ name: 'nonplain-Date', make: () => new Date(0) }),
  Object.freeze({
    name: 'class-instance',
    make: () => {
      class Foo {
        constructor() {
          this.x = 1;
        }
      }
      return new Foo();
    },
  }),
  Object.freeze({
    name: 'symbol-key',
    make: () => ({ [Symbol('k')]: 1 }),
  }),
  Object.freeze({
    name: 'accessor-property',
    make: () => Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }),
  }),
  Object.freeze({
    name: 'non-enumerable-property',
    make: () => Object.defineProperty({}, 'a', { value: 1, enumerable: false }),
  }),
  Object.freeze({
    name: 'own-function-toJSON',
    make: () => ({ a: 1, toJSON: () => 'x' }),
  }),
  Object.freeze({
    name: 'array-extra-property',
    make: () => {
      const arr = [1, 2];
      arr.foo = 3;
      return arr;
    },
  }),
  Object.freeze({
    name: 'lone-high-surrogate',
    make: () => ({ s: '\ud800' }),
  }),
  Object.freeze({
    name: 'lone-low-surrogate',
    make: () => ({ s: '\udc00' }),
  }),
  Object.freeze({
    name: 'cycle',
    make: () => {
      const o = {};
      o.self = o;
      return o;
    },
  }),
]);
