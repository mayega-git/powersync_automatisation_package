import { describe, expect, it } from 'vitest';
import { build } from '../../../src/aeris/compiler/build.js';
import { mergeConfig } from '../../../src/aeris/compiler/config.js';
import { detectConfig } from '../../../src/aeris/compiler/init.js';
import { collectSources } from '../../../src/aeris/compiler/project.js';

/**
 * The second validation corpus, compiled on every run.
 *
 * It exists because validating against a single backend cannot reveal what was
 * unknowingly fitted to it: the architecture can be clean, the code free of any
 * name from the original backend, and a heuristic still tuned to its
 * vocabulary. That happened, three times, and this is what turns the next one
 * into a failing test instead of a discovery months later.
 *
 * When it fails, the compiler is what gets fixed — never the corpus.
 */
const ROOT = 'test-backends/taskly';

/** What `aeris init` proposes, once a reader has enabled what only they can know. */
const REVIEWED = {
  context: {
    sources: [
      { method: 'SessionScope.current', kind: 'required', type: 'io.taskly.api.session.CurrentUser' },
      { method: 'SessionScope.currentOrNone', kind: 'optional', type: 'io.taskly.api.session.CurrentUser' },
      { method: 'SessionScope.callInfo', kind: 'metadata', type: 'io.taskly.api.session.CallInfo' },
    ],
  },
  scopeClaims: { workspaceId: ['workspaceId'], memberId: ['memberId'] },
  idempotency: { header: 'Idempotency-Key', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], paths: ['/api/**'] },
  inertEffects: ['ActivityLog.record'],
  publicEntities: ['io.taskly.api.label.Label'],
};

const compile = async () => build({ rootDir: ROOT, config: mergeConfig(REVIEWED), write: false });

describe('the taskly corpus, as `aeris init` proposes it', () => {
  it('finds the session, the request metadata and the active profile on its own', async () => {
    const { yaml } = await detectConfig(ROOT, await collectSources(ROOT));
    expect(yaml).toContain('method: SessionScope.current\n      kind: required');
    expect(yaml).toContain('method: SessionScope.callInfo\n      kind: metadata');
    // Read off the session record, not from a vocabulary decided in advance.
    expect(yaml).toContain('workspaceId:');
    expect(yaml).not.toContain('tenantId:');
    // Single-module layout: the profile still has to be found.
    expect(yaml).toContain('- r2dbc');
    expect(yaml).toContain('#   - ActivityLog.record');
    // The Idempotency-Key filter is detected, so creations can be replayed.
    expect(yaml).toContain('header: Idempotency-Key');
  });
});

describe('the taskly corpus, compiled', () => {
  it('leaves nothing unmodelled: every endpoint is classified on its semantics', async () => {
    const { artifact } = await compile();
    const unsupported = artifact.endpoints.filter((plan) => plan.offlineClass === 'UNSUPPORTED');
    expect(unsupported.map((plan) => `${plan.id}: ${plan.reasons[0]}`)).toEqual([]);
  });

  it('projects the board by its claim and the labels as shared data', async () => {
    const { artifact } = await compile();
    const byEntity = new Map(artifact.projections.map((projection) => [projection.entity.split('.').at(-1), projection]));
    expect(byEntity.get('Board')!.scope).toEqual([{ field: 'workspaceId', cmp: 'eq', value: { k: 'ctx', name: 'workspaceId' } }]);
    expect(byEntity.get('Label')!.public).toBe(true);
    expect(byEntity.get('Task')!.parent).toEqual({ field: 'boardId', entity: 'io.taskly.api.board.Board' });
  });

  it('classifies each endpoint exactly as recorded here', async () => {
    const { artifact } = await compile();
    const byId = Object.fromEntries(artifact.endpoints.map((plan) => [plan.id, plan.offlineClass]));
    expect(byId).toEqual({
      'GET /api/boards': 'LOCAL_READ_SAFE',
      'GET /api/boards/{boardId}': 'LOCAL_READ_SAFE',
      'GET /api/boards/count': 'LOCAL_READ_SAFE',
      'GET /api/labels': 'LOCAL_READ_SAFE',
      'GET /api/me': 'LOCAL_READ_SAFE',
      // The backend applies a replayed Idempotency-Key once, so a creation can
      // be retried; these three are what the differential exercises end to end.
      'POST /api/boards': 'REPLAYABLE',
      'PATCH /api/boards/{boardId}/name': 'SPECULATIVE',
      'DELETE /api/boards/{boardId}': 'SPECULATIVE',
      // Calls the mail provider.
      'POST /api/boards/{boardId}/share': 'ONLINE_REQUIRED',
      // A task is read by its own key and its board decides who may see it. Both
      // ways of failing answer the same thing, so the proof holds and the whole
      // entity is scoped through its parent.
      'GET /api/boards/{boardId}/open-count': 'LOCAL_READ_SAFE',
      'GET /api/boards/{boardId}/tasks': 'LOCAL_READ_SAFE',
      'GET /api/tasks/{taskId}': 'LOCAL_READ_SAFE',
      'POST /api/boards/{boardId}/tasks': 'SPECULATIVE',
      'POST /api/tasks/{taskId}/complete': 'SPECULATIVE',
      'DELETE /api/tasks/{taskId}': 'SPECULATIVE',
    });
  });

  it('says why in words a reader can act on', async () => {
    const { artifact } = await compile();
    const reason = (id: string) => artifact.endpoints.find((plan) => plan.id === id)!.reasons.join(' ');
    expect(reason('POST /api/boards/{boardId}/share')).toMatch(/external effect/i);
  });
});
