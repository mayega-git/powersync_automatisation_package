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
      'DELETE /api/boards/{boardId}': 'SPECULATIVE',
      // No Idempotency-Key filter in this backend, so a lost response could apply twice.
      'POST /api/boards': 'ONLINE_REQUIRED',
      'PATCH /api/boards/{boardId}/name': 'ONLINE_REQUIRED',
      // Calls the mail provider.
      'POST /api/boards/{boardId}/share': 'ONLINE_REQUIRED',
      // `TaskService.byId` names which of its two guards failed, so a device
      // would answer differently from the server. See parent-after-read.test.ts.
      'GET /api/boards/{boardId}/open-count': 'ONLINE_REQUIRED',
      'GET /api/boards/{boardId}/tasks': 'ONLINE_REQUIRED',
      'POST /api/boards/{boardId}/tasks': 'ONLINE_REQUIRED',
      'GET /api/tasks/{taskId}': 'ONLINE_REQUIRED',
      'POST /api/tasks/{taskId}/complete': 'ONLINE_REQUIRED',
      'DELETE /api/tasks/{taskId}': 'ONLINE_REQUIRED',
    });
  });

  it('says why in words a reader can act on', async () => {
    const { artifact } = await compile();
    const reason = (id: string) => artifact.endpoints.find((plan) => plan.id === id)!.reasons.join(' ');
    expect(reason('POST /api/boards')).toMatch(/idempotency/i);
    expect(reason('POST /api/boards/{boardId}/share')).toMatch(/external effect/i);
    expect(reason('GET /api/tasks/{taskId}')).toMatch(/restricted to one row of a scoped entity/i);
  });
});
