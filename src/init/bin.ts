#!/usr/bin/env node
// Run from the frontend project's ROOT, not from this folder: config.yaml
// paths (include, generated files) are relative to the current directory.

import { Cli } from './Cli.js';

const FLAGS = new Set(['--verbose', '-v', '--no-color']);
const rest = process.argv.slice(2).filter((a) => !FLAGS.has(a));
const flags = process.argv.slice(2).filter((a) => FLAGS.has(a));

const verbose = flags.includes('--verbose') || flags.includes('-v');
const color = flags.includes('--no-color') ? false : undefined;

const code = await new Cli().run(rest, process.cwd(), {
  verbose,
  ...(color !== undefined ? { color } : {}),
});
process.exit(code);
