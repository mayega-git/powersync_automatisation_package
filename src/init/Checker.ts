import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './ConfigLoader.js';
import { loadOperations } from './OperationsDocument.js';
import { fetchDocumentation } from './OpenApiSource.js';
import { collectFiles, scan } from './RequestPathScanner.js';
import { mostSimilar, similarity, REVIEW_THRESHOLD } from './PathSimilarity.js';
import type { OperationRow, SyncConfig } from './types.js';

export interface CheckError {
  key: string;
  line: number;
  message: string;
}

export interface UndeclaredCall {
  file: string;
  line: number;
  path: string;
}

export interface Review {
  key: string;
  path: string;
  serverPath: string;
  score: number;
}

export interface CheckResult {
  operations: number;
  withServerPath: number;
  errors: CheckError[];
  /** Informative, not blocking: calls in the code the table doesn't declare. */
  undeclaredCalls: UndeclaredCall[];
  /** Review order, most to least doubtful. Never blocking. */
  reviewOrder: Review[];
  ok: boolean;
}

/** An interpolation carrying a query string, not a path segment. */
const QUERY_INTERPOLATION = /\$\{\s*(qs|query|params|search)\s*\}/gi;

/** The shape of a path, with its holes emptied out, so two differently-named holes still match. */
export function pathShape(path: string): string {
  const withoutQuery = (path.split('?')[0] ?? '').replace(QUERY_INTERPOLATION, '');
  return withoutQuery
    .split('/')
    .map((s) => (/^\$?\{[^}]*\}$/.test(s) ? '{}' : s))
    .join('/')
    .replace(/\/$/, '');
}

/** Every path written literally across a set of directories, regardless of where it's called from. */
export function pathsInCode(cwd: string, directories: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of collectFiles(cwd, [...directories])) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/["'`](\/[^"'`\n]*)["'`]/g)) {
      found.add(pathShape(m[1]!));
    }
  }
  return found;
}

export interface CheckOptions {
  cwd: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  loadOperationsFn?: (cwd: string, path?: string) => OperationRow[];
  fetchDocumentationFn?: typeof fetchDocumentation;
}

/**
 * Two operations on the same method + path. Blocking: at runtime the module
 * REFUSES TO START on this (validateOfflineMap) rather than pick one at
 * random. Hole names don't count: `/api/education/{kind}` and
 * `/api/education/{resource}` are the SAME path for the path index.
 */
function collisions(rows: readonly OperationRow[]): CheckError[] {
  const seen = new Map<string, OperationRow>();
  const errors: CheckError[] = [];

  for (const row of rows) {
    const key = `${row.method.toUpperCase()} ${pathShape(row.path)}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, row);
      continue;
    }
    errors.push({
      key: row.key,
      line: row.line,
      message:
        `"${row.key}" and "${first.key}" (line ${first.line}) target the same ` +
        `call: ${row.method.toUpperCase()} ${pathShape(row.path)}. Hole names ` +
        "don't distinguish them -- at runtime there's only one shape, and the " +
        'module refuses to start rather than choose. Remove the one that ' +
        'should not be intercepted.',
    });
  }
  return errors;
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const cwd = options.cwd;
  const config = (options.loadConfigFn ?? loadConfig)(cwd);
  const rows = (options.loadOperationsFn ?? loadOperations)(cwd, config.operations);

  const errors: CheckError[] = [];
  const browserSide = pathsInCode(cwd, config.routes.browser);
  const serverSide =
    config.routes.server.length > 0 ? pathsInCode(cwd, config.routes.server) : undefined;

  // 1. The table against the code: the guard against invented paths.

  for (const row of rows) {
    if (!browserSide.has(pathShape(row.path))) {
      errors.push({
        key: row.key,
        line: row.line,
        message:
          `browser path "${row.path}" doesn't appear anywhere in ` +
          `${config.routes.browser.join(', ')}. A path absent from the code ` +
          'cannot be intercepted.',
      });
    }

    if (row.serverPath !== undefined && serverSide !== undefined) {
      if (!serverSide.has(pathShape(row.serverPath))) {
        errors.push({
          key: row.key,
          line: row.line,
          message:
            `server path "${row.serverPath}" doesn't appear anywhere in ` +
            `${config.routes.server.join(', ')}.`,
        });
      }
    }

    const where = checkDeclaredIn(cwd, row);
    if (where !== undefined) errors.push(where);
  }

  errors.push(...collisions(rows));

  // 2. The table against the server documentation.

  const documented = await documentedPaths(config, options);
  if (documented !== undefined) {
    for (const row of rows) {
      if (row.serverPath === undefined || row.serverMethod === undefined) continue;
      const key = `${row.serverMethod} ${pathShape(row.serverPath)}`;
      if (!documented.has(key)) {
        errors.push({
          key: row.key,
          line: row.line,
          message:
            `"${row.serverMethod} ${row.serverPath}" is absent from the server ` +
            'documentation: a typo, or a removed endpoint.',
        });
      }
    }
  }

  // 3. Calls in the code the table doesn't declare.

  const declared = new Set(rows.map((r) => pathShape(r.path)));
  const undeclaredCalls: UndeclaredCall[] = [];
  for (const site of scan(cwd, config)) {
    if (site.unresolvedReason !== undefined || site.pathExpression.length === 0) continue;
    if (declared.has(pathShape(site.pathExpression))) continue;
    if (!inScope(site.pathExpression, config)) continue;
    undeclaredCalls.push({ file: site.file, line: site.line, path: site.pathExpression });
  }

  // 4. Review order. NEVER blocking: a low score is not proof of a mistake.

  const reviewOrder: Review[] = rows
    .filter((r): r is OperationRow & { serverPath: string } => r.serverPath !== undefined)
    .map((r) => ({
      key: r.key,
      path: r.path,
      serverPath: r.serverPath,
      score: similarity(r.path, r.serverPath),
    }))
    .sort((a, b) => a.score - b.score);

  return {
    operations: rows.length,
    withServerPath: reviewOrder.length,
    errors,
    undeclaredCalls,
    reviewOrder,
    ok: errors.length === 0,
  };
}

/** `scope` now applies to BROWSER paths: it only avoids flagging a call nobody wants intercepted. */
function inScope(path: string, config: SyncConfig): boolean {
  const { pathPrefixes, onlineOnlyPathPrefixes } = config.scope;
  if (onlineOnlyPathPrefixes.some((p) => path.startsWith(p))) return false;
  if (pathPrefixes.length === 0) return true;
  return pathPrefixes.some((p) => path.startsWith(p));
}

function checkDeclaredIn(cwd: string, row: OperationRow): CheckError | undefined {
  if (row.declaredIn.length === 0) return undefined;

  const separator = row.declaredIn.lastIndexOf(':');
  const file = separator === -1 ? row.declaredIn : row.declaredIn.slice(0, separator);
  const fullPath = join(cwd, file);

  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return {
      key: row.key,
      line: row.line,
      message: `"Declared in" points to ${file}, which doesn't exist.`,
    };
  }

  if (separator !== -1) {
    const lineNumber = Number(row.declaredIn.slice(separator + 1));
    if (Number.isFinite(lineNumber)) {
      const lineCount = readFileSync(fullPath, 'utf8').split('\n').length;
      if (lineNumber < 1 || lineNumber > lineCount) {
        return {
          key: row.key,
          line: row.line,
          message:
            `"Declared in" points to ${file}:${lineNumber}, but that file has ` +
            `only ${lineCount} lines.`,
        };
      }
    }
  }
  return undefined;
}

async function documentedPaths(
  config: SyncConfig,
  options: CheckOptions,
): Promise<Set<string> | undefined> {
  if (config.docSource === undefined || config.docSource.length === 0) return undefined;
  try {
    const doc = await (options.fetchDocumentationFn ?? fetchDocumentation)(config.docSource);
    return new Set(
      doc.operations.map((op) => `${op.method.toUpperCase()} ${pathShape(op.path)}`),
    );
  } catch {
    return undefined;
  }
}

export { REVIEW_THRESHOLD, mostSimilar };
