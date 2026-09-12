import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readSchemaFile,
  writeSchemaFile,
  type ReplicatedSchema,
} from '../../src/init/ReplicatedSchema.js';

/**
 * Before local tables were detected generically (Fix 3), the queue and the
 * dead-letter store were the only two local tables the reader knew by
 * hardcoded name. Any other hand-added local table would be silently
 * reclassified as a replicated one on the next regeneration and lose its
 * `{ localOnly: true }` marker.
 */

const CWD = mkdtempSync(join(tmpdir(), 'offline-sync-schema-'));
const PATH = 'schema.ts';

afterEach(() => {
  rmSync(CWD, { recursive: true, force: true });
});

const simpleSchema: ReplicatedSchema = {
  source: 'https://engine.test',
  tables: [
    {
      name: 'tag_entity',
      buckets: ['tenant_reference'],
      columns: [
        { name: 'id', type: 'text' },
        { name: 'name', type: 'text' },
        { name: 'tenant_id', type: 'text' },
      ],
    },
  ],
};

describe('writeSchemaFile -- the two local tables, always present', () => {
  it('generates _file_attente AND offline_sync_dead_letters, even with no replicated table at all', () => {
    // Proving they don't depend on what the engine returns: with zero
    // replicated tables, both locals must still be there.
    writeSchemaFile({ ...simpleSchema, tables: [] }, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const text = readFileSync(join(CWD, PATH), 'utf8');
    expect(text).toContain('_file_attente: new Table(');
    expect(text).toContain('offline_sync_dead_letters: new Table(');
  });

  it('produces the right content for the dead-letter store: 5 columns, localOnly, no trackMetadata', () => {
    writeSchemaFile(simpleSchema, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const text = readFileSync(join(CWD, PATH), 'utf8');

    expect(text).toContain('offline_sync_dead_letters: new Table(');
    expect(text).toContain('operation_id: column.text,');
    expect(text).toContain('payload: column.text,');
    expect(text).toContain('code: column.integer,');
    expect(text).toContain('reason: column.text,');
    expect(text).toContain('created_at: column.integer,');

    // The dead-letter store is local, like the queue: never trackMetadata on
    // either, which is what distinguishes them from replicated tables.
    const block = text.slice(text.indexOf('offline_sync_dead_letters'));
    expect(block).toContain('{ localOnly: true }');
    expect(block.slice(0, block.indexOf('),'))).not.toContain('trackMetadata');
  });

  it('also produces _file_attente, with its 4 columns and localOnly', () => {
    writeSchemaFile(simpleSchema, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const text = readFileSync(join(CWD, PATH), 'utf8');

    const block = text.slice(
      text.indexOf('_file_attente'),
      text.indexOf('offline_sync_dead_letters'),
    );
    expect(block).toContain('method: column.text,');
    expect(block).toContain('path: column.text,');
    expect(block).toContain('body: column.text,');
    expect(block).toContain('created_at: column.text,');
    expect(block).toContain('{ localOnly: true }');
  });

  it('ranks the dead-letter store AFTER the queue, in that order, every time', () => {
    // A fixed order keeps the file stable across generations: two runs on
    // the same schema must not move anything other than what actually changed.
    writeSchemaFile(simpleSchema, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const text = readFileSync(join(CWD, PATH), 'utf8');
    expect(text.indexOf('_file_attente')).toBeLessThan(
      text.indexOf('offline_sync_dead_letters'),
    );
  });

  it('re-emits a hand-added local table verbatim, under its own name (Fix 3)', () => {
    // Fix 3: local-table detection is generic (`{ localOnly: true }`), not
    // by hardcoded name, so a table a host application added by hand
    // survives any number of regenerations.
    const withHandAdded: ReplicatedSchema = {
      ...simpleSchema,
      localTables: [
        {
          name: '_session_local',
          columns: [
            { name: 'user_id', type: 'text' },
            { name: 'last_login', type: 'integer' },
          ],
        },
      ],
    };

    writeSchemaFile(withHandAdded, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const text = readFileSync(join(CWD, PATH), 'utf8');

    expect(text).toContain('_session_local: new Table(');
    const block = text.slice(text.indexOf('_session_local'));
    expect(block).toContain('user_id: column.text,');
    expect(block).toContain('last_login: column.integer,');
    expect(block.slice(0, block.indexOf('),'))).toContain('{ localOnly: true }');
  });

  it('survives a read-then-write round trip without losing the hand-added table (Fix 3)', () => {
    const withHandAdded: ReplicatedSchema = {
      ...simpleSchema,
      localTables: [
        { name: '_session_local', columns: [{ name: 'user_id', type: 'text' }] },
      ],
    };
    writeSchemaFile(withHandAdded, '2026-09-10T00:00:00.000Z', join(CWD, PATH));

    // The reader finds every localOnly table by the same generic marker, so
    // the queue and the dead-letter store come back here too; the writer is
    // what filters them out when re-emitting the "other" local tables.
    const read = readSchemaFile(CWD, PATH)!;
    expect(read.localTables).toContainEqual({
      name: '_session_local',
      columns: [{ name: 'user_id', type: 'text' }],
    });

    writeSchemaFile(read, '2026-09-11T00:00:00.000Z', join(CWD, PATH));
    const text = readFileSync(join(CWD, PATH), 'utf8');
    expect(text).toContain('_session_local: new Table(');
    expect(text).toContain('user_id: column.text,');
  });
});

describe('readSchemaFile -- the two local tables are ignored on re-read', () => {
  it('does not count them among replicated tables, and asks no path for them', () => {
    // The safety net documented in ReplicatedSchema.ts: without it, `check`
    // would demand an HTTP path for _file_attente and the dead-letter store,
    // which have none -- they are purely local tables.
    writeSchemaFile(simpleSchema, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const read = readSchemaFile(CWD, PATH);

    expect(read).toBeDefined();
    const names = read!.tables.map((t) => t.name);
    expect(names).toEqual(['tag_entity']);
    expect(names).not.toContain('_file_attente');
    expect(names).not.toContain('offline_sync_dead_letters');
  });

  it('keeps the source and columns of the real replicated table', () => {
    writeSchemaFile(simpleSchema, '2026-09-10T00:00:00.000Z', join(CWD, PATH));
    const read = readSchemaFile(CWD, PATH);

    expect(read!.source).toBe('https://engine.test');
    expect(read!.tables[0]).toEqual({
      name: 'tag_entity',
      buckets: ['tenant_reference'],
      columns: [
        { name: 'name', type: 'text' },
        { name: 'tenant_id', type: 'text' },
      ],
    });
  });

  it('returns undefined when the file does not exist', () => {
    expect(readSchemaFile(CWD, 'never-generated.ts')).toBeUndefined();
  });
});
