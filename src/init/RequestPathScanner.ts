import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { DiscoveredCallSite, PathSegment, SegmentKind, SyncConfig } from './types.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo',
]);

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function scan(cwd: string, config: SyncConfig): DiscoveredCallSite[] {
  const files = collectFiles(cwd, config.routes.browser);
  const sites: DiscoveredCallSite[] = [];
  for (const file of files) {
    sites.push(...scanFile(cwd, file, config.httpWrapper.jsDocTag));
  }
  return sites;
}

/** Config patterns are handled loosely: keep the fixed prefix as a starting point and walk down. */
export function collectFiles(cwd: string, include: string[]): string[] {
  const found = new Set<string>();
  for (const pattern of include) {
    const base = pattern.split(/[*?[]/)[0] ?? '';
    const start = join(cwd, base.endsWith(sep) ? base.slice(0, -1) : base);
    walk(start, found);
  }
  return [...found].sort();
}

function walk(path: string, out: Set<string>): void {
  let info;
  try {
    info = statSync(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (SOURCE_EXTENSIONS.some((e) => path.endsWith(e))) out.add(path);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    walk(join(path, entry), out);
  }
}

export function scanFile(cwd: string, file: string, jsDocTag: string): DiscoveredCallSite[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(jsDocTag)) return [];

  const lines = text.split('\n');
  const sites: DiscoveredCallSite[] = [];
  const relativeFile = relative(cwd, file) || file;

  const onPath = new RegExp(
    escape(jsDocTag) + String.raw`\s*\*/\s*(["'\`])(/[^"'\`\n]*)\1`,
  );

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.includes(jsDocTag)) continue;

    const direct = onPath.exec(lines[i]!);
    if (direct !== null) {
      sites.push(analyzePath(relativeFile, i + 1, direct[2]!, callWindow(lines, i)));
      continue;
    }

    let start = i;
    while (start < lines.length && !lines[start]!.includes('*/')) start += 1;
    start += 1;
    if (start >= lines.length) continue;

    const body = readFunctionBody(lines, start);
    sites.push(analyzeBody(relativeFile, start + 1, body));
  }
  return sites;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function callWindow(lines: readonly string[], from: number): string {
  const pieces: string[] = [];
  for (let i = from; i < lines.length && i < from + 10; i += 1) {
    pieces.push(lines[i]!);
    if (lines[i]!.includes(';')) break;
  }
  return pieces.join('\n');
}

function analyzePath(
  file: string,
  line: number,
  pathExpression: string,
  window: string,
): DiscoveredCallSite {
  return {
    file,
    line,
    method: readMethod(window),
    pathExpression,
    segments: splitIntoSegments(pathExpression),
  };
}

/** The body of the following function, delimited by braces; ignores braces inside strings/comments. */
export function readFunctionBody(lines: string[], start: number): string {
  let depth = 0;
  let started = false;
  const collected: string[] = [];

  for (let i = start; i < lines.length; i += 1) {
    const line = stripStringsAndComments(lines[i]!);
    collected.push(lines[i]!);
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    if (started && depth <= 0) break;
  }
  return collected.join('\n');
}

function stripStringsAndComments(line: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      out += ' ';
      if (ch === '\\') { i += 1; out += ' '; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ' '; continue; }
    if (ch === '/' && line[i + 1] === '/') return out;
    out += ch;
  }
  return out;
}

function analyzeBody(file: string, line: number, body: string): DiscoveredCallSite {
  const paths = [...body.matchAll(/["'`](\/[^"'`\n]*)["'`]/g)].map((m) => m[1]!);

  if (paths.length === 0) {
    return {
      file, line, method: '', pathExpression: '', segments: [],
      unresolvedReason: 'no path starting with / was found in the function body',
    };
  }
  if (paths.length > 1) {
    return {
      file, line, method: '', pathExpression: paths.join(' | '), segments: [],
      unresolvedReason:
        `${paths.length} different paths in the same function: no way to know ` +
        'which one is called. Split into one function per call.',
    };
  }

  const pathExpression = paths[0]!;
  const method = readMethod(body);

  return {
    file, line, method, pathExpression,
    segments: splitIntoSegments(pathExpression),
  };
}

/** Absent from the body defaults to GET, the convention of every HTTP client. */
export function readMethod(body: string): string {
  const explicit = body.match(/method\s*:\s*["'`](\w+)["'`]/i);
  if (explicit !== null) return explicit[1]!.toUpperCase();

  for (const verb of METHODS) {
    if (new RegExp(`\\.${verb.toLowerCase()}\\s*\\(`).test(body)) return verb;
  }
  return 'GET';
}

export function splitIntoSegments(pathExpression: string): PathSegment[] {
  return pathExpression
    .split('/')
    .filter((raw) => raw.length > 0)
    .map((raw): PathSegment => ({ raw, kind: classify(raw) }));
}

function classify(raw: string): SegmentKind {
  if (/^\$\{[^}]*\}$/.test(raw)) return 'Identifier';
  if (raw.includes('${')) return 'Unresolved';
  return 'Literal';
}
