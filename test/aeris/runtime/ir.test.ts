import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalDigest } from '../../../src/aeris/ir/canonical.js';
import { importPublicKey, signArtifact, verifyArtifact } from '../../../src/aeris/ir/signing.js';
import { AerisValidationError, validateArtifact } from '../../../src/aeris/ir/validate.js';
import type { AerisArtifact, EndpointPlan, Projection } from '../../../src/aeris/ir/types.js';
import { artifact, keyPair } from './fixtures.js';

function withEndpoint(change: (plan: EndpointPlan) => EndpointPlan, index = 2): AerisArtifact {
  const base = artifact();
  return { ...base, endpoints: base.endpoints.map((plan, position) => (position === index ? change(plan) : plan)) };
}

describe('canonical JSON', () => {
  it('ignores key order and is stable', async () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: 2 }] })).toBe('{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
    expect(await canonicalDigest({ a: 1, b: 2 })).toBe(await canonicalDigest({ b: 2, a: 1 }));
  });

  it('refuses values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
  });
});

describe('validateArtifact', () => {
  it('accepts the reference artifact', () => {
    expect(() => validateArtifact(artifact())).not.toThrow();
  });

  it('rejects a write without an outbox intent', () => {
    const bad = withEndpoint((plan) => ({ ...plan, program: plan.program!.filter((instr) => instr.op !== 'QUEUE_INTENT') }));
    expect(() => validateArtifact(bad)).toThrow(/QUEUE_INTENT/);
  });

  it('rejects a program with a path that does not RETURN', () => {
    const bad = withEndpoint((plan) => ({ ...plan, program: plan.program!.slice(0, -1) }));
    expect(() => validateArtifact(bad)).toThrow(/RETURN/);
  });

  it('rejects variables used before definition and unknown fields', () => {
    const bad = withEndpoint((plan) => ({
      ...plan,
      program: [{ op: 'RETURN', status: 200, body: { k: 'var', name: 'ghost' } }],
    }), 0);
    expect(() => validateArtifact(bad)).toThrow(/ghost/);
    const unknownField = withEndpoint((plan) => ({
      ...plan,
      program: [
        { op: 'QUERY', out: 'x', entity: 'SalesPoint', mode: 'many', where: [{ field: 'nope', cmp: 'eq', value: { k: 'lit', v: 1 } }] },
        { op: 'RETURN', status: 200, body: null },
      ],
    }), 1);
    expect(() => validateArtifact(unknownField)).toThrow(/nope/);
  });

  it('accepts read-only TRY blocks and refuses writes or one-sided bindings in them', () => {
    const lit = (v: unknown) => ({ k: 'lit', v }) as never;
    const ok = withEndpoint((plan) => ({
      ...plan,
      program: [
        { op: 'TRY', body: [{ op: 'QUERY', out: 'rows', entity: 'SalesPoint', mode: 'many', where: [] }, { op: 'LET', out: 'n', expr: lit(1) }], fallback: [{ op: 'LET', out: 'n', expr: lit(0) }] },
        { op: 'RETURN', status: 200, body: { k: 'var', name: 'n' } },
      ],
    }), 0);
    expect(() => validateArtifact(ok)).not.toThrow();
    const oneSided = withEndpoint((plan) => ({
      ...plan,
      program: [
        { op: 'TRY', body: [{ op: 'QUERY', out: 'rows', entity: 'SalesPoint', mode: 'many', where: [] }], fallback: [] },
        { op: 'RETURN', status: 200, body: { k: 'var', name: 'rows' } },
      ],
    }), 0);
    expect(() => validateArtifact(oneSided)).toThrow(/rows/);
    const writes = withEndpoint((plan) => ({
      ...plan,
      program: [
        { op: 'TRY', body: [{ op: 'DELETE', entity: 'SalesPoint', key: lit('x') }], fallback: [] },
        { op: 'QUEUE_INTENT' },
        { op: 'RETURN', status: 204, body: null },
      ],
    }), 0);
    expect(() => validateArtifact(writes)).toThrow(/read-only/);
  });

  it('refuses local classes that still carry unresolved items, and unscoped private projections', () => {
    const unresolved = withEndpoint((plan) => ({ ...plan, unresolved: ['call x() unresolved'] }), 0);
    expect(() => validateArtifact(unresolved)).toThrow(AerisValidationError);
    const base = artifact();
    const unscoped = { ...base, projections: [{ ...base.projections[0]!, scope: [] }] };
    expect(() => validateArtifact(unscoped)).toThrow(/public/);
  });

  it('accepts a projection scoped through a parent and checks the parent it names', () => {
    const base = artifact();
    const lines: Projection = {
      entity: 'demo.Line',
      table: 'lines',
      key: 'id',
      columns: [
        { name: 'id', column: 'id', type: { type: 'uuid', nullable: false } },
        { name: 'pointId', column: 'point_id', type: { type: 'uuid', nullable: false } },
      ],
      scope: [],
      public: false,
      parent: { field: 'pointId', entity: base.projections[0]!.entity },
    };
    const withParent = (change: Partial<Projection>) => ({ ...base, projections: [...base.projections, { ...lines, ...change }] });

    expect(() => validateArtifact(withParent({}))).not.toThrow();
    expect(() => validateArtifact(withParent({ parent: { field: 'pointId', entity: 'demo.Missing' } }))).toThrow(/not a projection/);
    expect(() => validateArtifact(withParent({ parent: { field: 'nope', entity: base.projections[0]!.entity } }))).toThrow(/not a column/);
    expect(() => validateArtifact(withParent({ parent: { field: 'pointId', entity: 'demo.Line' } }))).toThrow(/cyclic/);
    expect(() => validateArtifact(withParent({ public: true }))).toThrow(/public projection cannot be scoped through a parent/);
    const publicParent = { ...base, projections: [{ ...base.projections[0]!, scope: [], public: true }, lines] };
    expect(() => validateArtifact(publicParent)).toThrow(/public data/);
  });

  it('refuses context claims the endpoint does not declare', () => {
    const bad = withEndpoint((plan) => ({ ...plan, auth: { authenticated: true, context: [] } }), 0);
    expect(() => validateArtifact(bad)).toThrow(/organizationId/);
  });
});

describe('artifact signatures', () => {
  it('round-trips and detects tampering, untrusted keys and re-ordering-insensitive digests', async () => {
    const keys = await keyPair();
    const envelope = await signArtifact(artifact(), keys.privateKey, 'test-key');
    const trusted = new Map([['test-key', await importPublicKey(keys.publicKeyBase64)]]);

    const verified = await verifyArtifact(JSON.parse(JSON.stringify(envelope)), trusted);
    expect(verified.artifactVersion).toBe(1);

    const tampered = JSON.parse(JSON.stringify(envelope));
    tampered.artifact.endpoints[0].offlineClass = 'LOCAL_WRITE_SAFE';
    await expect(verifyArtifact(tampered, trusted)).rejects.toThrow(/digest/);

    const forged = { ...envelope, digest: await canonicalDigest(tampered.artifact), artifact: tampered.artifact };
    await expect(verifyArtifact(forged, trusted)).rejects.toThrow(/Signature/);

    const other = await keyPair();
    await expect(verifyArtifact(envelope, new Map([['test-key', await importPublicKey(other.publicKeyBase64)]]))).rejects.toThrow(/Signature/);
    await expect(verifyArtifact(envelope, new Map())).rejects.toThrow(/not trusted/);
    await expect(verifyArtifact({ ...envelope, extra: 1 }, trusted)).rejects.toThrow(/unexpected/);
  });
});
