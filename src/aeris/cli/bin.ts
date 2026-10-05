#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { build, buildReport, renderReportHtml } from '../compiler/build.js';
import { detectConfig } from '../compiler/init.js';
import { collectSources } from '../compiler/project.js';
import { explainPlan } from '../ir/pretty.js';
import { importPrivateKeyPem, importPublicKey, signArtifact, verifyArtifact } from '../ir/signing.js';
import { LOCAL_CLASSES, type AerisArtifact } from '../ir/types.js';
import { validateArtifact } from '../ir/validate.js';

const USAGE = `Usage: aeris <command> [options]

Commands:
  init [root]                       Propose an aeris.config.yaml for a backend
  keygen --out <dir> [--key-id id]  Create an Ed25519 signing key pair
  analyze <root> [--config f] [--out dir] [--sign key.pem --key-id id] [--commit sha] [--database url]
                                    Compile the backend into a signed AERIS artifact
  explain <METHOD> <path> [--artifact f]
                                    Show the class, reasons and local program of an endpoint
  report [--artifact f] [--format html|json] [--out f]
  diff <old.json> <new.json> [--fail-on-regression]
                                    Compare two artifacts (CI gate: offline endpoints that regressed)
  publish --artifact f --sign key.pem --key-id id [--out f]
  verify <signed.json> --public-key f [--key-id id]
  test --artifact f --backend <url> --database <postgres-url> --token <bearer> [--claims json] [--only glob] [--writes]
                                    Differential test: local executor vs. the real backend
  gateway --config <gateway.yaml>   Start the Sync Gateway
`;

type Options = Record<string, string | boolean>;

function parse(args: readonly string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) options[name] = true;
      else {
        options[name] = next;
        index += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function option(options: Options, name: string): string | undefined {
  const value = options[name];
  if (value === true) throw new Error(`--${name} needs a value.`);
  return value === false ? undefined : value;
}

function required(options: Options, name: string): string {
  const value = option(options, name);
  if (value === undefined) throw new Error(`--${name} is required.`);
  return value;
}

async function loadArtifact(path: string): Promise<AerisArtifact> {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as AerisArtifact | { artifact: AerisArtifact };
  const artifact = 'artifact' in parsed ? parsed.artifact : parsed;
  validateArtifact(artifact);
  return artifact;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, options } = parse(rest);
  switch (command) {
    case 'init': {
      const root = resolve(positional[0] ?? '.');
      const detected = await detectConfig(root, await collectSources(root));
      const target = resolve(root, 'aeris.config.yaml');
      try {
        await writeFile(target, detected.yaml, { flag: 'wx' });
        process.stdout.write(`${pc.green('Created')} ${target}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        process.stdout.write(`${pc.yellow('Exists, not overwritten:')} ${target}\n--- proposal ---\n${detected.yaml}`);
      }
      for (const note of detected.notes) process.stdout.write(`${pc.cyan('note:')} ${note}\n`);
      return 0;
    }
    case 'keygen': {
      const out = resolve(required(options, 'out'));
      const keyId = option(options, 'key-id') ?? `aeris-${new Date().toISOString().slice(0, 10)}`;
      await mkdir(out, { recursive: true });
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const raw = publicKey.export({ format: 'jwk' }).x!;
      await writeFile(resolve(out, `${keyId}.private.pem`), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
      await writeFile(resolve(out, `${keyId}.public.pem`), publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx' });
      const base64 = Buffer.from(raw, 'base64url').toString('base64');
      await writeFile(resolve(out, `${keyId}.public.txt`), `${base64}\n`, { flag: 'wx' });
      process.stdout.write(`Key id: ${keyId}\nPrivate key (keep secret, CI only): ${resolve(out, `${keyId}.private.pem`)}\nPublic key for the runtime trustedKeys: ${base64}\n`);
      return 0;
    }
    case 'analyze': {
      const root = positional[0];
      if (root === undefined) throw new Error('analyze needs the backend source root.');
      const signingKey = option(options, 'sign');
      const result = await build({
        rootDir: root,
        ...(option(options, 'config') === undefined ? {} : { configPath: resolve(option(options, 'config')!) }),
        ...(option(options, 'out') === undefined ? {} : { outputDir: option(options, 'out')! }),
        ...(signingKey === undefined ? {} : { signingKeyPem: await readFile(resolve(signingKey), 'utf8'), keyId: required(options, 'key-id') }),
        ...(option(options, 'commit') === undefined ? {} : { sourceCommit: option(options, 'commit')! }),
        ...(option(options, 'database') === undefined ? {} : { databaseUrl: option(options, 'database')! }),
      });
      const report = result.report;
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`${pc.green('AERIS analysis complete')} (${report.durationMs} ms, ${report.sourceFiles} files)\n`);
      process.stdout.write(`  artifact v${report.artifactVersion}: ${report.endpoints} endpoints, ${pc.bold(String(report.offlineCapable))} usable offline\n`);
      for (const [name, count] of Object.entries(report.byClass)) process.stdout.write(`    ${name.padEnd(16)} ${count}\n`);
      process.stdout.write(`  projections: ${report.projections.length}; test vectors: ${result.artifact.testVectors.length}; signed: ${result.signed === undefined ? 'no' : 'yes'}\n`);
      for (const output of result.outputs) process.stdout.write(`  wrote ${output}\n`);
      return 0;
    }
    case 'explain': {
      const [method, path] = positional;
      if (method === undefined || path === undefined) throw new Error('explain needs METHOD and path, e.g. explain GET /api/items/{id}');
      const artifact = await loadArtifact(option(options, 'artifact') ?? '.aeris/aeris-artifact.json');
      const plan = artifact.endpoints.find((candidate) => candidate.id === `${method.toUpperCase()} ${path}`);
      if (plan === undefined) {
        const close = artifact.endpoints.filter((candidate) => candidate.path.includes(path)).slice(0, 10).map((candidate) => candidate.id);
        throw new Error(`No endpoint ${method.toUpperCase()} ${path}.${close.length > 0 ? ` Did you mean: ${close.join(', ')}` : ''}`);
      }
      process.stdout.write(`${explainPlan(plan)}\n`);
      return 0;
    }
    case 'report': {
      const artifact = await loadArtifact(option(options, 'artifact') ?? '.aeris/aeris-artifact.json');
      const report = buildReport(artifact, 0, 0);
      const content = option(options, 'format') === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderReportHtml(report);
      const out = option(options, 'out');
      if (out === undefined) process.stdout.write(content);
      else await writeFile(resolve(out), content);
      return 0;
    }
    case 'diff': {
      const [before, after] = positional;
      if (before === undefined || after === undefined) throw new Error('diff needs two artifact files.');
      const left = await loadArtifact(before);
      const right = await loadArtifact(after);
      const previous = new Map(left.endpoints.map((plan) => [plan.id, plan]));
      let changes = 0;
      const regressions: string[] = [];
      const local = (offlineClass: string) => LOCAL_CLASSES.has(offlineClass as never);
      for (const plan of right.endpoints) {
        const old = previous.get(plan.id);
        if (old !== undefined && local(old.offlineClass) && !local(plan.offlineClass)) regressions.push(`${plan.id}: ${old.offlineClass} -> ${plan.offlineClass} (${plan.reasons[0] ?? ''})`);
        if (old === undefined) {
          process.stdout.write(`${pc.green('+')} ${plan.id} ${plan.offlineClass}\n`);
          changes += 1;
        } else if (old.offlineClass !== plan.offlineClass || JSON.stringify(old.program) !== JSON.stringify(plan.program)) {
          process.stdout.write(`${pc.yellow('~')} ${plan.id} ${old.offlineClass} -> ${plan.offlineClass}${JSON.stringify(old.program) !== JSON.stringify(plan.program) ? ' (program changed)' : ''}\n`);
          changes += 1;
        }
        previous.delete(plan.id);
      }
      for (const removed of previous.values()) {
        process.stdout.write(`${pc.red('-')} ${removed.id}\n`);
        changes += 1;
      }
      if (left.projectionVersion !== right.projectionVersion) process.stdout.write(`projection version ${left.projectionVersion} -> ${right.projectionVersion} (devices re-snapshot)\n`);
      process.stdout.write(`${changes} endpoint change(s); artifact v${left.artifactVersion} -> v${right.artifactVersion}\n`);
      if (regressions.length > 0) {
        process.stdout.write(`${pc.red(`${regressions.length} endpoint(s) no longer available offline:`)}\n  ${regressions.join('\n  ')}\n`);
        if (options['fail-on-regression'] === true) return 1;
      }
      return 0;
    }
    case 'publish': {
      const artifact = await loadArtifact(required(options, 'artifact'));
      const signed = await signArtifact(artifact, await importPrivateKeyPem(await readFile(resolve(required(options, 'sign')), 'utf8')), required(options, 'key-id'));
      const out = option(options, 'out') ?? required(options, 'artifact').replace(/\.json$/, '.signed.json');
      await writeFile(resolve(out), `${JSON.stringify(signed)}\n`);
      process.stdout.write(`Signed artifact v${artifact.artifactVersion} with ${signed.keyId}: ${resolve(out)}\n`);
      return 0;
    }
    case 'verify': {
      const envelope = JSON.parse(await readFile(resolve(positional[0] ?? required(options, 'envelope')), 'utf8')) as { keyId?: string };
      const key = await importPublicKey((await readFile(resolve(required(options, 'public-key')), 'utf8')).trim());
      const keyId = option(options, 'key-id') ?? envelope.keyId ?? '';
      const artifact = await verifyArtifact(envelope, new Map([[keyId, key]]));
      const local = artifact.endpoints.filter((plan) => LOCAL_CLASSES.has(plan.offlineClass)).length;
      process.stdout.write(`${pc.green('Valid signature')} (${keyId}): artifact v${artifact.artifactVersion}, ${local} offline endpoints\n`);
      return 0;
    }
    case 'test': {
      const { runDifferential } = await import('../compiler/differential.js');
      const summary = await runDifferential({
        artifact: await loadArtifact(required(options, 'artifact')),
        backendUrl: required(options, 'backend'),
        databaseUrl: required(options, 'database'),
        token: required(options, 'token'),
        ...(option(options, 'claims') === undefined ? {} : { claims: JSON.parse(option(options, 'claims')!) as Record<string, string> }),
        ...(option(options, 'only') === undefined ? {} : { only: option(options, 'only')! }),
        writes: options.writes === true,
        log: (line: string) => process.stdout.write(`${line}\n`),
      });
      return summary.mismatches === 0 ? 0 : 1;
    }
    case 'gateway': {
      const { startGatewayFromConfig } = await import('../gateway/server.js');
      await startGatewayFromConfig(resolve(required(options, 'config')));
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((error: unknown) => {
  process.stderr.write(`${pc.red(`aeris: ${error instanceof Error ? error.message : String(error)}`)}\n`);
  process.exitCode = 1;
});
