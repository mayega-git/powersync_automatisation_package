import { describe, expect, it } from 'vitest';
import { build } from '../../../src/aeris/compiler/build.js';
import { mergeConfig } from '../../../src/aeris/compiler/config.js';
import { detectConfig } from '../../../src/aeris/compiler/init.js';
import { collectSources } from '../../../src/aeris/compiler/project.js';

/**
 * The third validation corpus: the *same API* as `test-backends/taskly`, on the
 * other Spring stack -- MVC handlers, JPA repositories, a session carried by a
 * ThreadLocal a servlet filter fills.
 *
 * Its whole point is the comparison. Both corpora answer the same JSON over the
 * same schema, so every endpoint must land in the same class on both. When they
 * disagree, the compiler was proving something about the framework rather than
 * about the program -- and the compiler is what gets fixed, never the corpus.
 */
const ROOT = 'test-backends/taskly-jpa';

/** What `aeris init` proposes, once a reader has enabled what only they can know. */
const REVIEWED = {
  activeProfiles: ['jpa'],
  context: {
    sources: [
      { method: 'SessionScope.current', kind: 'required', type: 'io.taskly.jpa.session.CurrentUser' },
      { method: 'SessionScope.currentOrNone', kind: 'optional', type: 'io.taskly.jpa.session.CurrentUser' },
      { method: 'SessionScope.currentWorkspaceId', kind: 'claim', claim: 'workspaceId' },
      { method: 'SessionScope.currentMemberId', kind: 'claim', claim: 'memberId' },
      { method: 'SessionScope.callInfo', kind: 'metadata', type: 'io.taskly.jpa.session.CallInfo' },
    ],
  },
  scopeClaims: { workspaceId: ['workspaceId'], memberId: ['memberId'] },
  idempotency: { header: 'Idempotency-Key', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], paths: ['/api/**'] },
  inertEffects: ['ActivityLog.record'],
  publicEntities: ['io.taskly.jpa.label.Label'],
};

const compile = async () => build({ rootDir: ROOT, config: mergeConfig(REVIEWED), write: false });

describe('the MVC/JPA corpus, as `aeris init` proposes it', () => {
  it('finds a session held in a ThreadLocal, with no publisher to recognise it by', async () => {
    const { yaml } = await detectConfig(ROOT, await collectSources(ROOT));
    expect(yaml).toContain('method: SessionScope.current\n      kind: required');
    expect(yaml).toContain('method: SessionScope.callInfo\n      kind: metadata');
    // The two single-claim accessors, each proven against the session record.
    expect(yaml).toContain('claim: workspaceId');
    expect(yaml).toContain('claim: memberId');
    expect(yaml).toContain('- jpa');
  });

  it('recognises an idempotency filter written for the servlet stack', async () => {
    const { yaml, notes } = await detectConfig(ROOT, await collectSources(ROOT));
    expect(yaml).toContain('header: Idempotency-Key');
    expect(notes.join(' ')).toMatch(/Idempotency filter detected/);
  });
});

describe('the MVC/JPA corpus, compiled', () => {
  it('leaves nothing unmodelled: every endpoint is classified on its semantics', async () => {
    const { artifact } = await compile();
    const unsupported = artifact.endpoints.filter((plan) => plan.offlineClass === 'UNSUPPORTED');
    expect(unsupported.map((plan) => `${plan.id}: ${plan.reasons[0]}`)).toEqual([]);
  });

  it('proves the same containment as the reactive corpus, through JPA mappings', async () => {
    const { artifact } = await compile();
    const byEntity = new Map(artifact.projections.map((projection) => [projection.entity.split('.').at(-1), projection]));
    expect(byEntity.get('Board')!.scope).toEqual([{ field: 'workspaceId', cmp: 'eq', value: { k: 'ctx', name: 'workspaceId' } }]);
    expect(byEntity.get('Label')!.public).toBe(true);
    expect(byEntity.get('Task')!.parent).toEqual({ field: 'boardId', entity: 'io.taskly.jpa.board.Board' });
    // @Column(name = ...) decides the column, exactly as @Table does the table.
    expect(byEntity.get('Board')!.columns.find((column) => column.name === 'workspaceId')?.column).toBe('workspace_id');
  });

  it('classifies every endpoint exactly as the reactive corpus does', async () => {
    const { artifact } = await compile();
    const byId = Object.fromEntries(artifact.endpoints.map((plan) => [plan.id, plan.offlineClass]));
    expect(byId, JSON.stringify(artifact.endpoints.map((plan) => [plan.id, plan.reasons]))).toEqual({
      'GET /api/boards': 'LOCAL_READ_SAFE',
      'GET /api/boards/{boardId}': 'LOCAL_READ_SAFE',
      'GET /api/boards/count': 'LOCAL_READ_SAFE',
      'GET /api/labels': 'LOCAL_READ_SAFE',
      'GET /api/me': 'LOCAL_READ_SAFE',
      'POST /api/boards': 'REPLAYABLE',
      'PATCH /api/boards/{boardId}/name': 'SPECULATIVE',
      'DELETE /api/boards/{boardId}': 'SPECULATIVE',
      // Calls the mail provider, through RestClient instead of WebClient.
      'POST /api/boards/{boardId}/share': 'ONLINE_REQUIRED',
      'GET /api/boards/{boardId}/open-count': 'LOCAL_READ_SAFE',
      'GET /api/boards/{boardId}/tasks': 'LOCAL_READ_SAFE',
      'GET /api/tasks/{taskId}': 'LOCAL_READ_SAFE',
      'POST /api/boards/{boardId}/tasks': 'SPECULATIVE',
      'POST /api/tasks/{taskId}/complete': 'SPECULATIVE',
      'DELETE /api/tasks/{taskId}': 'SPECULATIVE',
    });
  });

  it('sees a servlet filter as a request gate it has not analysed', async () => {
    const { artifact } = await compile();
    const filters = (artifact.diagnostics ?? []).filter((line) => line.startsWith('filter:'));
    expect(filters.join(' ')).toMatch(/SessionFilter/);
    expect(filters.join(' ')).toMatch(/IdempotencyFilter/);
  });
});
