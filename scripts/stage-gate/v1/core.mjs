// scripts/stage-gate/v1/core.mjs
//
// P0 stage-gate core — pure, deterministic, dependency-free integrity metadata.
//
// SECURITY MODEL (read this first):
//   This module produces LOCAL, UNAUTHENTICATED INTEGRITY METADATA ONLY.
//   A digest chain here proves that some bytes hash together in a fixed order.
//   It is NEVER authorization, NEVER model identity, and NEVER proof that a
//   user (operator) actually approved anything. Anyone able to produce the
//   input bytes can produce a "valid" chain. Treat every output as a hint
//   for local tooling, not as a security decision.
//
// PURITY CONTRACT:
//   The only import permitted is `node:crypto` (SHA-256 only). This module
//   does not touch fs, path, process, env, child_process/spawn, the network,
//   the clock (Date/performance), or any source of randomness. Every exported
//   function is a pure function of its arguments.
//
// The TextEncoder global (WHATWG/ECMAScript standard) is used purely to obtain
// UTF-8 bytes; it performs no I/O, timing, or randomness.

import { createHash } from 'node:crypto';

export const DOMAIN = 'io.nextain.naia-adk.stage-gate';
export const VERSION = 'v1';

// ---------------------------------------------------------------------------
// Frozen specifications
// ---------------------------------------------------------------------------

/**
 * The exact, ordered artifact set. Every artifact is bound to one immutable
 * (kind, path) pair. `id` order here is the canonical order for the terminal
 * (planning) manifest.
 */
export const ARTIFACT_SPEC = Object.freeze({
  D01: Object.freeze({ kind: 'expert_design', path: '.agents/requirements/design.md' }),
  R01: Object.freeze({ kind: 'adversarial_review', path: '.agents/reviews/adversarial-review.md' }),
  I01: Object.freeze({ kind: 'main_integration', path: '.agents/requirements/integration.md' }),
  A01: Object.freeze({ kind: 'operator_approval', path: '.agents/requirements/operator-approval.md' }),
  P01: Object.freeze({ kind: 'scenarios', path: '.agents/requirements/scenarios.yaml' }),
  P02: Object.freeze({ kind: 'coverage', path: '.agents/requirements/coverage.yaml' }),
  P03: Object.freeze({ kind: 'requirements', path: '.agents/requirements/requirements.yaml' }),
});

/**
 * The ordered, cumulative receipt chain. Each stage's manifest lists the
 * artifact ids (in exact order) it binds. The first receipt links to `null`;
 * every later receipt links to the previous receipt's digest.
 */
export const RECEIPT_SPEC = Object.freeze([
  Object.freeze({ stage: 'expert_design', manifest: Object.freeze(['D01']) }),
  Object.freeze({ stage: 'adversarial_review', manifest: Object.freeze(['D01', 'R01']) }),
  Object.freeze({ stage: 'main_integration', manifest: Object.freeze(['D01', 'R01', 'I01']) }),
  Object.freeze({ stage: 'operator_approval', manifest: Object.freeze(['D01', 'R01', 'I01', 'A01']) }),
  Object.freeze({
    stage: 'planning_contract',
    manifest: Object.freeze(['D01', 'R01', 'I01', 'A01', 'P01', 'P02', 'P03']),
  }),
]);

/**
 * Cumulative expected artifact id sets keyed by valid receipt prefix. Stage `i`
 * requires exactly the union of all artifact ids bound by receipts 0..i.
 * PRIVATE: this table is an internal implementation detail of
 * {@link evaluateStageGate} and is intentionally NOT exported (the public
 * module surface is exactly the names listed in PROTOCOL.md).
 */
const CUMULATIVE_EXPECTED = Object.freeze({
  0: Object.freeze([]),
  1: Object.freeze(['D01']),
  2: Object.freeze(['D01', 'R01']),
  3: Object.freeze(['D01', 'R01', 'I01']),
  4: Object.freeze(['D01', 'R01', 'I01', 'A01']),
  5: Object.freeze(['D01', 'R01', 'I01', 'A01', 'P01', 'P02', 'P03']),
});

/** Stable violation codes returned by {@link evaluateStageGate}. */
export const VIOLATION = Object.freeze({
  STATE_INVALID: 'STATE_INVALID',
  OBSERVATION_INVALID: 'OBSERVATION_INVALID',
  ARTIFACT_INVALID: 'ARTIFACT_INVALID',
  ARTIFACT_UNKNOWN: 'ARTIFACT_UNKNOWN',
  ARTIFACT_KIND_MISMATCH: 'ARTIFACT_KIND_MISMATCH',
  ARTIFACT_PATH_MISMATCH: 'ARTIFACT_PATH_MISMATCH',
  ARTIFACT_DUPLICATE: 'ARTIFACT_DUPLICATE',
  RECEIPT_INVALID: 'RECEIPT_INVALID',
  RECEIPT_STAGE_MISMATCH: 'RECEIPT_STAGE_MISMATCH',
  RECEIPT_PREVIOUS_MISMATCH: 'RECEIPT_PREVIOUS_MISMATCH',
  RECEIPT_REQUEST_MISMATCH: 'RECEIPT_REQUEST_MISMATCH',
  RECEIPT_SCOPE_MISMATCH: 'RECEIPT_SCOPE_MISMATCH',
  RECEIPT_MANIFEST_MISMATCH: 'RECEIPT_MANIFEST_MISMATCH',
  RECEIPT_DIGEST_MISMATCH: 'RECEIPT_DIGEST_MISMATCH',
  RECEIPT_DUPLICATE: 'RECEIPT_DUPLICATE',
  REPLAY: 'REPLAY',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  ARTIFACT_EXTRA: 'ARTIFACT_EXTRA',
});

// Ordered receipt/full-receipt key sets.
const RECEIPT_CORE_KEYS = ['stage', 'previousDigest', 'requestDigest', 'scopeDigest', 'manifest'];
const RECEIPT_FULL_KEYS = [...RECEIPT_CORE_KEYS, 'digest'];

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function fail(message) {
  throw new TypeError(message);
}

/** UTF-8 encode a JS string to bytes (no BOM). */
function utf8(string) {
  return textEncoder.encode(string);
}

/** True ONLY for genuine Uint8Array instances: prototype must be exactly
 *  Uint8Array.prototype. This rejects Buffer (a Uint8Array subclass) and any
 *  custom subclass or spoof object that merely passes `instanceof Uint8Array`
 *  or fakes the typed-array shape. Genuine native semantics are required so a
 *  tampered/fake byte buffer cannot masquerade as authentic integrity input. */
function isUint8Array(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Uint8Array.prototype
  );
}

/** True ONLY for genuine native Set instances: prototype must be exactly
 *  Set.prototype. This rejects Set subclasses (e.g. a class extending Set that
 *  overrides has/add) and spoof objects, so replay tracking cannot be silently
 *  subverted by a fake set with overridden membership semantics. */
function isNativeSet(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Set.prototype
  );
}

/** True for plain objects and null-prototype objects (rejects arrays, class instances, Map, etc.). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Big-endian unsigned 64-bit length prefix. */
function u64be(length) {
  const out = new Uint8Array(8);
  let value = BigInt(length);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Domain-separated, length-prefixed framing.
 *
 *   utf8(DOMAIN + '\0' + VERSION + '\0' + kind + '\0')
 *   || u64be(fieldCount)
 *   || for each field: u64be(utf8(name).length) || utf8(name)
 *                      || u64be(bytes.length)   || bytes
 *
 * @param {string} kind
 * @param {Array<[string, Uint8Array]>} fields
 * @returns {Uint8Array}
 */
function frame(kind, fields) {
  if (typeof kind !== 'string') fail('frame: kind must be a string');
  if (!Array.isArray(fields)) fail('frame: fields must be an array');
  const chunks = [utf8(`${DOMAIN}\0${VERSION}\0${kind}\0`), u64be(fields.length)];
  for (const field of fields) {
    if (!Array.isArray(field) || field.length !== 2) fail('frame: each field must be [name, bytes]');
    const [name, bytes] = field;
    if (typeof name !== 'string') fail('frame: field name must be a string');
    if (!isUint8Array(bytes)) fail('frame: field bytes must be a Uint8Array');
    const nameBytes = utf8(name);
    chunks.push(u64be(nameBytes.length), nameBytes, u64be(bytes.length), bytes);
  }
  return concatBytes(chunks);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** True when `string` contains no lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(string) {
  for (let i = 0; i < string.length; i += 1) {
    const code = string.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = string.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true; // high surrogate not followed by low
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true; // low surrogate with no high
  }
  return false;
}

/**
 * Reject lone surrogate Unicode scalar values BEFORE any utf8()/hash input.
 *
 * `TextEncoder.encode` silently maps any lone surrogate to U+FFFD (EF BF BD),
 * so an artifact id/path like "\uD800" and the replacement char "\uFFFD" would
 * hash to IDENTICAL bytes. We must reject the lone surrogate up front so the
 * two can never be accepted as the same valid artifact (collision regression).
 */
function assertNoLoneSurrogate(string, label) {
  if (hasLoneSurrogate(string)) {
    fail(`digestArtifact: ${label} must not contain a lone surrogate`);
  }
}

/**
 * Reject: empty, leading '/', any '\\', any NUL, any '//', trailing '/',
 * any '.'/'..' segment, and any lone surrogate.
 */
function isValidArtifactPath(path) {
  if (typeof path !== 'string') return false;
  if (path.length === 0) return false;
  if (path.charCodeAt(0) === 0x2f) return false; // leading '/'
  if (path.indexOf('\\') !== -1) return false; // backslash anywhere
  if (path.indexOf('\0') !== -1) return false; // NUL anywhere
  if (path.indexOf('//') !== -1) return false; // empty segment
  if (path.charCodeAt(path.length - 1) === 0x2f) return false; // trailing '/'
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') return false;
  }
  if (hasLoneSurrogate(path)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

function encodeCanonicalString(string) {
  let out = '"';
  for (let i = 0; i < string.length; i += 1) {
    const code = string.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = string.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += string[i] + string[i + 1];
        i += 1;
        continue;
      }
      fail('canonicalJson: lone surrogate in string');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('canonicalJson: lone surrogate in string');
    }
    switch (code) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += string[i];
        }
    }
  }
  return `${out}"`;
}

function encodeCanonicalValue(value, ancestors) {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value ? 'true' : 'false';

  if (type === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('canonicalJson: numbers must be safe integers (no NaN/Infinity/fraction/unsafe)');
    }
    if (Object.is(value, -0)) return '0';
    return String(value);
  }

  if (type === 'string') return encodeCanonicalString(value);

  if (type === 'bigint') fail('canonicalJson: bigint is not allowed');
  if (type === 'undefined') fail('canonicalJson: undefined is not allowed');
  if (type === 'function') fail('canonicalJson: function is not allowed');
  if (type === 'symbol') fail('canonicalJson: symbol is not allowed');

  // Only objects remain.
  if (ancestors.has(value)) fail('canonicalJson: cyclic structure');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return encodeCanonicalArray(value, ancestors);
    }
    return encodeCanonicalObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function isCanonicalArrayIndex(key, length) {
  if (typeof key !== 'string') return false;
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return index < length;
}

function encodeCanonicalArray(array, ancestors) {
  const length = array.length;
  for (const key of Reflect.ownKeys(array)) {
    if (key === 'length') continue;
    if (typeof key === 'symbol') fail('canonicalJson: symbol key on array');
    if (!isCanonicalArrayIndex(key, length)) {
      fail('canonicalJson: array has a non-index own property');
    }
  }
  const parts = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, i);
    if (!descriptor) fail('canonicalJson: sparse array (missing index)');
    if (descriptor.get || descriptor.set) fail('canonicalJson: accessor in array');
    if (!descriptor.enumerable) fail('canonicalJson: non-enumerable array element');
    parts.push(encodeCanonicalValue(descriptor.value, ancestors));
  }
  return `[${parts.join(',')}]`;
}

function encodeCanonicalObject(object, ancestors) {
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) {
    fail('canonicalJson: only plain or null-prototype objects are allowed');
  }
  const ownKeys = Reflect.ownKeys(object);
  const stringKeys = [];
  for (const key of ownKeys) {
    if (typeof key === 'symbol') fail('canonicalJson: symbol key on object');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor.get || descriptor.set) fail('canonicalJson: accessor property');
    if (!descriptor.enumerable) fail('canonicalJson: non-enumerable property');
    stringKeys.push(key);
  }
  if (Object.prototype.hasOwnProperty.call(object, 'toJSON') && typeof object.toJSON === 'function') {
    fail('canonicalJson: own function toJSON is not allowed');
  }
  // UTF-16 code-unit sort (JS default string relational order).
  stringKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = [];
  for (const key of stringKeys) {
    parts.push(`${encodeCanonicalString(key)}:${encodeCanonicalValue(object[key], ancestors)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Serialize a value to strict canonical JSON (compact, key-sorted by UTF-16
 * code unit). See module/PROTOCOL docs for the exact accept/reject rules.
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return encodeCanonicalValue(value, new Set());
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** sha256 of frame('request', [['request', requestBytes]]). */
export function digestRequest(requestBytes) {
  if (!isUint8Array(requestBytes)) fail('digestRequest: requestBytes must be a Uint8Array');
  return sha256Hex(frame('request', [['request', requestBytes]]));
}

/** sha256 of frame('scope', [['scope', scopeBytes]]). */
export function digestScope(scopeBytes) {
  if (!isUint8Array(scopeBytes)) fail('digestScope: scopeBytes must be a Uint8Array');
  return sha256Hex(frame('scope', [['scope', scopeBytes]]));
}

/**
 * sha256 of frame('artifact', [id, kind, path, bytes]).
 * @param {{id:string, kind:string, path:string, bytes:Uint8Array}} artifact
 */
export function digestArtifact(artifact) {
  if (!isPlainObject(artifact)) fail('digestArtifact: artifact must be a plain object');
  const { id, kind, path, bytes } = artifact;
  if (typeof id !== 'string') fail('digestArtifact: id must be a string');
  assertNoLoneSurrogate(id, 'id');
  if (typeof kind !== 'string') fail('digestArtifact: kind must be a string');
  assertNoLoneSurrogate(kind, 'kind');
  if (typeof path !== 'string') fail('digestArtifact: path must be a string');
  assertNoLoneSurrogate(path, 'path');
  if (!isValidArtifactPath(path)) fail('digestArtifact: invalid path');
  if (!isUint8Array(bytes)) fail('digestArtifact: bytes must be a Uint8Array');
  return sha256Hex(
    frame('artifact', [
      ['id', utf8(id)],
      ['kind', utf8(kind)],
      ['path', utf8(path)],
      ['bytes', bytes],
    ]),
  );
}

/**
 * sha256 of frame('receipt', [['receipt', utf8(canonicalJson(receiptWithoutDigest))]]).
 * The input MUST be a plain/null-prototype object with EXACTLY the five keys
 * stage, previousDigest, requestDigest, scopeDigest, manifest.
 */
export function digestReceipt(receiptWithoutDigest) {
  if (!isPlainObject(receiptWithoutDigest)) {
    fail('digestReceipt: receipt must be a plain object');
  }
  const ownKeys = Reflect.ownKeys(receiptWithoutDigest);
  if (ownKeys.length !== RECEIPT_CORE_KEYS.length) {
    fail('digestReceipt: receipt must have exactly the five core keys');
  }
  for (const key of RECEIPT_CORE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(receiptWithoutDigest, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      fail(`digestReceipt: missing/invalid own enumerable data key "${key}"`);
    }
  }
  return sha256Hex(frame('receipt', [['receipt', utf8(canonicalJson(receiptWithoutDigest))]]));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function hasExactOwnEnumerableDataKeys(object, keys) {
  if (!isPlainObject(object)) return false;
  const ownKeys = Reflect.ownKeys(object);
  if (ownKeys.length !== keys.length) return false;
  for (const key of ownKeys) {
    if (typeof key === 'symbol') return false;
    if (!keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) return false;
  }
  return true;
}

function manifestMatches(actual, expectedIds, digestMap) {
  if (!Array.isArray(actual)) return false;
  if (actual.length !== expectedIds.length) return false;
  for (let k = 0; k < expectedIds.length; k += 1) {
    const entry = actual[k];
    const id = expectedIds[k];
    if (!hasExactOwnEnumerableDataKeys(entry, ['id', 'digest'])) return false;
    if (entry.id !== id) return false;
    if (!digestMap.has(id)) return false;
    if (entry.digest !== digestMap.get(id)) return false;
  }
  return true;
}

/**
 * Evaluate a stage-gate observation against local integrity rules.
 *
 * @param {{requestBytes:Uint8Array, scopeBytes:Uint8Array}} state
 * @param {{artifacts:Array, receipts:Array}} observation
 * @param {Set<string>} replaySet  Native Set of already-consumed final receipt
 *   digests. It is snapshot-copied and NEVER mutated; this function detects
 *   replay but never consumes it (P1 consumes atomically).
 * @returns {{prefix:number,
 *   terminalCandidate:null|{requestDigest:string, scopeDigest:string, finalReceiptDigest:string},
 *   violations:Array<{code:string, path:string}>}}
 *
 * This function makes NO authorization claim. A returned terminalCandidate is
 * merely a local integrity observation; only P1 may consume/finalize it.
 */
export function evaluateStageGate(state, observation, replaySet) {
  if (!isNativeSet(replaySet)) {
    throw new TypeError('evaluateStageGate: replaySet must be a native Set');
  }
  // Snapshot via the INTRINSIC values iterator, NOT `new Set(replaySet)`.
  // `new Set(replaySet)` implicitly uses replaySet's own [Symbol.iterator],
  // which an attacker can replace with an empty generator to poison the
  // snapshot and silently disable replay detection. Set.prototype.values.call
  // ignores any overridden Symbol.iterator and yields only genuine entries.
  const consumed = new Set(Set.prototype.values.call(replaySet)); // snapshot; caller's Set never touched

  const violations = [];
  const add = (code, path) => {
    violations.push({ code, path });
  };
  const result = (prefix, terminalCandidate) => ({
    prefix,
    terminalCandidate,
    violations,
  });

  // --- state -------------------------------------------------------------
  if (
    !hasExactOwnEnumerableDataKeys(state, ['requestBytes', 'scopeBytes']) ||
    !isUint8Array(state.requestBytes) ||
    !isUint8Array(state.scopeBytes)
  ) {
    add(VIOLATION.STATE_INVALID, '/state');
    return result(0, null);
  }
  const requestDigest = digestRequest(state.requestBytes);
  const scopeDigest = digestScope(state.scopeBytes);

  // --- observation shape -------------------------------------------------
  if (
    !hasExactOwnEnumerableDataKeys(observation, ['artifacts', 'receipts']) ||
    !Array.isArray(observation.artifacts) ||
    !Array.isArray(observation.receipts)
  ) {
    add(VIOLATION.OBSERVATION_INVALID, '/observation');
    return result(0, null);
  }

  // --- artifacts ---------------------------------------------------------
  const digestMap = new Map();
  const seenArtifactIds = new Set();
  for (let i = 0; i < observation.artifacts.length; i += 1) {
    const artifact = observation.artifacts[i];
    const path = `/observation/artifacts/${i}`;
    if (!hasExactOwnEnumerableDataKeys(artifact, ['id', 'kind', 'path', 'bytes'])) {
      add(VIOLATION.ARTIFACT_INVALID, path);
      continue;
    }
    if (typeof artifact.id !== 'string' || !Object.prototype.hasOwnProperty.call(ARTIFACT_SPEC, artifact.id)) {
      add(VIOLATION.ARTIFACT_UNKNOWN, path);
      continue;
    }
    const spec = ARTIFACT_SPEC[artifact.id];
    let ok = true;
    if (artifact.kind !== spec.kind) {
      add(VIOLATION.ARTIFACT_KIND_MISMATCH, path);
      ok = false;
    }
    if (artifact.path !== spec.path) {
      add(VIOLATION.ARTIFACT_PATH_MISMATCH, path);
      ok = false;
    }
    if (!isUint8Array(artifact.bytes)) {
      add(VIOLATION.ARTIFACT_INVALID, path);
      ok = false;
    }
    if (seenArtifactIds.has(artifact.id)) {
      add(VIOLATION.ARTIFACT_DUPLICATE, path);
      ok = false;
    }
    seenArtifactIds.add(artifact.id);
    if (ok) {
      digestMap.set(artifact.id, digestArtifact(artifact));
    }
  }

  // --- duplicate receipt digests (independent of chain position) ---------
  const seenReceiptDigests = new Set();
  for (let i = 0; i < observation.receipts.length; i += 1) {
    const receipt = observation.receipts[i];
    if (isPlainObject(receipt) && typeof receipt.digest === 'string') {
      if (seenReceiptDigests.has(receipt.digest)) {
        add(VIOLATION.RECEIPT_DUPLICATE, `/observation/receipts/${i}`);
      } else {
        seenReceiptDigests.add(receipt.digest);
      }
    }
  }

  // --- receipts (ordered prefix chain) -----------------------------------
  let prefix = 0;
  let previousDigest = null;
  // inspectionExpectedPrefix counts structurally valid ordered receipts
  // (stage order + previous/request/scope linkage) BEFORE manifest/digest
  // validation. It is used ONLY for missing/extra artifact diagnostics so a
  // manifest mismatch that resets `prefix` to 0 still surfaces ARTIFACT_MISSING.
  let inspectionPrefix = 0;

  for (let i = 0; i < observation.receipts.length; i += 1) {
    const receipt = observation.receipts[i];
    const path = `/observation/receipts/${i}`;

    if (i >= RECEIPT_SPEC.length) {
      add(VIOLATION.RECEIPT_STAGE_MISMATCH, path); // extra receipt beyond the chain
      break;
    }
    if (!hasExactOwnEnumerableDataKeys(receipt, RECEIPT_FULL_KEYS)) {
      add(VIOLATION.RECEIPT_INVALID, path);
      break;
    }
    const spec = RECEIPT_SPEC[i];
    if (receipt.stage !== spec.stage) {
      add(VIOLATION.RECEIPT_STAGE_MISMATCH, path);
      break;
    }
    if (receipt.previousDigest !== previousDigest) {
      add(VIOLATION.RECEIPT_PREVIOUS_MISMATCH, path);
      break;
    }
    if (receipt.requestDigest !== requestDigest) {
      add(VIOLATION.RECEIPT_REQUEST_MISMATCH, path);
      break;
    }
    if (receipt.scopeDigest !== scopeDigest) {
      add(VIOLATION.RECEIPT_SCOPE_MISMATCH, path);
      break;
    }
    inspectionPrefix += 1;
    if (!manifestMatches(receipt.manifest, spec.manifest, digestMap)) {
      add(VIOLATION.RECEIPT_MANIFEST_MISMATCH, path);
      break;
    }
    let recomputed;
    try {
      recomputed = digestReceipt({
        stage: receipt.stage,
        previousDigest: receipt.previousDigest,
        requestDigest: receipt.requestDigest,
        scopeDigest: receipt.scopeDigest,
        manifest: receipt.manifest,
      });
    } catch {
      recomputed = null;
    }
    if (recomputed === null || receipt.digest !== recomputed) {
      add(VIOLATION.RECEIPT_DIGEST_MISMATCH, path);
      break;
    }
    if (consumed.has(receipt.digest)) {
      add(VIOLATION.REPLAY, path);
      break;
    }
    previousDigest = receipt.digest;
    prefix += 1;
  }

  // --- artifact/prefix exact-set enforcement ------------------------------
  // Use inspectionExpectedPrefix (structurally valid ordered receipt count)
  // so that missing/extra diagnostics fire even when manifest digest
  // validation resets the authoritative `prefix` to 0.
  const inspectionExpectedIds =
    CUMULATIVE_EXPECTED[inspectionPrefix] || CUMULATIVE_EXPECTED[0];
  const expectedSet = new Set(inspectionExpectedIds);
  for (const id of inspectionExpectedIds) {
    if (!seenArtifactIds.has(id)) {
      add(VIOLATION.ARTIFACT_MISSING, `/observation/artifacts:${id}`);
    }
  }
  for (const id of seenArtifactIds) {
    if (!expectedSet.has(id)) {
      add(VIOLATION.ARTIFACT_EXTRA, `/observation/artifacts:${id}`);
    }
  }

  // --- terminal candidate: only a full, clean five-receipt chain ---------
  let terminalCandidate = null;
  if (violations.length === 0 && prefix === RECEIPT_SPEC.length && observation.receipts.length === RECEIPT_SPEC.length) {
    terminalCandidate = Object.freeze({
      requestDigest,
      scopeDigest,
      finalReceiptDigest: observation.receipts[RECEIPT_SPEC.length - 1].digest,
    });
  }

  return result(prefix, terminalCandidate);
}
