/**
 * What `aeris init` proposes for the taskly corpus, with the choices only a
 * reader can make already applied. Shared so the differential and the
 * end-to-end test compile the same artifact: two checks disagreeing about the
 * configuration would be comparing different programs.
 */
import { mergeConfig } from '../src/aeris/compiler/config.js';

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';
export const MEMBER = '22222222-2222-4222-8222-222222222222';

export const CORPUS_ROOT = 'test-backends/taskly';

export const corpusConfig = () => mergeConfig({
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
});

/** The session the corpus checks act as, as headers and as claims. */
export const corpusHeaders = {
  'x-workspace-id': WORKSPACE,
  'x-member-id': MEMBER,
  'x-member-email': 'dev@taskly.test',
};

export const corpusClaims = { workspaceId: WORKSPACE, memberId: MEMBER, email: 'dev@taskly.test' };
