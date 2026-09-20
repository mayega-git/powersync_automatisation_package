import { describe, expect, it } from 'vitest';

import {
  SqlBuilder,
  SqlBuildError,
  toCamelCase,
  toSnakeCase,
  type TableColumns,
} from '../src/core/SqlBuilder.js';
import { SqlTranslator } from '../src/core/SqlTranslator.js';

/** yownews's real schema, as "offline-sync schema" generates it. */
const SCHEMA: TableColumns = {
  tag_entity: [
    'name',
    'description',
    'category_id',
    'tenant_id',
    'created_at',
    'updated_at',
    '_metadata',
  ],
  category_entity: [
    'name',
    'description',
    'domain',
    'tenant_id',
    'created_at',
    'updated_at',
    '_metadata',
  ],
};

const b = new SqlBuilder(SCHEMA);
const NOW = '2026-09-05T10:00:00.000Z';
const options = { now: NOW, newId: () => 'new-id' };

describe('the two naming directions', () => {
  it('goes from the screen\'s camelCase to the table\'s snake_case', () => {
    expect(toSnakeCase('categoryId')).toBe('category_id');
    expect(toSnakeCase('name')).toBe('name');
  });

  it('and back', () => {
    expect(toCamelCase('category_id')).toBe('categoryId');
    expect(toCamelCase('name')).toBe('name');
  });
});

describe('SqlBuilder: reads', () => {
  it('returns the table columns, aliased for the screen', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'GET',
      pathParams: {},
    });

    expect(statement!.kind).toBe('read');
    expect(statement!.sql).toBe(
      'SELECT id, name, description, category_id AS categoryId,' +
        ' tenant_id AS tenantId, created_at AS createdAt,' +
        ' updated_at AS updatedAt FROM tag_entity' +
        ' ORDER BY name COLLATE NOCASE',
    );
  });

  it('never returns _metadata: it is plumbing, not data', () => {
    const [statement] = b.build({ table: 'tag_entity', method: 'GET', pathParams: {} });
    expect(statement!.sql).not.toContain('_metadata');
  });

  it('reads a specific row when the path carries a hole', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'GET',
      pathParams: { id: 't-1' },
    });
    expect(statement!.sql).toContain('WHERE id = :id');
    expect(statement!.params).toEqual({ id: 't-1' });
    // A single row has no order to respect.
    expect(statement!.sql).not.toContain('ORDER BY');
  });

  it('a single hole designates the row, even under another name', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'GET',
      pathParams: { categoryId: 'c-9' },
    });
    expect(statement!.sql).toContain('WHERE id = :id');
    expect(statement!.params).toEqual({ id: 'c-9' });
  });

  it('with two holes, the last designates the row and the other filters', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'GET',
      pathParams: { categoryId: 'c-9', id: 't-1' },
    });
    expect(statement!.sql).toContain('WHERE id = :id AND category_id = :category_id');
    expect(statement!.params).toEqual({ id: 't-1', category_id: 'c-9' });
  });

  it('ignores a hole that matches no column', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'GET',
      pathParams: { locale: 'en', id: 't-1' },
    });
    expect(statement!.sql).toContain('WHERE id = :id');
    expect(statement!.sql).not.toContain('locale');
  });

  it('orders by date when the table has no name column', () => {
    const noName = new SqlBuilder({ note: ['content', 'created_at'] });
    const [statement] = noName.build({ table: 'note', method: 'GET', pathParams: {} });
    expect(statement!.sql).toContain('ORDER BY created_at DESC');
  });
});

describe('SqlBuilder: a hole mapped to a filter column, not the row id', () => {
  const configSchema: TableColumns = {
    configuration_item: ['item_type', 'payload', 'tenant_id', 'created_at', 'updated_at'],
  };
  const c = new SqlBuilder(configSchema);

  it('filters the mapped column instead of reading it as id', () => {
    const [statement] = c.build({
      table: 'configuration_item',
      method: 'GET',
      pathParams: { type: 'product-profile' },
      paramColumns: { type: 'item_type' },
    });
    expect(statement!.sql).toContain('WHERE item_type = :item_type');
    expect(statement!.sql).not.toContain('id = :id');
    expect(statement!.params).toEqual({ item_type: 'product-profile' });
  });

  it('an unmapped single hole still designates the row (no regression)', () => {
    const [statement] = c.build({
      table: 'configuration_item',
      method: 'GET',
      pathParams: { id: 'row-1' },
    });
    expect(statement!.sql).toContain('WHERE id = :id');
  });

  it('with a mapped hole and an id hole together, both filter correctly', () => {
    const [statement] = c.build({
      table: 'configuration_item',
      method: 'GET',
      pathParams: { type: 'product-profile', id: 'row-1' },
      paramColumns: { type: 'item_type' },
    });
    expect(statement!.sql).toContain('WHERE id = :id AND item_type = :item_type');
    expect(statement!.params).toEqual({ id: 'row-1', item_type: 'product-profile' });
  });

  it('an insert writes the mapped column from the path, not just filters by it', () => {
    const [statement] = c.build({
      table: 'configuration_item',
      method: 'POST',
      pathParams: { type: 'product-profile' },
      paramColumns: { type: 'item_type' },
      body: { payload: '{}' },
      ...options,
    });
    expect(statement!.sql).toContain('item_type');
    expect(statement!.params['item_type']).toBe('product-profile');
  });
});

describe('SqlBuilder: inserts', () => {
  it('writes the body columns, after conversion to snake_case', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra', description: null, categoryId: 'c-9' },
      metadata: 'req-7',
      tenantId: 'ten-1',
      ...options,
    });

    expect(statement!.kind).toBe('insert');
    expect(statement!.sql).toBe(
      'INSERT INTO tag_entity (id, name, description, category_id,' +
        ' tenant_id, created_at, updated_at, _metadata)' +
        ' VALUES (:id, :name, :description, :category_id,' +
        ' :tenant_id, :created_at, :updated_at, :_metadata)' +
        ' RETURNING *',
    );
    expect(statement!.params).toEqual({
      id: 'new-id',
      name: 'Algebra',
      description: null,
      category_id: 'c-9',
      tenant_id: 'ten-1',
      created_at: NOW,
      updated_at: NOW,
      _metadata: 'req-7',
    });
  });

  it('silently ignores a field that is not a column', () => {
    // Screens send display fields. Failing on this would make the module
    // unusable against existing code.
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra', buttonColor: 'red' },
      ...options,
    });
    expect(statement!.sql).not.toContain('Color');
  });

  it('sets tenant to null as long as nothing has synced down', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra' },
      ...options,
    });
    expect(statement!.params['tenant_id']).toBeNull();
  });

  it('keeps the id proposed by the body rather than making one up', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { id: 'forced-id', name: 'Algebra' },
      ...options,
    });
    expect(statement!.params['id']).toBe('forced-id');
  });

  it('attaches the created row to the path hole', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: { categoryId: 'c-9' },
      body: { name: 'Algebra' },
      ...options,
    });
    expect(statement!.params['category_id']).toBe('c-9');
  });

  it('does not write _metadata when the module supplies none', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra' },
      ...options,
    });
    expect(statement!.sql).not.toContain('_metadata');
  });

  it('writes a declared default for a column the body never carries', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra' },
      columnDefaults: { category_id: 'math' },
      ...options,
    });
    expect(statement!.sql).toContain('category_id');
    expect(statement!.params['category_id']).toBe('math');
  });

  it('lets a body value for the same column win over the default', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra', categoryId: 'from-body' },
      columnDefaults: { category_id: 'from-default' },
      ...options,
    });
    expect(statement!.params['category_id']).toBe('from-body');
  });

  it('ignores a default naming a column the table does not have', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra' },
      columnDefaults: { not_a_real_column: 'x' },
      ...options,
    });
    expect(statement!.sql).not.toContain('not_a_real_column');
  });
});

describe('SqlBuilder: updates', () => {
  it('writes the sent columns, the timestamp, and the metadata', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'PUT',
      pathParams: { id: 't-1' },
      body: { name: 'Linear algebra', categoryId: 'c-9' },
      metadata: 'req-8',
      ...options,
    });

    expect(statement!.kind).toBe('update');
    expect(statement!.sql).toBe(
      'UPDATE tag_entity SET name = :name, category_id = :category_id,' +
        ' updated_at = :updated_at, _metadata = :_metadata' +
        ' WHERE id = :id RETURNING *',
    );
    expect(statement!.params).toEqual({
      name: 'Linear algebra',
      category_id: 'c-9',
      updated_at: NOW,
      _metadata: 'req-8',
      id: 't-1',
    });
  });

  it('touches neither the tenant nor the creation date', () => {
    // The row already exists and carries them; rewriting them from the
    // browser could only corrupt them.
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'PUT',
      pathParams: { id: 't-1' },
      body: { name: 'X', tenantId: 'attacker', createdAt: '1970-01-01' },
      ...options,
    });
    expect(statement!.sql).not.toContain('tenant_id');
    expect(statement!.sql).not.toContain('created_at');
  });

  it('treats PATCH like PUT', () => {
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'PATCH',
      pathParams: { id: 't-1' },
      body: { name: 'X' },
      ...options,
    });
    expect(statement!.kind).toBe('update');
  });

  it('refuses an update with no hole in the path', () => {
    expect(() =>
      b.build({
        table: 'tag_entity',
        method: 'PUT',
        pathParams: {},
        body: { name: 'X' },
      }),
    ).toThrow(SqlBuildError);
  });

  it('refuses an update that would write no column', () => {
    // A table with neither updated_at nor _metadata: only the body is left,
    // and it contributes nothing. An empty UPDATE would be invalid SQL.
    const bare = new SqlBuilder({ note: ['content'] });
    expect(() =>
      bare.build({
        table: 'note',
        method: 'PUT',
        pathParams: { id: 'n-1' },
        body: { unknownField: 1 },
      }),
    ).toThrow(/no column/);
  });
});

describe('SqlBuilder: deletes', () => {
  it('marks the metadata with an update, then deletes', () => {
    const statements = b.build({
      table: 'tag_entity',
      method: 'DELETE',
      pathParams: { id: 't-1' },
      metadata: 'req-9',
    });

    expect(statements.map((p) => p.kind)).toEqual(['mark', 'delete']);
    expect(statements[0]!.sql).toBe(
      'UPDATE tag_entity SET _metadata = :_metadata WHERE id = :id',
    );
    expect(statements[1]!.sql).toBe(
      'DELETE FROM tag_entity WHERE id = :id RETURNING *',
    );
  });

  it('sticks to the delete when there is nothing to mark', () => {
    const statements = b.build({
      table: 'tag_entity',
      method: 'DELETE',
      pathParams: { id: 't-1' },
    });
    expect(statements.map((p) => p.kind)).toEqual(['delete']);
  });

  it('refuses a delete with no hole in the path', () => {
    expect(() =>
      b.build({ table: 'tag_entity', method: 'DELETE', pathParams: {} }),
    ).toThrow(SqlBuildError);
  });
});

describe('SqlBuilder: composition refusals', () => {
  it('refuses a table missing from the engine schema', () => {
    expect(() =>
      b.build({ table: 'tag_entiti', method: 'GET', pathParams: {} }),
    ).toThrow(/missing from the engine schema/);
  });

  it('refuses a method with no SQL equivalent', () => {
    expect(() =>
      b.build({ table: 'tag_entity', method: 'OPTIONS', pathParams: {} }),
    ).toThrow(/no SQL equivalent/);
  });
});

describe('SqlBuilder and SqlTranslator', () => {
  it('produces SQL the translator accepts as-is', () => {
    // The only pipeline that matters: what SqlBuilder composes must reach
    // the database in positional form, untouched.
    const [statement] = b.build({
      table: 'tag_entity',
      method: 'POST',
      pathParams: {},
      body: { name: 'Algebra', categoryId: 'c-9' },
      metadata: 'req-7',
      tenantId: 'ten-1',
      ...options,
    });

    const translated = SqlTranslator.toPositional(statement!.sql, statement!.params);
    expect(translated.sql).not.toContain(':');
    expect(translated.params).toEqual([
      'new-id',
      'Algebra',
      'c-9',
      'ten-1',
      NOW,
      NOW,
      'req-7',
    ]);
  });
});
