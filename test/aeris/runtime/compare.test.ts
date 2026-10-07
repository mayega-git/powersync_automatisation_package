import { describe, expect, it } from 'vitest';
import type { EndpointPlan, Instr } from '../../../src/aeris/ir/types.js';
import { compareResults } from '../../../src/aeris/runtime/compare.js';

/** A read whose program orders the rows it returns. */
const program: Instr[] = [
  { op: 'QUERY', out: 'rows', entity: 'Doc', mode: 'many', where: [], orderBy: [{ field: 'name', dir: 'asc' }] },
  { op: 'RETURN', status: 200, body: { k: 'var', name: 'rows' } },
];

const plan = (partialOrder?: boolean): EndpointPlan => ({
  id: 'GET /api/docs',
  method: 'GET',
  path: '/api/docs',
  handler: { symbol: 'DocController.list', file: 'DocController.java', startLine: 1, endLine: 2, excerptHash: 'sha256:x' },
  input: { params: {}, query: {} },
  output: { shape: 'list' },
  auth: { authenticated: true, context: [] },
  reads: ['Doc'],
  writes: [],
  uuidSlots: 0,
  evidence: [],
  testVectors: [],
  offlineClass: 'LOCAL_READ_SAFE',
  reasons: [],
  unresolved: [],
  freshness: { maxAgeSeconds: 3600 },
  program,
  ...(partialOrder === undefined ? {} : { partialOrder }),
} as unknown as EndpointPlan);

const body = (names: string[]) => ({ status: 200, body: names.map((name) => ({ name })) });

describe('comparing an answer that contains a list', () => {
  it('holds the backend to the sequence when its order settles every tie', () => {
    expect(compareResults(plan(), body(['a', 'b']), body(['b', 'a'])).equal).toBe(false);
  });

  it('compares as a set when the order leaves ties, since no order was promised', () => {
    expect(compareResults(plan(true), body(['a', 'b']), body(['b', 'a'])).equal).toBe(true);
  });

  it('still reports a list whose contents differ, ordered or not', () => {
    expect(compareResults(plan(true), body(['a', 'b']), body(['a', 'c'])).equal).toBe(false);
    expect(compareResults(plan(true), body(['a']), body(['a', 'b'])).equal).toBe(false);
  });
});
