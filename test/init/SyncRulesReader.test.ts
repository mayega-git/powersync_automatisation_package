import { describe, expect, it } from 'vitest';

import { readBuckets, readQuery, readStructure } from '../../src/init/SyncRulesReader.js';

describe('readQuery', () => {
  it('qualifies an unqualified table as "public.<table>"', () => {
    const cited = readQuery('SELECT * FROM tag_entity WHERE tenant_id = bucket.tenant_id');
    expect(cited?.source).toBe('public.tag_entity');
    expect(cited?.local).toBe('tag_entity');
  });

  it('keeps the schema when the query names one', () => {
    const cited = readQuery(
      'SELECT * FROM material_stock.stock_balance WHERE tenant_id = bucket.tenant_id',
    );
    expect(cited?.source).toBe('material_stock.stock_balance');
    expect(cited?.local).toBe('stock_balance');
  });

  it('a different schema, same bare table name, is a different source', () => {
    const a = readQuery('SELECT * FROM stock.stock_balance WHERE tenant_id = bucket.tenant_id');
    const b = readQuery('SELECT * FROM material_stock.stock_balance WHERE tenant_id = bucket.tenant_id');
    expect(a?.source).not.toBe(b?.source);
    // But device-side, both still want the same bare name -- disambiguation
    // happens downstream in AdminSchemaSource, not here.
    expect(a?.local).toBe(b?.local);
  });

  it('an alias becomes the local name, never the source', () => {
    const cited = readQuery('SELECT * FROM material_stock.stock_balance AS sb WHERE 1=1');
    expect(cited?.source).toBe('material_stock.stock_balance');
    expect(cited?.local).toBe('sb');
  });
});

describe('readStructure', () => {
  const connections = [
    {
      schemas: [
        {
          name: 'stock',
          tables: [{ name: 'stock_balance', columns: [{ name: 'on_hand_quantity', sqlite_type: 8 }] }],
        },
        {
          name: 'material_stock',
          tables: [{ name: 'stock_balance', columns: [{ name: 'reserved_quantity', sqlite_type: 8 }] }],
        },
      ],
    },
  ];

  it('keys by qualified "schema.table", never the bare name alone', () => {
    const structure = readStructure(connections);
    expect(structure.get('stock.stock_balance')).toEqual([{ name: 'on_hand_quantity', type: 'real' }]);
    expect(structure.get('material_stock.stock_balance')).toEqual([
      { name: 'reserved_quantity', type: 'real' },
    ]);
  });

  it('the two same-named tables from different schemas do not overwrite each other', () => {
    const structure = readStructure(connections);
    expect(structure.size).toBe(2);
  });

  it('a schema with no explicit name falls back to "public"', () => {
    const structure = readStructure([
      { schemas: [{ tables: [{ name: 'tag_entity', columns: [{ name: 'name', sqlite_type: 2 }] }] }] },
    ]);
    expect(structure.get('public.tag_entity')).toEqual([{ name: 'name', type: 'text' }]);
  });
});

describe('readBuckets', () => {
  it('reads the qualified source for every cited table', () => {
    const yaml = `
bucket_definitions:
  material_stock_organisation:
    data:
      - SELECT * FROM material_stock.stock_balance WHERE tenant_id = bucket.tenant_id
`;
    const buckets = readBuckets(yaml);
    expect(buckets).toEqual([
      {
        name: 'material_stock_organisation',
        tables: [{ source: 'material_stock.stock_balance', local: 'stock_balance' }],
      },
    ]);
  });
});
