import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AerisArtifact, Projection } from '../../../src/aeris/ir/types.js';
import { ProjectionReader, rawTypes } from '../../../src/aeris/gateway/data.js';
import { setupSql } from '../../../src/aeris/gateway/sql.js';
import { ENTITY, ORG, OTHER_ORG, artifact as baseArtifact } from '../runtime/fixtures.js';

const DATABASE_URL = process.env.AERIS_TEST_DATABASE_URL;
const suite = DATABASE_URL === undefined ? describe.skip : describe;

const LINE = 'SalesPointLine';
const lines: Projection = {
  entity: LINE,
  schema: 'parent_demo',
  table: 'sales_point_lines',
  key: 'id',
  columns: [
    { name: 'id', column: 'id', type: { type: 'uuid', nullable: false } },
    { name: 'pointId', column: 'point_id', type: { type: 'uuid', nullable: true } },
    { name: 'label', column: 'label', type: { type: 'string', nullable: true } },
  ],
  scope: [],
  public: false,
  parent: { field: 'pointId', entity: ENTITY },
};

const MINE = 'aaaaaaaa-0000-4000-8000-000000000001';
const THEIRS = 'aaaaaaaa-0000-4000-8000-000000000002';
const LINE_MINE = 'bbbbbbbb-0000-4000-8000-000000000001';
const LINE_THEIRS = 'bbbbbbbb-0000-4000-8000-000000000002';

const claims = (organizationId: string) => ({ organizationId, userId: 'u1' });

suite('projections scoped through a parent, against PostgreSQL', () => {
  let pool: pg.Pool;
  let reader: ProjectionReader;
  let artifact: AerisArtifact;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, types: rawTypes });
    const base = baseArtifact();
    // Own tables and own log schema, so this suite never collides with the other gateway suite.
    const points = { ...base.projections[0]!, schema: 'parent_demo', table: 'sales_points' };
    artifact = { ...base, projections: [points, lines] };
    await pool.query('DROP SCHEMA IF EXISTS parent_demo CASCADE; DROP SCHEMA IF EXISTS aeris_parent CASCADE;');
    await pool.query(`CREATE SCHEMA parent_demo;
      CREATE TABLE parent_demo.sales_points (id uuid PRIMARY KEY, organization_id uuid, agency_id uuid, sales_point_name text, status text, currency text, created_at timestamp, updated_at timestamp);
      CREATE TABLE parent_demo.sales_point_lines (id uuid PRIMARY KEY, point_id uuid REFERENCES parent_demo.sales_points (id), label text);`);
    await pool.query(setupSql(artifact, 'aeris_parent'));
    reader = new ProjectionReader(pool, artifact, 'aeris_parent');
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM parent_demo.sales_point_lines; DELETE FROM parent_demo.sales_points; DELETE FROM aeris_parent.change_log;');
    await pool.query(`INSERT INTO parent_demo.sales_points VALUES
      ($1, $3, NULL, 'Mine', 'ACTIVE', 'XAF', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
      ($2, $4, NULL, 'Theirs', 'ACTIVE', 'XAF', '2026-01-01 08:00:00', '2026-01-01 08:00:00')`, [MINE, THEIRS, ORG, OTHER_ORG]);
    await pool.query(`INSERT INTO parent_demo.sales_point_lines VALUES ($1, $3, 'mine'), ($2, $4, 'theirs')`, [LINE_MINE, LINE_THEIRS, MINE, THEIRS]);
  });

  it('includes in a snapshot exactly the children of the visible parents', async () => {
    const snapshot = await reader.snapshot(claims(ORG));
    expect(snapshot.entities[ENTITY]!.map((row) => row.id)).toEqual([MINE]);
    expect(snapshot.entities[LINE]!.map((row) => row.id)).toEqual([LINE_MINE]);

    const other = await reader.snapshot(claims(OTHER_ORG));
    expect(other.entities[LINE]!.map((row) => row.id)).toEqual([LINE_THEIRS]);
  });

  it('hides a child whose parent is not visible, even when the child itself changes', async () => {
    const cursor = await reader.currentCursor();
    await pool.query('UPDATE parent_demo.sales_point_lines SET label = $2 WHERE id = $1', [LINE_THEIRS, 'renamed']);
    const delta = await reader.delta(claims(ORG), cursor, 50);
    // Reported as a delete, not withheld: a device that somehow holds it drops it.
    expect(delta.changes).toEqual([{ entity: LINE, op: 'delete', key: LINE_THEIRS }]);
  });

  it('sends the existing children of a parent that enters the scope', async () => {
    const cursor = await reader.currentCursor();
    await pool.query('UPDATE parent_demo.sales_points SET organization_id = $2 WHERE id = $1', [THEIRS, ORG]);
    const delta = await reader.delta(claims(ORG), cursor, 50);
    expect(delta.changes).toContainEqual(expect.objectContaining({ entity: ENTITY, op: 'upsert', key: THEIRS }));
    // The line did not change, so only the parent's move makes it visible.
    expect(delta.changes).toContainEqual(expect.objectContaining({ entity: LINE, op: 'upsert', key: LINE_THEIRS }));
    expect(delta.changes.filter((change) => change.entity === LINE)).toHaveLength(1);
  });

  it('reports a parent leaving the scope as a delete, leaving the cascade to the device', async () => {
    const cursor = await reader.currentCursor();
    await pool.query('UPDATE parent_demo.sales_points SET organization_id = $2 WHERE id = $1', [MINE, OTHER_ORG]);
    const delta = await reader.delta(claims(ORG), cursor, 50);
    expect(delta.changes).toEqual([{ entity: ENTITY, op: 'delete', key: MINE }]);
  });

  it('lists as out of scope the children of other parents, and those with no parent', async () => {
    expect(await reader.foreignKeys(lines, claims(ORG), 10)).toEqual([LINE_THEIRS]);
    expect(await reader.foreignKeys(lines, claims(OTHER_ORG), 10)).toEqual([LINE_MINE]);

    const orphan = 'bbbbbbbb-0000-4000-8000-000000000003';
    await pool.query('INSERT INTO parent_demo.sales_point_lines VALUES ($1, NULL, $2)', [orphan, 'orphan']);
    // Invisible to everyone, so it must show up in the probe rather than slip through NOT (NULL).
    expect((await reader.snapshot(claims(ORG))).entities[LINE]!.map((row) => row.id)).toEqual([LINE_MINE]);
    expect(await reader.foreignKeys(lines, claims(ORG), 10)).toEqual([LINE_THEIRS, orphan]);
  });
});
