import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchReplicatedSchema } from '../../src/init/AdminSchemaSource.js';

/**
 * `fetchReplicatedSchema` always tries the real `@powersync/service-sync-rules`
 * library first (`viaLibrary`) and only falls back to `viaLocalReader` if that
 * import fails. This module isn't a dependency of the test suite, so every
 * test here exercises the fallback -- the same path the live "reduced
 * accuracy" warning in the CLI names, and the one that actually ran when the
 * material_stock/stock naming collision was found.
 */

function schemaResponse(connections: unknown) {
  return { data: { connections, defaultSchema: 'public' } };
}

function diagnosticsResponse(rulesYaml: string) {
  return { data: { active_sync_rules: { content: rulesYaml } } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(schema: unknown, diagnostics: unknown): void {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.includes('/diagnostics') ? diagnostics : schema;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('fetchReplicatedSchema (fallback path): same bare table name, different Postgres schema', () => {
  const connections = [
    {
      schemas: [
        {
          name: 'stock',
          tables: [
            {
              name: 'stock_balance',
              columns: [
                { name: 'organization_id', sqlite_type: 2 },
                { name: 'agency_id', sqlite_type: 2 },
              ],
            },
          ],
        },
        {
          name: 'material_stock',
          tables: [
            {
              name: 'stock_balance',
              columns: [
                { name: 'organization_id', sqlite_type: 2 },
                { name: 'agency_id', sqlite_type: 2 },
                { name: 'reserved_quantity', sqlite_type: 8 },
              ],
            },
          ],
        },
      ],
    },
  ];

  const rules = `
bucket_definitions:
  stock_organisation:
    data:
      - SELECT * FROM stock.stock_balance WHERE tenant_id = bucket.tenant_id
  material_stock_organisation:
    data:
      - SELECT * FROM material_stock.stock_balance WHERE tenant_id = bucket.tenant_id
`;

  it('keeps the two tables distinct instead of merging them into one empty table', async () => {
    stubFetch(schemaResponse(connections), diagnosticsResponse(rules));
    const result = await fetchReplicatedSchema({ adminUrl: 'http://engine.test', token: 't' });

    expect(result.analyzedBy).toBe('local-reader');
    expect(result.tables).toHaveLength(2);

    const stock = result.tables.find((t) => t.name === 'stock_stock_balance');
    const material = result.tables.find((t) => t.name === 'material_stock_stock_balance');

    expect(stock).toBeDefined();
    expect(material).toBeDefined();
    expect(stock!.columns.map((c) => c.name)).toEqual(['organization_id', 'agency_id']);
    expect(material!.columns.map((c) => c.name)).toEqual([
      'organization_id',
      'agency_id',
      'reserved_quantity',
    ]);
  });

  it('neither disambiguated table ends up with zero columns', async () => {
    stubFetch(schemaResponse(connections), diagnosticsResponse(rules));
    const result = await fetchReplicatedSchema({ adminUrl: 'http://engine.test', token: 't' });

    for (const table of result.tables) {
      expect(table.columns.length).toBeGreaterThan(0);
    }
  });
});

describe('fetchReplicatedSchema (fallback path): a table cited under only one schema keeps its bare name', () => {
  const connections = [
    {
      schemas: [
        {
          name: 'manufacturing',
          tables: [
            {
              name: 'bill_of_materials',
              columns: [{ name: 'organization_id', sqlite_type: 2 }],
            },
          ],
        },
      ],
    },
  ];

  const rules = `
bucket_definitions:
  manufacturing_organisation:
    data:
      - SELECT * FROM manufacturing.bill_of_materials WHERE tenant_id = bucket.tenant_id
  manufacturing_agence:
    data:
      - SELECT * FROM manufacturing.bill_of_materials WHERE tenant_id = bucket.tenant_id AND agency_id = bucket.agency_id
`;

  it('is not renamed just because it appears in two buckets', async () => {
    stubFetch(schemaResponse(connections), diagnosticsResponse(rules));
    const result = await fetchReplicatedSchema({ adminUrl: 'http://engine.test', token: 't' });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.name).toBe('bill_of_materials');
    expect(result.tables[0]!.buckets.sort()).toEqual(['manufacturing_agence', 'manufacturing_organisation']);
  });
});

describe('fetchReplicatedSchema (fallback path): an unqualified table (no schema named in the query)', () => {
  const connections = [
    {
      schemas: [
        {
          name: 'public',
          tables: [{ name: 'tag_entity', columns: [{ name: 'name', sqlite_type: 2 }] }],
        },
      ],
    },
  ];

  const rules = `
bucket_definitions:
  referentiel_tenant:
    data:
      - SELECT * FROM tag_entity WHERE tenant_id = bucket.tenant_id
`;

  it('still resolves its columns via the "public" default', async () => {
    stubFetch(schemaResponse(connections), diagnosticsResponse(rules));
    const result = await fetchReplicatedSchema({ adminUrl: 'http://engine.test', token: 't' });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.name).toBe('tag_entity');
    expect(result.tables[0]!.columns).toEqual([{ name: 'name', type: 'text' }]);
  });
});
