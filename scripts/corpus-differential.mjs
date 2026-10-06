#!/usr/bin/env node
/**
 * Compiles the taskly corpus, then compares every locally executable endpoint
 * against the running backend — reads and writes. This is the only check that
 * confronts a compiled program with a real Spring Boot application rather than
 * a fixture, so a difference here is the signal that matters most.
 *
 * Expects the backend on TASKLY_BASE_URL and its database on TASKLY_DATABASE_URL.
 */
import { build } from '../src/aeris/compiler/build.ts';
import { mergeConfig } from '../src/aeris/compiler/config.ts';
import { runDifferential } from '../src/aeris/compiler/differential.ts';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const backendUrl = process.env.TASKLY_BASE_URL ?? 'http://127.0.0.1:18090';
const databaseUrl = process.env.TASKLY_DATABASE_URL ?? 'postgres://taskly:taskly@127.0.0.1:15434/taskly';

/** What `aeris init` proposes for this backend, with the reader's choices made. */
const config = mergeConfig({
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

const { artifact } = await build({ rootDir: 'test-backends/taskly', config, write: false });
const summary = await runDifferential({
  artifact,
  backendUrl,
  databaseUrl,
  headers: { 'x-workspace-id': WORKSPACE, 'x-member-id': MEMBER, 'x-member-email': 'dev@taskly.test' },
  claims: { workspaceId: WORKSPACE, memberId: MEMBER, email: 'dev@taskly.test' },
  writes: true,
  log: (line) => process.stdout.write(`${line}\n`),
});

if (summary.skipped.length > 0) {
  process.stdout.write(`\nskipped: ${JSON.stringify(summary.skipped, null, 1)}\n`);
}
if (summary.mismatches > 0) {
  process.stderr.write(`\n${summary.mismatches} difference(s) between the compiled program and the backend.\n`);
  process.exit(1);
}
