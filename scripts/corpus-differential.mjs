#!/usr/bin/env node
/**
 * Compiles the taskly corpus, then compares every locally executable endpoint
 * against the running backend — reads and writes. This is the only check that
 * confronts a compiled program with a real Spring Boot application rather than
 * a fixture, so a difference here is the signal that matters most.
 *
 * Expects the backend on TASKLY_BASE_URL and its database on TASKLY_DATABASE_URL.
 */
import { build } from '../src/aeris/compiler/build.ts';
import { runDifferential } from '../src/aeris/compiler/differential.ts';
import { CORPUS_ROOT, corpusClaims, corpusConfig, corpusHeaders } from './corpus-config.ts';

const backendUrl = process.env.TASKLY_BASE_URL ?? 'http://127.0.0.1:18090';
const databaseUrl = process.env.TASKLY_DATABASE_URL ?? 'postgres://taskly:taskly@127.0.0.1:15434/taskly';
const config = corpusConfig();

const { artifact } = await build({ rootDir: CORPUS_ROOT, config, write: false });
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
