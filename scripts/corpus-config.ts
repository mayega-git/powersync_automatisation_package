/**
 * What `aeris init` proposes for the taskly corpora, with the choices only a
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

export const JPA_ROOT = 'test-backends/taskly-jpa';

/**
 * The MVC/JPA corpus. The session is a ThreadLocal a servlet filter fills, and
 * it also exposes the two claims one at a time -- the shape a backend with no
 * session record has, which is what `aeris init` detects there.
 */
export const jpaConfig = () => mergeConfig({
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
});

/** The two stacks, so a check can run against either without knowing their details. */
export const CORPORA = {
  reactive: {
    root: CORPUS_ROOT,
    config: corpusConfig,
    baseUrl: process.env.TASKLY_BASE_URL ?? 'http://127.0.0.1:18090',
    databaseUrl: process.env.TASKLY_DATABASE_URL ?? 'postgres://taskly:taskly@127.0.0.1:15434/taskly',
  },
  jpa: {
    root: JPA_ROOT,
    config: jpaConfig,
    baseUrl: process.env.TASKLY_JPA_BASE_URL ?? 'http://127.0.0.1:18091',
    databaseUrl: process.env.TASKLY_JPA_DATABASE_URL ?? 'postgres://taskly:taskly@127.0.0.1:15435/taskly_jpa',
  },
} as const;
