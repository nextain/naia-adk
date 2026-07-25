// scripts/stage-gate/v1/core.test.mjs
//
// Self-contained test suite for the P0 stage-gate core. Node built-ins only
// (node:assert). No I/O, no clock, no randomness. Run:
//
//   node scripts/stage-gate/v1/core.test.mjs
//
// Coverage: five golden vectors, canonical-JSON accept/reject, path validation,
// hash framing, artifact rules, receipt chain / tamper / replay / no-mutation,
// and terminal candidate semantics.

import assert from 'node:assert';

import {
  ARTIFACT_SPEC,
  RECEIPT_SPEC,
  VIOLATION,
  DOMAIN,
  VERSION,
  canonicalJson,
  digestRequest,
  digestScope,
  digestArtifact,
  digestReceipt,
  evaluateStageGate,
} from './core.mjs';

import {
  bytes,
  makeState,
  makeArtifacts,
  makeObservation,
  cloneObservation,
  observationPrefix,
  ARTIFACT_IDS,
  CANONICAL_GOLDENS,
  CANONICAL_REJECTS,
} from './fixtures.mjs';

let passed = 0;
let failed = 0;

// CUMULATIVE_EXPECTED is private to core.mjs (not exported). Tests derive the
// same cumulative artifact-id sets locally from the exported RECEIPT_SPEC:
// prefix n expects exactly the manifest of receipt n-1 (cumulative), and
// prefix 0 expects the empty set.
const CUMULATIVE_EXPECTED = Object.freeze(
  Object.fromEntries([
    [0, Object.freeze([])],
    ...RECEIPT_SPEC.map((spec, i) => [i + 1, spec.manifest]),
  ]),
);

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok   - ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`FAIL - ${name}\n`);
    process.stdout.write(
      `       ${err && err.stack ? err.stack.split('\n').join('\n       ') : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Golden vectors (frozen expected outputs — lock the wire format)
// ---------------------------------------------------------------------------

const GOLDEN = Object.freeze({
  request: '390373874e1cffcc57dbc0ce10e7b9345cb28712d93e3975222f441efbb49934',
  scope: 'ef4628e149d8964f7d187bcbcbec98bf438f0e1f2f28bb9b7b009a5f1a825adf',
  artifacts: Object.freeze({
    D01: '43d3c9149b93176f80b380b12d69a9a4f11c362231ad1afab639e58f9462272b',
    R01: '626fadbd97b2471745f3cc91aaeb017727d96076238523ec5ad4a3a33f1d6bb1',
    I01: 'eb63830cb7293324a797117dd3a9a60856f8c2f407ae0ed09c9a7c2242414533',
    A01: 'cb2164150d7617b30fa63e72d6fe3d37e409ecc5a01e94a8223d50a5c409e466',
    P01: '3fd52a06ce1563071bada136c7ed0c224c839d969b8de74f10058dcc80162995',
    P02: '314aee6c6b685d0c0e26a658c91c0066f13e0ac40a0989427cdb21498cdf6773',
    P03: '9bfd7705827217c5c22a9e68feae9be369e8f64667779c680a6253567ad68323',
  }),
  receipts: Object.freeze([
    '4bdc757fe7c43876a89a541cb214edd967b378345472b1e059e677e65f3d89b8',
    'dfe6db52c8d8aad49d15bf075042a4086d05e5e2c8515f240f3c8197096ca18d',
    '4dadc0211419d0a6382fe9d5c40451ddf95b5d1684253d8e93e16dc0c9c02d3b',
    '4141aa7ff8496f066ddffb3d4e005ac1869b4cbbb31c97b13b320c2cbdf7c6ac',
    '61df422ee98d80bcada67c12173ee228ed7e8c30ab3c68ebea4cd0a4a3bcdb40',
  ]),
});

// Golden vector #1: request digest.
test('golden vector 1: digestRequest', () => {
  assert.strictEqual(digestRequest(makeState().requestBytes), GOLDEN.request);
});

// Golden vector #2: scope digest.
test('golden vector 2: digestScope', () => {
  assert.strictEqual(digestScope(makeState().scopeBytes), GOLDEN.scope);
});

// Golden vector #3: all seven artifact digests.
test('golden vector 3: digestArtifact for all seven artifacts', () => {
  for (const artifact of makeArtifacts()) {
    assert.strictEqual(digestArtifact(artifact), GOLDEN.artifacts[artifact.id]);
  }
});

// Golden vector #4: the ordered five-receipt digest chain.
test('golden vector 4: five-receipt digest chain', () => {
  const obs = makeObservation();
  assert.strictEqual(obs.receipts.length, 5);
  obs.receipts.forEach((r, i) => {
    assert.strictEqual(r.digest, GOLDEN.receipts[i]);
  });
});

// Golden vector #5: canonical JSON goldens (exact strings).
test('golden vector 5: canonical JSON golden strings', () => {
  for (const g of CANONICAL_GOLDENS) {
    assert.strictEqual(canonicalJson(g.value), g.json, `canonical golden: ${g.name}`);
  }
});

// ---------------------------------------------------------------------------
// Canonical JSON — accept
// ---------------------------------------------------------------------------

test('canonicalJson: null / booleans', () => {
  assert.strictEqual(canonicalJson(null), 'null');
  assert.strictEqual(canonicalJson(true), 'true');
  assert.strictEqual(canonicalJson(false), 'false');
});

test('canonicalJson: -0 normalizes to 0', () => {
  assert.strictEqual(canonicalJson(-0), '0');
  assert.strictEqual(canonicalJson({ n: -0 }), '{"n":0}');
});

test('canonicalJson: safe integer bounds', () => {
  assert.strictEqual(canonicalJson(9007199254740991), '9007199254740991');
  assert.strictEqual(canonicalJson(-9007199254740991), '-9007199254740991');
  assert.strictEqual(canonicalJson(0), '0');
});

test('canonicalJson: keys sorted by UTF-16 code unit', () => {
  assert.strictEqual(canonicalJson({ b: 1, a: 2, Z: 3, '10': 4, '2': 5 }), '{"10":4,"2":5,"Z":3,"a":2,"b":1}');
});

test('canonicalJson: control chars escaped, other unicode unescaped', () => {
  assert.strictEqual(canonicalJson('a\nb\t\u0001\u00e9'), '"a\\nb\\t\\u0001\u00e9"');
});

test('canonicalJson: empty containers', () => {
  assert.strictEqual(canonicalJson({ arr: [], obj: {} }), '{"arr":[],"obj":{}}');
});

test('canonicalJson: null-prototype object accepted', () => {
  const o = Object.create(null);
  o.a = 1;
  assert.strictEqual(canonicalJson(o), '{"a":1}');
});

test('canonicalJson: deterministic for equal inputs', () => {
  const v = { z: [1, { q: 'x' }], a: null };
  assert.strictEqual(canonicalJson(v), canonicalJson({ a: null, z: [1, { q: 'x' }] }));
});

// ---------------------------------------------------------------------------
// Canonical JSON — reject (one named test per malformed value)
// ---------------------------------------------------------------------------

for (const reject of CANONICAL_REJECTS) {
  test(`canonicalJson rejects malformed value: ${reject.name}`, () => {
    assert.throws(() => canonicalJson(reject.make()), TypeError);
  });
}

// ---------------------------------------------------------------------------
// Path validation (through digestArtifact, which validates the path)
// ---------------------------------------------------------------------------

function artifactWithPath(path) {
  return { id: 'D01', kind: 'expert_design', path, bytes: bytes('x') };
}

test('path: valid POSIX relative path accepted', () => {
  assert.match(digestArtifact(artifactWithPath('a/b/c.md')), /^[0-9a-f]{64}$/);
});

const BAD_PATHS = Object.freeze({
  empty: '',
  'leading slash': '/a/b',
  backslash: 'a\\b',
  NUL: 'a\0b',
  'double slash': 'a//b',
  'trailing slash': 'a/b/',
  'dot segment': 'a/./b',
  'dotdot segment': 'a/../b',
  'lone high surrogate': 'a/\ud800/b',
  'lone low surrogate': 'a/\udc00/b',
});

for (const [name, path] of Object.entries(BAD_PATHS)) {
  test(`path rejects malformed path: ${name}`, () => {
    assert.throws(() => digestArtifact(artifactWithPath(path)), TypeError);
  });
}

// ---------------------------------------------------------------------------
// Lone-surrogate artifact id/kind/path — reject BEFORE digest
// ---------------------------------------------------------------------------
//
// TextEncoder.encode silently maps any lone (unpaired) UTF-16 surrogate to the
// replacement char U+FFFD (EF BF BD). A lone-surrogate id/kind/path and the
// literal U+FFFD would therefore hash to IDENTICAL UTF-8 bytes, creating a
// collision regression where two distinct artifacts are accepted as one.
// digestArtifact must assertNoLoneSurrogate on id/kind/path BEFORE utf8()/hashing
// so the two can never be accepted. The constraint lives in core.js and is
// enforced by digestArtifact (called by evaluateStageGate on the clean path).

function artifactWithField(field, value) {
  const base = { id: 'D01', kind: 'expert_design', path: 'a/b.md', bytes: bytes('x') };
  base[field] = value;
  return base;
}

test('lone surrogate: artifact id with lone high surrogate rejected before digest', () => {
  assert.throws(() => digestArtifact(artifactWithField('id', 'D\ud8001')), TypeError);
});

test('lone surrogate: artifact id with lone low surrogate rejected before digest', () => {
  assert.throws(() => digestArtifact(artifactWithField('id', 'D\udc001')), TypeError);
});

test('lone surrogate: artifact kind with lone surrogate rejected before digest', () => {
  assert.throws(() => digestArtifact(artifactWithField('kind', 'expert\ud800design')), TypeError);
});

test('lone surrogate: artifact path with lone surrogate rejected before digest', () => {
  assert.throws(() => digestArtifact(artifactWithField('path', 'a/\udc00b.md')), TypeError);
});

test('lone surrogate: document collision rationale (lone surrogate == U+FFFD in UTF-8)', () => {
  // Proves WHY rejection must happen before hashing: a lone surrogate and the
  // replacement char encode to identical bytes, so digestArtifact refuses the
  // lone surrogate up front rather than letting them collide.
  assert.deepStrictEqual([...new TextEncoder().encode('\ud800')], [...new TextEncoder().encode('\ufffd')]);
});

// ---------------------------------------------------------------------------
// Native-check enforcement: Set subclass + Uint8Array subclass/spoof
// ---------------------------------------------------------------------------
//
// The documented native checks (isNativeSet, isUint8Array) require the prototype
// to be EXACTLY Set.prototype / Uint8Array.prototype. This rejects Set subclasses
// (overridable has/add), Uint8Array subclasses such as Buffer, and spoof objects
// that merely fake the typed-array shape, so tampered buffers or fake replay
// sets cannot masquerade as authentic integrity input.

class SetSubclass extends Set {}
class Uint8ArraySubclass extends Uint8Array {}

test('native check: Set subclass rejected as replaySet (throws TypeError)', () => {
  const state = makeState();
  const obs = makeObservation(state);
  assert.throws(() => evaluateStageGate(state, obs, new SetSubclass()), TypeError);
});

test('native check: Uint8Array subclass rejected as digest bytes', () => {
  const sub = new Uint8ArraySubclass([1, 2, 3]);
  assert.throws(() => digestRequest(sub), TypeError);
  assert.throws(() => digestScope(sub), TypeError);
});

test('native check: Buffer (Uint8Array subclass) rejected as digest bytes', () => {
  const buf = Buffer.from('abc');
  assert.throws(() => digestRequest(buf), TypeError);
  assert.throws(() => digestScope(buf), TypeError);
});

test('native check: Uint8Array spoof (plain object faking shape) rejected as digest bytes', () => {
  const spoof = { length: 3, 0: 1, 1: 2, 2: 3 };
  assert.throws(() => digestRequest(spoof), TypeError);
  assert.throws(() => digestScope(spoof), TypeError);
});

test('native check: Uint8Array subclass bytes flagged ARTIFACT_INVALID', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].bytes = new Uint8ArraySubclass(obs.artifacts[0].bytes);
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('native check: Uint8Array spoof bytes flagged ARTIFACT_INVALID', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].bytes = { length: 1, 0: 0 };
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

// ---------------------------------------------------------------------------
// Hash framing / digest wrappers
// ---------------------------------------------------------------------------

test('framing: domain and version constants', () => {
  assert.strictEqual(DOMAIN, 'io.nextain.naia-adk.stage-gate');
  assert.strictEqual(VERSION, 'v1');
});

test('framing: domain separation (request vs scope of same bytes differ)', () => {
  const b = bytes('identical');
  assert.notStrictEqual(digestRequest(b), digestScope(b));
});

test('framing: different bytes yield different digests', () => {
  assert.notStrictEqual(digestRequest(bytes('a')), digestRequest(bytes('b')));
});

test('framing: digestRequest rejects non-Uint8Array (strict bytes)', () => {
  assert.throws(() => digestRequest([1, 2, 3]), TypeError);
  assert.throws(() => digestScope('not-bytes'), TypeError);
});

test('framing: digestArtifact rejects non-Uint8Array bytes', () => {
  assert.throws(
    () => digestArtifact({ id: 'D01', kind: 'expert_design', path: 'a.md', bytes: [1, 2] }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Lone-surrogate collision regression (digestArtifact id/kind/path)
// ---------------------------------------------------------------------------

test('collision: lone surrogate \ud800 and U+FFFD cannot hash as same valid artifact', () => {
  const base = {
    id: 'D01',
    kind: 'expert_design',
    path: '.agents/requirements/design.md',
    bytes: bytes('x'),
  };
  // Without a guard, TextEncoder.encode('\ud800') and TextEncoder.encode('\ufffd')
  // both produce the U+FFFD bytes (EF BF BD), so they would collide. The guard
  // rejects the lone surrogate so the two can NEVER be the same valid artifact.
  assert.throws(() => digestArtifact({ ...base, id: '\ud800' }), TypeError, 'lone surrogate id rejected');
  assert.throws(() => digestArtifact({ ...base, kind: '\udc00' }), TypeError, 'lone surrogate kind rejected');
  assert.throws(() => digestArtifact({ ...base, path: 'a/\ud800/b.md' }), TypeError, 'lone surrogate path rejected');

  // The replacement char is accepted and yields its own distinct valid digest.
  let fffdDigest;
  assert.doesNotThrow(() => {
    fffdDigest = digestArtifact({ ...base, id: '\ufffd' });
  }, 'U+FFFD id is a valid artifact');
  assert.match(fffdDigest, /^[0-9a-f]{64}$/);

  // The lone-surrogate input has no valid digest at all, so it cannot equal the
  // U+FFFD artifact. They are provably distinct (one rejected, one accepted).
  assert.notStrictEqual(
    (() => {
      try {
        return digestArtifact({ ...base, id: '\ud800' });
      } catch {
        return null; // rejected -> no valid digest
      }
    })(),
    fffdDigest,
  );
});

// ---------------------------------------------------------------------------
// Genuine/native Uint8Array semantics (reject subclass / spoof bytes)
// ---------------------------------------------------------------------------

test('framing: digestRequest rejects Uint8Array subclass (e.g. Buffer)', () => {
  class FakeBytes extends Uint8Array {}
  const fake = new FakeBytes(3);
  fake.set([1, 2, 3]);
  assert.throws(() => digestRequest(fake), TypeError);
  assert.throws(() => digestScope(fake), TypeError);
});

test('framing: digestRequest rejects spoof byte-like object', () => {
  const spoof = { length: 3, 0: 1, 1: 2, 2: 3 };
  assert.throws(() => digestRequest(spoof), TypeError);
  assert.throws(() => digestScope(spoof), TypeError);
});

test('framing: digestArtifact rejects Uint8Array subclass bytes', () => {
  class FakeBytes extends Uint8Array {}
  const fake = new FakeBytes(1);
  fake.set([42]);
  assert.throws(
    () => digestArtifact({ id: 'D01', kind: 'expert_design', path: 'a.md', bytes: fake }),
    TypeError,
  );
});

test('framing: digestArtifact rejects spoof byte-like object', () => {
  const spoof = { length: 1, 0: 42 };
  assert.throws(
    () => digestArtifact({ id: 'D01', kind: 'expert_design', path: 'a.md', bytes: spoof }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// digestReceipt exact-five-keys enforcement
// ---------------------------------------------------------------------------

function corePreimage() {
  const st = makeState();
  return {
    stage: 'expert_design',
    previousDigest: null,
    requestDigest: digestRequest(st.requestBytes),
    scopeDigest: digestScope(st.scopeBytes),
    manifest: [{ id: 'D01', digest: GOLDEN.artifacts.D01 }],
  };
}

test('digestReceipt: accepts exact five-key preimage', () => {
  assert.strictEqual(digestReceipt(corePreimage()), GOLDEN.receipts[0]);
});

test('digestReceipt: rejects extra key', () => {
  assert.throws(() => digestReceipt({ ...corePreimage(), digest: 'x' }), TypeError);
});

test('digestReceipt: rejects missing key', () => {
  const p = corePreimage();
  delete p.manifest;
  assert.throws(() => digestReceipt(p), TypeError);
});

// ---------------------------------------------------------------------------
// Artifact rules (through evaluateStageGate)
// ---------------------------------------------------------------------------

function evalFull(mutate) {
  const state = makeState();
  const obs = cloneObservation(makeObservation(state));
  if (mutate) mutate(obs, state);
  return evaluateStageGate(state, obs, new Set());
}

function hasViolation(result, code) {
  return result.violations.some((v) => v.code === code);
}

test('artifacts: full valid chain produces terminal candidate', () => {
  const r = evalFull();
  assert.strictEqual(r.violations.length, 0);
  assert.strictEqual(r.prefix, 5);
  assert.ok(r.terminalCandidate);
  assert.strictEqual(r.terminalCandidate.finalReceiptDigest, GOLDEN.receipts[4]);
  assert.strictEqual(r.terminalCandidate.requestDigest, GOLDEN.request);
  assert.strictEqual(r.terminalCandidate.scopeDigest, GOLDEN.scope);
});

test('artifacts: spec covers exactly seven ids in canonical order', () => {
  assert.deepStrictEqual(Object.keys(ARTIFACT_SPEC), ['D01', 'R01', 'I01', 'A01', 'P01', 'P02', 'P03']);
});

test('artifacts: unknown id flagged ARTIFACT_UNKNOWN', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].id = 'Z99';
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_UNKNOWN));
  assert.strictEqual(r.terminalCandidate, null);
});

test('artifacts: kind mismatch flagged', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].kind = 'wrong_kind';
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_KIND_MISMATCH));
});

test('artifacts: path mismatch flagged', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].path = '.agents/requirements/other.md';
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_PATH_MISMATCH));
});

test('artifacts: duplicate id flagged', () => {
  const r = evalFull((obs) => {
    obs.artifacts.push({ ...obs.artifacts[0], bytes: obs.artifacts[0].bytes.slice() });
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_DUPLICATE));
});

test('artifacts: non-Uint8Array bytes flagged ARTIFACT_INVALID', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].bytes = [1, 2, 3];
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_INVALID));
});

test('artifacts: extra own key flagged ARTIFACT_INVALID', () => {
  const r = evalFull((obs) => {
    obs.artifacts[0].extra = 1;
  });
  assert.ok(hasViolation(r, VIOLATION.ARTIFACT_INVALID));
});

// ---------------------------------------------------------------------------
// Receipt chain: prefixes
// ---------------------------------------------------------------------------

// Build a valid prefix-n observation whose artifacts are sliced to exactly the
// cumulative manifest Mn (M1..M4 for n=1..4; empty for n=0). The receipts'
// manifests already reference only those cumulative ids, so slicing the
// artifacts to the same set keeps the chain clean.
function prefixObs(n, state = makeState()) {
  const obs = observationPrefix(n, state);
  const ids = new Set(CUMULATIVE_EXPECTED[n]);
  obs.artifacts = makeArtifacts().filter((a) => ids.has(a.id));
  return obs;
}

test('receipts: valid prefixes 1..4 give matching prefix and null candidate (sliced artifacts)', () => {
  for (let n = 1; n <= 4; n += 1) {
    const state = makeState();
    const obs = prefixObs(n, state);
    const r = evaluateStageGate(state, obs, new Set());
    assert.strictEqual(r.violations.length, 0, `prefix ${n} clean`);
    assert.strictEqual(r.prefix, n);
    assert.strictEqual(r.terminalCandidate, null, `prefix ${n} no candidate`);
  }
});

test('artifacts: prefix 0 requires empty artifacts', () => {
  const state = makeState();
  const empty = prefixObs(0, state);
  const r0 = evaluateStageGate(state, empty, new Set());
  assert.strictEqual(r0.violations.length, 0, 'prefix 0 clean with empty artifacts');
  assert.strictEqual(r0.prefix, 0);
  assert.strictEqual(r0.terminalCandidate, null, 'prefix 0 no candidate');

  const withArtifacts = cloneObservation(prefixObs(0, state));
  withArtifacts.artifacts = makeArtifacts();
  const r1 = evaluateStageGate(state, withArtifacts, new Set());
  assert.ok(hasViolation(r1, VIOLATION.ARTIFACT_EXTRA), 'prefix 0 must reject any artifact');
  assert.strictEqual(r1.terminalCandidate, null, 'prefix 0 with artifacts no candidate');
});

test('artifacts: each prefix rejects missing, extra, and duplicate artifacts', () => {
  for (let n = 0; n <= 4; n += 1) {
    const unexpected = ARTIFACT_IDS.find((id) => !CUMULATIVE_EXPECTED[n].includes(id));

    if (n > 0) {
      const missing = prefixObs(n);
      missing.artifacts = missing.artifacts.slice(1);
      const r = evaluateStageGate(makeState(), missing, new Set());
      assert.ok(
        hasViolation(r, VIOLATION.ARTIFACT_MISSING) ||
          hasViolation(r, VIOLATION.RECEIPT_MANIFEST_MISMATCH),
        `prefix ${n} missing flagged`,
      );
      assert.strictEqual(r.terminalCandidate, null, `prefix ${n} missing no candidate`);
    }

    if (unexpected) {
      const extra = prefixObs(n);
      extra.artifacts = [...extra.artifacts, makeArtifacts().find((a) => a.id === unexpected)];
      const r = evaluateStageGate(makeState(), extra, new Set());
      assert.ok(hasViolation(r, VIOLATION.ARTIFACT_EXTRA), `prefix ${n} extra flagged`);
      assert.strictEqual(r.terminalCandidate, null, `prefix ${n} extra no candidate`);
    }

    if (n > 0) {
      const dup = prefixObs(n);
      dup.artifacts = [
        ...dup.artifacts,
        { ...dup.artifacts[0], bytes: dup.artifacts[0].bytes.slice() },
      ];
      const r = evaluateStageGate(makeState(), dup, new Set());
      assert.ok(hasViolation(r, VIOLATION.ARTIFACT_DUPLICATE), `prefix ${n} duplicate flagged`);
      assert.strictEqual(r.terminalCandidate, null, `prefix ${n} duplicate no candidate`);
    }
  }
});

test('receipts: RECEIPT_SPEC stage order matches contract', () => {
  assert.deepStrictEqual(
    RECEIPT_SPEC.map((s) => s.stage),
    ['expert_design', 'adversarial_review', 'main_integration', 'operator_approval', 'planning_contract'],
  );
});

// ---------------------------------------------------------------------------
// Receipt chain: tamper detection
// ---------------------------------------------------------------------------

test('tamper: previousDigest flagged', () => {
  const r = evalFull((obs) => {
    obs.receipts[1].previousDigest = GOLDEN.receipts[2];
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_PREVIOUS_MISMATCH));
  assert.strictEqual(r.terminalCandidate, null);
});

test('tamper: requestDigest flagged', () => {
  const r = evalFull((obs) => {
    obs.receipts[0].requestDigest = GOLDEN.scope;
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_REQUEST_MISMATCH));
});

test('tamper: scopeDigest flagged', () => {
  const r = evalFull((obs) => {
    obs.receipts[0].scopeDigest = GOLDEN.request;
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_SCOPE_MISMATCH));
});

test('tamper: manifest flagged', () => {
  const r = evalFull((obs) => {
    obs.receipts[0].manifest = [{ id: 'R01', digest: GOLDEN.artifacts.R01 }];
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_MANIFEST_MISMATCH));
});

test('tamper: digest flagged RECEIPT_DIGEST_MISMATCH', () => {
  const r = evalFull((obs) => {
    obs.receipts[0].digest = 'f'.repeat(64);
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_DIGEST_MISMATCH));
});

test('tamper: stage flagged RECEIPT_STAGE_MISMATCH', () => {
  const r = evalFull((obs) => {
    obs.receipts[0].stage = 'planning_contract';
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_STAGE_MISMATCH));
});

test('tamper: receipt with extra key flagged RECEIPT_INVALID', () => {
  const r = evalFull((obs) => {
    obs.receipts[0].extra = 1;
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_INVALID));
});

test('tamper: extra receipt beyond chain flagged', () => {
  const r = evalFull((obs) => {
    obs.receipts.push({ ...obs.receipts[4] });
  });
  assert.ok(
    hasViolation(r, VIOLATION.RECEIPT_STAGE_MISMATCH) || hasViolation(r, VIOLATION.RECEIPT_DUPLICATE),
  );
  assert.strictEqual(r.terminalCandidate, null);
});

test('tamper: duplicate receipt digest flagged RECEIPT_DUPLICATE', () => {
  const r = evalFull((obs) => {
    obs.receipts[1].digest = obs.receipts[0].digest;
  });
  assert.ok(hasViolation(r, VIOLATION.RECEIPT_DUPLICATE));
});

// ---------------------------------------------------------------------------
// Replay + no mutation
// ---------------------------------------------------------------------------

test('replay: consumed final digest flagged REPLAY', () => {
  const state = makeState();
  const obs = makeObservation(state);
  const set = new Set([GOLDEN.receipts[4]]);
  const r = evaluateStageGate(state, obs, set);
  assert.ok(hasViolation(r, VIOLATION.REPLAY));
  assert.strictEqual(r.terminalCandidate, null);
});

test('replay: evaluate never mutates the passed Set (snapshot)', () => {
  const state = makeState();
  const obs = makeObservation(state);
  const set = new Set(['seed']);
  const before = [...set];
  const r = evaluateStageGate(state, obs, set);
  assert.ok(r.terminalCandidate);
  assert.deepStrictEqual([...set], before);
  assert.strictEqual(set.size, 1);
});

test('replay: replaySet must be a native Set', () => {
  const state = makeState();
  const obs = makeObservation(state);
  assert.throws(() => evaluateStageGate(state, obs, {}), TypeError);
  assert.throws(() => evaluateStageGate(state, obs, [GOLDEN.receipts[4]]), TypeError);
});

test('replay: replaySet rejects Set subclass (non-native Set)', () => {
  class FakeSet extends Set {}
  const state = makeState();
  const obs = makeObservation(state);
  assert.throws(() => evaluateStageGate(state, obs, new FakeSet([GOLDEN.receipts[4]])), TypeError);
});

test('replay: replaySet rejects spoof set-like object', () => {
  const fake = { has: () => false, size: 0 };
  const state = makeState();
  const obs = makeObservation(state);
  assert.throws(() => evaluateStageGate(state, obs, fake), TypeError);
});

test('replay: native Set with poisoned Symbol.iterator (empty generator) still detects REPLAY', () => {
  const state = makeState();
  const obs = makeObservation(state);
  const set = new Set([GOLDEN.receipts[4]]);
  // Replace the set's own iterator with an empty generator so a naive
  // `new Set(replaySet)` snapshot would be EMPTY and miss the consumed digest.
  Object.defineProperty(set, Symbol.iterator, {
    value: function* () {},
    configurable: true,
    enumerable: false,
  });
  const r = evaluateStageGate(state, obs, set);
  assert.ok(hasViolation(r, VIOLATION.REPLAY), 'poisoned iterator must still flag REPLAY');
  assert.strictEqual(r.terminalCandidate, null, 'no terminal candidate when REPLAY');
});

// ---------------------------------------------------------------------------
// State / observation shape
// ---------------------------------------------------------------------------

test('state: missing bytes flagged STATE_INVALID', () => {
  const r = evaluateStageGate({ requestBytes: bytes('a') }, makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
});

test('state: non-Uint8Array bytes flagged STATE_INVALID', () => {
  const r = evaluateStageGate(
    { requestBytes: [1], scopeBytes: [2] },
    makeObservation(),
    new Set(),
  );
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
});

test('observation: non-object flagged OBSERVATION_INVALID', () => {
  const r = evaluateStageGate(makeState(), { artifacts: 'x', receipts: [] }, new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
});

// ---------------------------------------------------------------------------
// State / observation shape — regression: reject malformed shapes
// ---------------------------------------------------------------------------

function nullProtoState() {
  const st = makeState();
  const s = Object.create(null);
  s.requestBytes = st.requestBytes;
  s.scopeBytes = st.scopeBytes;
  return s;
}

function nullProtoObservation() {
  const obs = makeObservation();
  const o = Object.create(null);
  o.artifacts = obs.artifacts;
  o.receipts = obs.receipts;
  return o;
}

// -- state rejects ---------------------------------------------------------

test('state: extra own key flagged STATE_INVALID', () => {
  const s = makeState();
  s.extra = bytes('x');
  const r = evaluateStageGate(s, makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('state: own symbol key flagged STATE_INVALID', () => {
  const s = makeState();
  Object.defineProperty(s, Symbol('k'), { value: 1, enumerable: true });
  const r = evaluateStageGate(s, makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('state: own non-enumerable key flagged STATE_INVALID', () => {
  const s = makeState();
  Object.defineProperty(s, 'extra', { value: 1, enumerable: false });
  const r = evaluateStageGate(s, makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('state: own accessor key flagged STATE_INVALID', () => {
  const s = makeState();
  Object.defineProperty(s, 'extra', { get: () => 1, enumerable: true, configurable: true });
  const r = evaluateStageGate(s, makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('state: required key only on prototype flagged STATE_INVALID', () => {
  const st = makeState();
  const s = Object.create({ requestBytes: st.requestBytes, scopeBytes: st.scopeBytes });
  assert.strictEqual(Reflect.ownKeys(s).length, 0);
  const r = evaluateStageGate(s, makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('state: class-instance shape flagged STATE_INVALID', () => {
  class StageState {
    constructor() {
      const st = makeState();
      this.requestBytes = st.requestBytes;
      this.scopeBytes = st.scopeBytes;
    }
  }
  const r = evaluateStageGate(new StageState(), makeObservation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.STATE_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

// -- observation rejects ---------------------------------------------------

test('observation: extra own key flagged OBSERVATION_INVALID', () => {
  const obs = makeObservation();
  obs.extra = [];
  const r = evaluateStageGate(makeState(), obs, new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('observation: own symbol key flagged OBSERVATION_INVALID', () => {
  const obs = makeObservation();
  Object.defineProperty(obs, Symbol('k'), { value: 1, enumerable: true });
  const r = evaluateStageGate(makeState(), obs, new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('observation: own non-enumerable key flagged OBSERVATION_INVALID', () => {
  const obs = makeObservation();
  Object.defineProperty(obs, 'extra', { value: 1, enumerable: false });
  const r = evaluateStageGate(makeState(), obs, new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('observation: own accessor key flagged OBSERVATION_INVALID', () => {
  const obs = makeObservation();
  Object.defineProperty(obs, 'extra', { get: () => [], enumerable: true, configurable: true });
  const r = evaluateStageGate(makeState(), obs, new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('observation: required key only on prototype flagged OBSERVATION_INVALID', () => {
  const obs = makeObservation();
  const o = Object.create({ artifacts: obs.artifacts, receipts: obs.receipts });
  assert.strictEqual(Reflect.ownKeys(o).length, 0);
  const r = evaluateStageGate(makeState(), o, new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

test('observation: class-instance shape flagged OBSERVATION_INVALID', () => {
  class Observation {
    constructor() {
      const obs = makeObservation();
      this.artifacts = obs.artifacts;
      this.receipts = obs.receipts;
    }
  }
  const r = evaluateStageGate(makeState(), new Observation(), new Set());
  assert.ok(hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.terminalCandidate, null);
});

// -- valid shapes still work -----------------------------------------------

test('state/observation: valid plain-object shapes accepted', () => {
  const r = evaluateStageGate(makeState(), makeObservation(), new Set());
  assert.ok(!hasViolation(r, VIOLATION.STATE_INVALID));
  assert.ok(!hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.violations.length, 0);
  assert.strictEqual(r.prefix, 5);
  assert.ok(r.terminalCandidate);
});

test('state/observation: valid null-prototype shapes accepted', () => {
  const r = evaluateStageGate(nullProtoState(), nullProtoObservation(), new Set());
  assert.ok(!hasViolation(r, VIOLATION.STATE_INVALID));
  assert.ok(!hasViolation(r, VIOLATION.OBSERVATION_INVALID));
  assert.strictEqual(r.violations.length, 0);
  assert.strictEqual(r.prefix, 5);
  assert.ok(r.terminalCandidate);
});

// ---------------------------------------------------------------------------
// Semantics: no authorization claim
// ---------------------------------------------------------------------------

test('semantics: result exposes only prefix/terminalCandidate/violations (no allow)', () => {
  const r = evalFull();
  assert.deepStrictEqual(Object.keys(r).sort(), ['prefix', 'terminalCandidate', 'violations']);
  assert.ok(!('allow' in r), 'result must make no authorization claim');
});

test('semantics: terminalCandidate only for full clean chain', () => {
  const partial = evaluateStageGate(makeState(), observationPrefix(3), new Set());
  assert.strictEqual(partial.terminalCandidate, null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exitCode = 1;
}
