/**
 * AERIS end to end against a running backend:
 *   offline reads and writes on the local projection -> reconnection -> replay through the
 *   Sync Gateway -> server ids remapped -> local data converged with canonical rows.
 *
 * Environment:
 *   AERIS_GATEWAY_CONFIG  gateway.yaml (artifactFile, trustedKeys, backend, database, auth)
 *   AERIS_PUBLIC_KEY      base64 Ed25519 public key of the artifact signer
 *   AERIS_KEY_ID          its key id
 *   AERIS_API             backend API origin (default http://127.0.0.1:18080)
 *   AERIS_HEADERS         JSON headers authenticating the session on the backend
 *   AERIS_CLAIMS          JSON session claims matching those headers
 *
 * Run: npx tsx example/aeris-real-backend-demo.ts   (use a disposable environment: it writes data)
 */
import Database from 'better-sqlite3';
import { createGateway } from '../src/aeris/gateway/server.js';
import { loadGatewayConfig } from '../src/aeris/gateway/config.js';
import { AerisRuntime } from '../src/aeris/runtime/runtime.js';
import { SqlStore } from '../src/aeris/runtime/store/SqlStore.js';
import { BetterSqliteDatabase } from '../src/aeris/runtime/store/BetterSqliteDatabase.js';
import { HttpTransport, TransportError } from '../src/aeris/runtime/transport.js';
import pg from 'pg';

const API = process.env.AERIS_API ?? 'http://127.0.0.1:18080';
const headers = JSON.parse(process.env.AERIS_HEADERS ?? '{}') as Record<string, string>;
const claims = JSON.parse(process.env.AERIS_CLAIMS ?? '{}') as Record<string, string | null>;
const ORG = String(claims.organizationId);
const config = await loadGatewayConfig(process.env.AERIS_GATEWAY_CONFIG ?? 'gateway.yaml');
const gateway = await createGateway(config, { log: (line) => console.log(line) });
await gateway.setup();
await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
console.log('gateway', gateway.url(), 'artifact v' + gateway.artifact.artifactVersion);

let online = true;
const http = new HttpTransport({ gatewayUrl: gateway.url() + '/aeris', authHeaders: () => headers });
const guard = <T extends (...a: any[]) => Promise<any>>(fn: T) => (async (...a: any[]) => { if (!online) throw new TransportError('network', 'offline'); return fn(...a); }) as T;
const store = new SqlStore(new BetterSqliteDatabase(new Database(':memory:')));
const runtime = new AerisRuntime({
  store,
  transport: { artifact: guard(() => http.artifact()), policy: guard(() => http.policy()), snapshot: guard((v: string) => http.snapshot(v)), delta: guard((v: string, s: string) => http.delta(v, s)), reconcile: guard((r: any) => http.reconcile(r)), network: guard((r: any) => http.network({ ...r, headers: { ...r.headers, ...headers } })) },
  trustedKeys: { [process.env.AERIS_KEY_ID ?? 'aeris']: process.env.AERIS_PUBLIC_KEY ?? '' },
  session: { context: () => claims },
  isOnline: () => online,
  apiOrigin: API,
});
runtime.on((event) => { if (event.type === 'operation' || event.type === 'blocked') console.log('  event', JSON.stringify(event)); });
await runtime.start();
const status = await runtime.status();
console.log('after start: cursor', status.cursor, 'artifact', status.artifactVersion);
const call = async (method: string, path: string, body?: unknown) => {
  const response = await runtime.handle({ method, url: API + path, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) });
  console.log('  ', method, path, '->', response.status, response.headers['x-aeris-state'] ?? 'network', (response.body ?? '').slice(0, 160));
  return response;
};

console.log('--- OFFLINE');
online = false;
await call('GET', '/api/sales-points/bf989d72-3736-4ab3-b400-15f81fcb1c31');
const created = await call('POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Kiosque hors ligne', currency: 'XAF' });
const localId = JSON.parse(created.body!).id;
await call('PUT', '/api/sales-points/' + localId, { salesPointName: 'Kiosque renommé hors ligne', currency: 'XAF' });
await call('GET', '/api/sales-points/' + localId);
await call('POST', '/api/payments/orders', {});
console.log('outbox', (await runtime.operations()).map((op) => op.state + ' ' + op.endpointId));

console.log('--- ONLINE, sync');
online = true;
await runtime.sync();
console.log('outbox after sync', (await runtime.operations()).map((op) => op.state + ' ' + op.endpointId));
const pool = new pg.Pool({ connectionString: config.database.url });
const rows = await pool.query("select id, sales_point_name, organization_id from billing_sales.pos_sales_points where sales_point_name like 'Kiosque%' order by created_at desc limit 3");
console.log('server rows', rows.rows);
const serverId = rows.rows[0]?.id;
await call('GET', '/api/sales-points/' + serverId);
console.log('local row with server id', JSON.stringify(await store.transaction((tx) => tx.get('yowyob.comops.api.salescore.salespoint.domain.SalesPoint', serverId))));
console.log('local row with local id', JSON.stringify(await store.transaction((tx) => tx.get('yowyob.comops.api.salescore.salespoint.domain.SalesPoint', localId))));
runtime.stop();
await pool.end();
await gateway.close();
