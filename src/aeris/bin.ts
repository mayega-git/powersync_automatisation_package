#!/usr/bin/env node
import { resolve } from 'node:path';
import pc from 'picocolors';
import { compileProject } from './ProjectCompiler.js';
import { SpringBootAdapter } from './SpringBootAdapter.js';

async function main(args: readonly string[]): Promise<void> {
  const [command, rootArg, ...options] = args;
  if (command !== 'analyze' || rootArg === undefined || rootArg.startsWith('--')) {
    throw new Error('Usage: aeris analyze <backend-source-root> [--output <artifact.json>] [--signing-key <private.pem> --key-id <id>]');
  }

  let outputFile: string | undefined;
  let signingKeyFile: string | undefined;
  let keyId: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Every AERIS option requires a value.');
    }
    if (option === '--output' && outputFile === undefined) outputFile = value;
    else if (option === '--signing-key' && signingKeyFile === undefined) signingKeyFile = value;
    else if (option === '--key-id' && keyId === undefined) keyId = value;
    else throw new Error('Options may only be specified once: --output, --signing-key, --key-id.');
    if (option !== '--output' && option !== '--signing-key' && option !== '--key-id') {
      throw new Error(`Unknown AERIS option: ${option}`);
    }
    index += 1;
  }

  if ((signingKeyFile === undefined) !== (keyId === undefined)) {
    throw new Error('--signing-key and --key-id must be provided together.');
  }

  const result = await compileProject({
    rootDir: resolve(rootArg),
    adapter: new SpringBootAdapter(),
    outputFile,
    signingKeyFile,
    keyId,
  });
  const unsupported = result.artifact.endpoints.filter(({ policy }) => policy === 'UNSUPPORTED').length;
  process.stdout.write(
    `${pc.green('AERIS analysis complete')}\n` +
    `  Source files: ${result.sourceFiles}\n` +
    `  Endpoints: ${result.artifact.endpoints.length}\n` +
    `  Unsupported (conservative): ${unsupported}\n` +
    `  Signed: ${result.signedArtifact === undefined ? 'no' : `yes (${result.signedArtifact.keyId})`}\n` +
    `  Source revision: ${result.artifact.sourceRevision}\n` +
    `  Artifact: ${result.outputFile}\n`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${pc.red(`AERIS: ${message}`)}\n`);
  process.exitCode = 1;
});
