#!/usr/bin/env node
// Run from the frontend project's ROOT, not from this folder: config.yaml
// paths (include, generated files) are relative to the current directory.

import { Cli } from './Cli.js';

const code = await new Cli().run(process.argv.slice(2), process.cwd());
process.exit(code);
