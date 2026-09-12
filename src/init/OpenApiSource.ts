import { readFileSync } from 'node:fs';

import type { OpenApiDocument, OpenApiOperation } from './types.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export class OpenApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OpenApiError';
  }
}

/** Accepts a network address or a local file. */
export async function fetchDocumentation(docSource: string): Promise<OpenApiDocument> {
  const raw = docSource.startsWith('http')
    ? await fetchRemote(docSource)
    : readFileSync(docSource, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OpenApiError(
      `The documentation read from ${docSource} isn't valid JSON. Check that ` +
        'the address actually returns the document and not an error page.',
      { cause: err },
    );
  }
  return parseDocument(parsed, docSource);
}

async function fetchRemote(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new OpenApiError(
      `${url} returned ${res.status}. Is the server running, and the ` +
        'documentation exposed at that address?',
    );
  }
  return res.text();
}

export function parseDocument(parsed: unknown, source: string): OpenApiDocument {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new OpenApiError(`Unreadable document from ${source}.`);
  }
  const paths = (parsed as Record<string, unknown>)['paths'];
  if (typeof paths !== 'object' || paths === null) {
    throw new OpenApiError(
      `The document read from ${source} has no "paths" section: it's probably ` +
        'not an OpenAPI document.',
    );
  }

  const operations: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (typeof item !== 'object' || item === null) continue;
    for (const method of METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (typeof op !== 'object' || op === null) continue;
      const o = op as Record<string, unknown>;
      operations.push({
        operationId:
          typeof o['operationId'] === 'string' && o['operationId'].length > 0
            ? o['operationId']
            : `${method}${path.replace(/[^A-Za-z0-9]+/g, '_')}`,
        method: method.toUpperCase(),
        path,
        tags: Array.isArray(o['tags'])
          ? (o['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        ...describeResponses(o['responses']),
      });
    }
  }
  return { operations };
}

function describeResponses(
  responses: unknown,
): { responseSuccess?: string; responseFailure?: string } {
  if (typeof responses !== 'object' || responses === null) return {};
  const out: { responseSuccess?: string; responseFailure?: string } = {};

  for (const [code, body] of Object.entries(responses as Record<string, unknown>)) {
    const described = describeOne(body);
    if (described === undefined) continue;
    if (code.startsWith('2') && out.responseSuccess === undefined) {
      out.responseSuccess = described;
    } else if ((code.startsWith('4') || code.startsWith('5')) && out.responseFailure === undefined) {
      out.responseFailure = described;
    }
  }
  return out;
}

function describeOne(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const content = (body as Record<string, unknown>)['content'];
  if (typeof content !== 'object' || content === null) return undefined;

  for (const media of Object.values(content as Record<string, unknown>)) {
    if (typeof media !== 'object' || media === null) continue;
    const m = media as Record<string, unknown>;
    if (m['example'] !== undefined) return JSON.stringify(m['example'], null, 2);
    if (m['schema'] !== undefined) return JSON.stringify(m['schema'], null, 2);
  }
  return undefined;
}
