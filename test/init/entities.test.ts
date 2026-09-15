import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  declaredPaths,
  EntitiesError,
  loadEntities,
  writeEntitiesTemplate,
} from '../../src/init/EntitiesFile.js';
import { checkEntities } from '../../src/init/EntitiesChecker.js';
import type { ReplicatedSchema } from '../../src/init/ReplicatedSchema.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'entities-'));
}

const SCHEMA: ReplicatedSchema = {
  source: 'http://localhost:8090',
  tables: [
    { name: 'tag_entity', columns: [{ name: 'name', type: 'text' }], buckets: [] },
    {
      name: 'category_entity',
      columns: [{ name: 'name', type: 'text' }],
      buckets: [],
    },
  ],
};

describe('the declaration template', () => {
  it('sets the table names and leaves the paths to fill in', () => {
    const cwd = dir();
    const r = writeEntitiesTemplate(cwd, SCHEMA);

    expect(r.written).toBe(true);
    const text = readFileSync(r.path, 'utf8');
    expect(text).toContain('entities:');
    expect(text).toContain('tag_entity:');
    expect(text).toContain('category_entity:');
    expect(text).toContain('to fill in');
  });

  it('never replaces an existing file, and says what it is missing', () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, 'offline-sync.entities.yaml'),
      'entities:\n  tag_entity: /api/education/tags\n',
      'utf8',
    );

    const r = writeEntitiesTemplate(cwd, SCHEMA);
    expect(r.written).toBe(false);
    expect(r.missing).toEqual(['category_entity']);
  });
});

describe('reading the declaration', () => {
  function write(content: string): string {
    const cwd = dir();
    writeFileSync(join(cwd, 'offline-sync.entities.yaml'), content, 'utf8');
    return cwd;
  }

  it('reads the short form and the long form', () => {
    const cwd = write(
      'entities:\n' +
        '  tag_entity: /api/education/tags\n' +
        '  category_entity:\n' +
        '    - GET /api/education/categories\n' +
        '    - POST /api/education/categories\n',
    );
    expect(loadEntities(cwd)).toEqual({
      tag_entity: '/api/education/tags',
      category_entity: [
        'GET /api/education/categories',
        'POST /api/education/categories',
      ],
    });
  });

  it('refuses a table set by the template and never filled in', () => {
    // Without this, the table would never be intercepted and nothing would say so.
    const cwd = write('entities:\n  tag_entity:\n');
    expect(() => loadEntities(cwd)).toThrow(/with no path at all/);
  });

  it('refuses a file with no entities block', () => {
    const cwd = write('something_else: 1\n');
    expect(() => loadEntities(cwd)).toThrow(EntitiesError);
  });

  it('says where to go when the file does not exist', () => {
    expect(() => loadEntities(dir())).toThrow(/offline-sync entities/);
  });

  it('flattens the paths, regardless of their form', () => {
    expect(
      declaredPaths({
        tag_entity: '/api/education/tags',
        category_entity: ['GET /api/education/categories'],
      }),
    ).toEqual(['/api/education/tags', '/api/education/categories']);
  });
});

describe('checking the declaration', () => {
  it('accepts a declaration that holds up', () => {
    const r = checkEntities({
      declaration: { tag_entity: '/api/education/tags' },
      schema: SCHEMA,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a table that does not exist in the engine schema', () => {
    const r = checkEntities({
      declaration: { tag_entiti: '/api/education/tags' },
      schema: SCHEMA,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('is not replicated');
  });

  it('reports a prefix that swallows another table\'s path', () => {
    const r = checkEntities({
      declaration: {
        tag_entity: '/api/education',
        category_entity: ['GET /api/education/categories'],
      },
      schema: SCHEMA,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('covers'))).toBe(true);
  });

  it('says what to do when the schema is missing, instead of letting it pass', () => {
    const r = checkEntities({
      declaration: { tag_entity: '/api/education/tags' },
      schema: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('offline-sync schema');
  });
});
