#!/usr/bin/env node
/**
 * Compiles a taskly corpus, then compares every locally executable endpoint
 * against the running backend — reads and writes. This is the only check that
 * confronts a compiled program with a real Spring Boot application rather than
 * a fixture, so a difference here is the signal that matters most.
 *
 * `node corpus-differential.mjs [reactive|jpa]`, default reactive: the same API
 * on the two Spring stacks, so both must answer identically.
 */
import { build } from '../src/aeris/compiler/build.ts';
import { runDifferential } from '../src/aeris/compiler/differential.ts';
import { CORPORA, corpusClaims, corpusHeaders } from './corpus-config.ts';

const name = process.argv[2] ?? 'reactive';
const corpus = CORPORA[name];
if (corpus === undefined) {
  process.stderr.write(`Unknown corpus ${name}; expected one of ${Object.keys(CORPORA).join(', ')}.\n`);
  process.exit(2);
}
const backendUrl = corpus.baseUrl;
const databaseUrl = corpus.databaseUrl;
const config = corpus.config();
process.stdout.write(`corpus ${name}: ${corpus.root} against ${backendUrl}\n`);

const { artifact } = await build({ rootDir: corpus.root, config, write: false });
const summary = await runDifferential({
  artifact,
  backendUrl,
  databaseUrl,
  headers: corpusHeaders,
  claims: corpusClaims,
  writes: true,
  log: (line) => process.stdout.write(`${line}\n`),
});

if (summary.skipped.length > 0) {
  process.stdout.write(`\nskipped: ${JSON.stringify(summary.skipped, null, 1)}\n`);
}
if (summary.mismatches > 0) {
  process.stderr.write(`\n${summary.mismatches} difference(s) between the compiled program and the backend.\n`);
  process.exit(1);
}
