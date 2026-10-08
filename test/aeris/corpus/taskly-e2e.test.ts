import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from '../../../src/aeris/compiler/build.js';
import { createGateway, type Gateway } from '../../../src/aeris/gateway/server.js';
import type { GatewayConfig } from '../../../src/aeris/gateway/config.js';
import { rawTypes } from '../../../src/aeris/gateway/data.js';
import { signArtifact } from '../../../src/aeris/ir/signing.js';
import { AerisRuntime } from '../../../src/aeris/runtime/runtime.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import { HttpTransport, TransportError } from '../../../src/aeris/runtime/transport.js';
import { CORPUS_ROOT, corpusClaims, corpusConfig, corpusHeaders, WORKSPACE } from '../../../scripts/corpus-config.js';
import { BASE_URL, DATABASE_URL, suite } from './backend.js';

/**
 * The whole machinery, end to end, against a real Spring Boot application:
 * write while offline, queue, come back, replay through the Sync Gateway,
 * remap the identifiers the device chose, converge.
 *
 * The differential proves a compiled program answers like the backend. It does
 * not run any of this: the outbox, the ordering of dependent operations, the
 * identifier remapping and the convergence had never met a real backend. The
 * second operation here is created *on the board the first one creates*, so it
 * carries an identifier that does not exist server-side until the first is
 * replayed — the part only an end-to-end run can exercise.
 */
const BOARD = 'io.taskly.api.board.Board';
const TASK = 'io.taskly.api.task.Task';

suite('taskly, offline write to convergence', () => {
  let pool: pg.Pool;
  let gateway: Gateway;
  let runtime: AerisRuntime;
  let store: MemoryStore;
  let online = true;

  const call = (method: string, path: string, body?: unknown) => runtime.handle({
    method,
    url: `${BASE_URL}${path}`,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, types: rawTypes });
    await pool.query('TRUNCATE task, board, activity_entry, idempotency_entry CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS aeris_corpus CASCADE');

    const { artifact } = await build({ rootDir: CORPUS_ROOT, config: corpusConfig(), write: false });
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
    const directory = await mkdtemp(join(tmpdir(), 'aeris-corpus-'));
    const artifactFile = join(directory, 'artifact.signed.json');
    await writeFile(artifactFile, JSON.stringify(await signArtifact(artifact, pair.privateKey, 'corpus-key')));

    const config: GatewayConfig = {
      listen: { host: '127.0.0.1', port: 0 },
      artifactFile,
      trustedKeys: { 'corpus-key': publicKey },
      backend: { url: BASE_URL, timeoutMs: 10_000, forwardHeaders: Object.keys(corpusHeaders) },
      database: { url: DATABASE_URL!, schema: 'aeris_corpus', poolSize: 4 },
      auth: {
        mode: 'trusted-headers',
        claims: { workspaceId: 'x-workspace-id', memberId: 'x-member-id' },
        acknowledgeInsecure: true,
      },
      subjectClaims: ['workspaceId', 'memberId'],
      policy: { disabled: [], freshness: {}, minArtifactVersion: 0 },
      cors: { origins: [] },
      limits: { maxBatch: 50, maxBodyBytes: 1_000_000, deltaPageSize: 100 },
      retentionDays: 30,
    };
    gateway = await createGateway(config, { pool, log: () => undefined });
    await gateway.setup();
    await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));

    const http = new HttpTransport({ gatewayUrl: `${gateway.url()}/aeris`, authHeaders: () => corpusHeaders });
    const guard = <T extends (...args: never[]) => Promise<unknown>>(fn: T): T => (async (...args: Parameters<T>) => {
      if (!online) throw new TransportError('network', 'offline');
      return fn(...args);
    }) as T;
    store = new MemoryStore();
    runtime = new AerisRuntime({
      store,
      transport: {
        artifact: guard(() => http.artifact()),
        policy: guard(() => http.policy()),
        snapshot: guard((version: string) => http.snapshot(version)),
        delta: guard((version: string, since: string) => http.delta(version, since)),
        reconcile: guard((request: Parameters<HttpTransport['reconcile']>[0]) => http.reconcile(request)),
        network: guard((request: Parameters<HttpTransport['network']>[0]) =>
          http.network({ ...request, headers: { ...request.headers, ...corpusHeaders } })),
      },
      trustedKeys: { 'corpus-key': publicKey },
      session: { context: () => corpusClaims },
      isOnline: () => online,
      apiOrigin: BASE_URL,
    });
    await runtime.start();
  }, 300_000);

  afterAll(async () => {
    runtime?.stop();
    await gateway?.close();
    await pool?.query('DROP SCHEMA IF EXISTS aeris_corpus CASCADE').catch(() => undefined);
    await pool?.end();
  });

  it('answers offline, queues the work, then converges on the server rows', async () => {
    online = false;

    const createdBoard = await call('POST', '/api/boards', { name: 'Hors ligne', colour: 'teal' });
    expect(createdBoard.status).toBe(201);
    const localBoardId = (JSON.parse(createdBoard.body!) as { id: string }).id;

    // Created on a board the server has never heard of: its identifier only
    // becomes real once the first operation is replayed.
    const createdTask = await call('POST', `/api/boards/${localBoardId}/tasks`, { title: 'Depend du tableau', position: 1 });
    expect(createdTask.status).toBe(201);
    const localTaskId = (JSON.parse(createdTask.body!) as { id: string }).id;

    // Both readable locally before any network.
    const listed = await call('GET', `/api/boards/${localBoardId}/tasks`);
    expect(listed.status).toBe(200);
    expect((JSON.parse(listed.body!) as { id: string }[]).map((task) => task.id)).toEqual([localTaskId]);
    expect((await runtime.operations()).length).toBe(2);

    online = true;
    await runtime.sync();

    // Nothing left to send, and nothing was rejected.
    expect(await runtime.operations()).toEqual([]);

    const boards = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM board WHERE workspace_id = $1', [WORKSPACE],
    );
    expect(boards.rows.map((row) => row.name)).toEqual(['Hors ligne']);
    const serverBoardId = boards.rows[0]!.id;

    const tasks = await pool.query<{ id: string; board_id: string; title: string }>('SELECT id, board_id, title FROM task');
    expect(tasks.rows.map((row) => row.title)).toEqual(['Depend du tableau']);
    // The dependent operation reached the server pointing at the *server's* board.
    expect(tasks.rows[0]!.board_id).toBe(serverBoardId);

    // The device dropped the identifiers it had invented.
    const localBoards = await store.transaction((tx) => tx.all(BOARD));
    expect(localBoards.map((row) => row.id)).toEqual([serverBoardId]);
    const localTasks = await store.transaction((tx) => tx.all(TASK));
    expect(localTasks.map((row) => row.boardId)).toEqual([serverBoardId]);
    expect(localTasks.map((row) => row.id)).toEqual([tasks.rows[0]!.id]);

    // And the endpoint answers from the converged rows.
    const after = await call('GET', `/api/boards/${serverBoardId}/tasks`);
    expect(after.status).toBe(200);
    expect((JSON.parse(after.body!) as { boardId: string }[]).map((task) => task.boardId)).toEqual([serverBoardId]);
  }, 300_000);

  it('applies a replayed batch once', async () => {
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM board');
    await runtime.sync();
    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM board');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  }, 120_000);
});
