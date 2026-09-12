import { dirname, isAbsolute, join } from 'node:path';

import { CONFIG_FILE_NAME, writeConfigTemplate } from './ConfigLoader.js';
import { check, type CheckOptions, type CheckResult, REVIEW_THRESHOLD } from './Checker.js';
import {
  generate,
  HANDLERS_FILE,
  STUB_FILE,
  type GenerateOptions,
  type GenerateResult,
} from './MappingGenerator.js';
import { checkEntities, type EntitiesCheckResult } from './EntitiesChecker.js';
import {
  ENTITIES_FILE,
  loadEntities,
  writeEntitiesModule,
  writeEntitiesTemplate,
} from './EntitiesFile.js';
import { OPERATIONS_FILE_NAME } from './OperationsDocument.js';
import {
  writeOperationsDraft,
  type DraftWriteResult,
} from './OperationsDraft.js';
import { readSchemaFile, SCHEMA_FILE } from './ReplicatedSchema.js';
import { generateSchema, type SchemaOptions, type SchemaResult } from './SchemaCommand.js';
import {
  addToGitignore,
  setupPowerSync,
  type SetupOptions,
  type SetupResult,
} from './PowerSyncSetup.js';
import { SECRETS_FILE, writeSecretsTemplate } from './SecretsFile.js';
import { scaffold, type ScaffoldOptions, type ScaffoldResult } from './ScaffoldCommand.js';
import { ConfigError, loadConfig } from './ConfigLoader.js';
import { NO_TOKEN_MESSAGE, resolveAdminToken } from './SecretsFile.js';
import type { SyncConfig } from './types.js';

export interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

const consoleOutput: CliOutput = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

export class ExecuteCliCommand {
  constructor(readonly out: CliOutput = consoleOutput) {}

  powersync(options: SetupOptions): SetupResult {
    const r = setupPowerSync(options);

    for (const step of r.steps) {
      const mark =
        step.state === 'done' ? '+' : step.state === 'already-set' ? '=' : '!';
      const detail = step.detail !== undefined ? `  (${step.detail})` : '';
      this.out.log(`  ${mark} ${step.name}${detail}`);
    }

    const remaining = r.steps.filter((e) => e.state === 'manual');
    this.out.log('');

    if (r.bundlerBlock !== undefined) {
      this.out.log(
        "The bundler setting wasn't applied. Without it the engine doesn't " +
          'start in the browser -- it runs on WASM and Web Workers. Paste this ' +
          'into the configuration object:',
      );
      this.out.log('');
      this.out.log(r.bundlerBlock);
      this.out.log('');
    }

    this.out.log(
      remaining.length === 0
        ? 'The application can run the engine. Next: "offline-sync init".'
        : `${remaining.length} item(s) remain manual, listed above.`,
    );
    return r;
  }

  /** Never replaces an existing file: two lines written by hand are worth more than what a command can produce. */
  entites(options: { cwd: string; path?: string }): {
    written: boolean;
    missing: string[];
  } {
    const config = loadConfig(options.cwd);
    const schemaFile = config.powersync?.schemaFile ?? SCHEMA_FILE;
    const schema = readSchemaFile(options.cwd, schemaFile);

    if (schema === undefined) {
      throw new ConfigError(
        `${schemaFile} was not found: without it there's no way to know which ` +
          'tables the engine replicates, and the template would be empty. Run ' +
          '"offline-sync schema" first.',
      );
    }

    const r = writeEntitiesTemplate(options.cwd, schema, options.path);

    if (r.written) {
      this.out.log(`+ ${ENTITIES_FILE} written, ${schema.tables.length} table(s) added.`);
      this.out.log('');
      this.out.log(
        'What remains: a path in front of each table -- "/api/..." to cover the ' +
          'whole table in one line, or a list of requests when a path is out of ' +
          'step. Then "offline-sync check-entites".',
      );
      return { written: true, missing: [] };
    }

    this.out.log(`= ${ENTITIES_FILE} already exists, it was not touched.`);
    this.transcribe(options.cwd, schemaFile, options.path);
    if (r.missing.length > 0) {
      this.out.log('');
      this.out.log(
        `${r.missing.length} replicated table(s) don't appear in it. A missing ` +
          "table is never intercepted, and nothing says so at runtime:",
      );
      for (const name of r.missing) this.out.log(`  - ${name}`);
    }
    return { written: false, missing: r.missing };
  }

  checkEntites(options: { cwd: string; path?: string }): EntitiesCheckResult {
    const config = loadConfig(options.cwd);
    const schemaFile = config.powersync?.schemaFile ?? SCHEMA_FILE;

    const declaration = loadEntities(options.cwd, options.path);
    const r = checkEntities({
      cwd: options.cwd,
      declaration,
      schema: readSchemaFile(options.cwd, schemaFile),
      directories: config.routes.browser,
    });

    writeEntitiesModule(
      declaration,
      modulePath(options.cwd, schemaFile),
      new Date().toISOString(),
    );

    this.out.log(
      `${r.tables.length} table(s) declared, ${r.paths.length} path(s).`,
    );

    if (r.ok) {
      this.out.log('');
      this.out.log('Nothing to report: the declaration is usable.');
      return r;
    }

    this.out.log('');
    for (const error of r.errors) {
      this.out.error(`  ! ${error.subject}: ${error.message}`);
    }
    return r;
  }

  /** Rewrites the transcription the application imports, from the YAML. */
  private transcribe(cwd: string, schemaFile: string, path?: string): void {
    writeEntitiesModule(
      loadEntities(cwd, path),
      modulePath(cwd, schemaFile),
      new Date().toISOString(),
    );
  }

  init(cwd: string): void {
    const path = writeConfigTemplate(cwd);
    this.out.log(`${CONFIG_FILE_NAME} written: ${path}`);
    this.writeSecrets(cwd);
    this.out.log('');
    this.out.log('To fill in before continuing:');
    this.out.log('  routes.browser -- where browser calls live');
    this.out.log('  routes.server  -- where BFF-to-server calls live');
    this.out.log('  docSource      -- where to find the server documentation (optional)');
    this.out.log('  powersync      -- where to reach the sync engine (optional)');
    this.out.log('');
    this.out.log(
      `${OPERATIONS_FILE_NAME}, the operations table, will be written by ` +
        '"offline-sync build" by following the code. It still needs review: see ' +
        'offline-sync/docs/format-document-operations.md.',
    );
  }

  /** The second file: the one carrying the secret, which git must ignore. Rewrites nothing already there. */
  private writeSecrets(cwd: string): void {
    const secrets = writeSecretsTemplate(cwd);
    this.out.log(
      secrets.written
        ? `${SECRETS_FILE} written: paste the engine's admin token into it.`
        : `${SECRETS_FILE} already exists, it was not replaced.`,
    );

    const ignore = addToGitignore(
      cwd,
      SECRETS_FILE,
      "Secrets for @ksm/offline-sync -- never commit",
    );
    this.out.log(
      ignore.state === 'done'
        ? `${SECRETS_FILE} added to .gitignore.`
        : `${SECRETS_FILE} is already ignored by git.`,
    );
  }

  async schema(options: SchemaOptions): Promise<SchemaResult> {
    const r = await generateSchema(options);

    this.out.log(`${r.schema.tables.length} replicated table(s) retained.`);
    this.out.log(`  Source: ${r.schema.source}`);
    if (r.schema.analyzedBy === 'local-reader') {
      this.out.log(
        '  Rules read by the local reader: the reference library failed to ' +
          'load (it requires a newer Node). Unusual query shapes may slip past it.',
      );
    }
    if (r.buckets.length > 0) {
      this.out.log(`  Declared buckets: ${r.buckets.join(', ')}`);
    } else {
      this.out.log(
        '  No bucket declared: the whole instance schema is retained. Set ' +
          'powersync.buckets to keep only this platform\'s buckets.',
      );
    }
    this.out.log('');
    for (const table of r.schema.tables) {
      this.out.log(`  ${table.name}  (${table.columns.length} column(s))  ${table.buckets.join(', ')}`);
    }

    this.out.log('');
    this.out.log(`Schema written: ${r.schemaFile}`);
    this.out.log('This file is generated: do not edit it, regenerate it.');

    if (r.operations > 0) {
      this.out.log('');
      this.out.log(
        `${r.operations} operation(s) compared: ${r.resolved} now carry a table ` +
          'name read from the schema.',
      );
      if (r.unresolved.length > 0) {
        this.out.log('');
        this.out.log(
          `${r.unresolved.length} guessed name(s) with no matching replicated ` +
            "table. This isn't a fault in the table: it's what the sync rules " +
            'are missing, or a name the HTTP path fails to suggest.',
        );
        for (const u of r.unresolved) {
          this.out.log(`  ${u.table}  (${u.operations} operation(s))`);
        }
      }
    }

    return r;
  }

  scaffold(options: ScaffoldOptions): ScaffoldResult {
    const r = scaffold(options);

    for (const f of r.files) {
      const mark = f.written ? '+' : '=';
      const detail = f.reason !== undefined ? `  (${f.reason})` : '';
      this.out.log(`  ${mark} ${f.path}${detail}`);
    }

    this.out.log('');
    this.out.log(
      'Only one of the two still needs filling in: tokens.ts, where this ' +
        'application gets its tokens from. Marked "TO FILL IN".',
    );
    this.out.log(
      'init.ts is entirely generated -- nothing to decide there, and it ' +
        'regenerates without ever touching tokens.ts.',
    );
    return r;
  }

  operations(options: DraftOptions): DraftWriteResult {
    const config = (options.loadConfigFn ?? loadConfig)(options.cwd);
    const r = writeOperationsDraft(
      options.cwd,
      config,
      options.force !== undefined ? { force: options.force } : {},
    );

    this.out.log(`${r.rows.length} operation(s) drawn from the code.`);
    this.out.log(
      `  ${r.matched} with a server endpoint, established by following the route file.`,
    );
    this.out.log(`  ${r.bffFunctions} BFF function(s) carry a marked path.`);

    const withoutServer = r.rows.filter((l: any) => l.serverPath === undefined);
    if (withoutServer.length > 0) {
      this.out.log('');
      this.out.log(`${withoutServer.length} without a single server endpoint, and why:`);
      for (const l of withoutServer.slice(0, 20)) {
        this.out.log(`  ${l.method} ${l.path}`);
        this.out.log(`      ${l.serverReason ?? 'unknown reason'}`);
      }
      if (withoutServer.length > 20) this.out.log(`  ... and ${withoutServer.length - 20} more.`);
    }

    if (r.duplicateShapes.length > 0) {
      this.out.log('');
      this.out.log(
        `${r.duplicateShapes.length} route(s) described twice, differing only in ` +
          "a hole's name. At runtime only one shape exists: one of the two will " +
          'never be reached.',
      );
      for (const keys of r.duplicateShapes) this.out.log(`  ${keys.join('  /  ')}`);
    }

    if (r.unreadable.length > 0) {
      this.out.log('');
      this.out.log(
        `${r.unreadable.length} marked call(s) whose path couldn't be read:`,
      );
      for (const c of r.unreadable.slice(0, 10)) {
        this.out.log(`  ${c.file}:${c.line}  ${c.unresolvedReason ?? ''}`);
      }
    }

    this.out.log('');
    this.out.log(
      r.written
        ? `${r.path} written. TO REVIEW: the Server column and connectivity.`
        : (r.reason ?? `${r.path} unchanged.`),
    );
    return r;
  }

  async discover(options: GenerateOptions): Promise<GenerateResult> {
    const result = await generate(options);

    this.out.log(`${result.operations.length} operation(s) read from ${OPERATIONS_FILE_NAME}.`);
    this.out.log(`  ${result.withServerPath} with a declared server endpoint.`);
    this.out.log(
      `  ${result.withResponseShape} with their response shape, taken from the documentation.`,
    );
    this.out.log(
      `  ${result.withResolvedTable} with a table name read from the engine's schema.`,
    );
    if (result.schema === undefined) {
      this.out.log('');
      this.out.log(
        'No schema file: table names are GUESSED from the paths. Run ' +
          '"offline-sync schema" once, with the engine running, to replace them ' +
          'with the real ones.',
      );
    }

    const withoutServer = result.operations.length - result.withServerPath;
    if (withoutServer > 0) {
      this.out.log('');
      this.out.log(
        `${withoutServer} operation(s) without a server endpoint: normal for a ` +
          'route that aggregates several calls. They are intercepted and ' +
          'replayed like the others, only their response shape is missing.',
      );
    }

    this.out.log('');
    this.out.log(`Operations map  : ${STUB_FILE}`);
    this.out.log(`Handler templates : ${HANDLERS_FILE}`);
    this.out.log('');
    this.out.log(
      'These two files are generated: do not edit them. Everything is fixed ' +
        `in ${OPERATIONS_FILE_NAME}.`,
    );
    this.out.log(
      'Still to fill in the templates: columns and WHERE clauses, marked ' +
        '"TO CHECK".',
    );
    return result;
  }

  async setup(options: ChainOptions): Promise<ChainResult> {
    const cwd = options.cwd;
    const steps: ChainStep[] = [];

    const buffer: string[] = [];
    const deferred = new ExecuteCliCommand({
      log: (m) => buffer.push(m),
      error: (m) => buffer.push(m),
    });

    deferred.out.log('== powersync: installing the engine in the application ==');
    deferred.powersync({ cwd, ...(options.run !== undefined ? { run: options.run } : {}) });
    steps.push({ name: 'powersync', state: 'done' });

    deferred.out.log('');
    deferred.out.log('== init: the module configuration ==');
    try {
      deferred.init(cwd);
      steps.push({ name: 'init', state: 'done' });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      deferred.out.log(`  = ${CONFIG_FILE_NAME} already exists, it was not replaced.`);
      steps.push({ name: 'init', state: 'done' });
    }

    let config: SyncConfig;
    try {
      config = (options.loadConfigFn ?? loadConfig)(cwd);
    } catch (err) {
      return this.stop(steps, 'schema', err instanceof Error ? err.message : String(err), buffer);
    }

    if (config.powersync === undefined) {
      return this.stop(
        steps,
        'schema',
        'the "powersync" block is empty: set at least powersync.adminUrl, the ' +
          "engine's admin API address.",
      );
    }

    const token = resolveAdminToken(cwd, options.token);
    if (token === undefined) {
      return this.stop(steps, 'schema', NO_TOKEN_MESSAGE, buffer);
    }

    for (const line of buffer) this.out.log(line);

    this.out.log('');
    this.out.log('== schema: the tables, asked from the engine ==');
    await this.schema({
      cwd,
      ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
      ...(options.fetchSchemaFn !== undefined ? { fetchSchemaFn: options.fetchSchemaFn } : {}),
      ...(options.loadOperationsFn !== undefined
        ? { loadOperationsFn: options.loadOperationsFn }
        : {}),
      token,
    });
    steps.push({ name: 'schema', state: 'done' });

    this.out.log('');
    this.out.log('== scaffold: wiring the module to the engine ==');
    this.scaffold({
      cwd,
      ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
    });
    steps.push({ name: 'scaffold', state: 'done' });

    this.out.log('');
    this.out.log(
      `Next: "offline-sync build". It writes ${OPERATIONS_FILE_NAME} by ` +
        'following the code, checks it against that code, then generates the ' +
        'map and handler templates.',
    );
    return { steps, complete: true };
  }

  async build(options: ChainOptions): Promise<ChainResult> {
    const cwd = options.cwd;
    const steps: ChainStep[] = [];

    const buffer: string[] = [];
    const deferred = new ExecuteCliCommand({
      log: (m) => buffer.push(m),
      error: (m) => buffer.push(m),
    });

    deferred.out.log('== operations: the table, drawn from the code ==');
    try {
      deferred.operations({
        cwd,
        ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
      });
      steps.push({ name: 'operations', state: 'done' });
    } catch (err) {
      return this.stop(
        steps,
        'operations',
        err instanceof Error ? err.message : String(err),
        buffer,
      );
    }

    deferred.out.log('');
    deferred.out.log('== check: the table against the code ==');
    const verdict = await deferred.check({
      cwd,
      ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
      ...(options.loadOperationsFn !== undefined
        ? { loadOperationsFn: options.loadOperationsFn }
        : {}),
    });

    if (!verdict.ok) {
      return this.stop(
        steps,
        'discover',
        'the table says something the code denies. Nothing is generated: a ' +
          "template drawn from a path that doesn't exist compiles, registers, " +
          'and never answers.',
        buffer,
      );
    }
    steps.push({ name: 'check', state: 'done' });
    for (const line of buffer) this.out.log(line);

    this.out.log('');
    this.out.log('== discover: the map and the templates ==');
    await this.discover({
      cwd,
      ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
      ...(options.loadOperationsFn !== undefined
        ? { loadOperationsFn: options.loadOperationsFn }
        : {}),
    });
    steps.push({ name: 'discover', state: 'done' });
    return { steps, complete: true };
  }

  /** Puts the blocking reason IN FRONT of the step detail: the only order that reads well. */
  private stop(
    steps: ChainStep[],
    name: string,
    reason: string,
    buffer: readonly string[] = [],
  ): ChainResult {
    steps.push({ name, state: 'stopped', reason });

    this.out.log(`STOPPED before "${name}".`);
    for (const line of reason.split('\n')) this.out.log(`  ${line}`);
    this.out.log('');
    this.out.log('Nothing is lost: running the command again resumes right here.');

    if (buffer.length > 0) {
      this.out.log('');
      this.out.log('--- detail of steps already done ---');
      for (const line of buffer) this.out.log(line);
    }
    return { steps, complete: false };
  }

  /** Returns `true` when nothing blocks. The caller turns it into the exit code. */
  async check(options: CheckOptions): Promise<CheckResult> {
    const r = await check(options);

    this.out.log(
      `${r.operations} operation(s) declared, ${r.withServerPath} with a server endpoint.`,
    );

    if (r.errors.length > 0) {
      this.out.log('');
      this.out.log(`${r.errors.length} problem(s) -- the table says something the code denies:`);
      for (const e of r.errors) {
        this.out.log(`  ${OPERATIONS_FILE_NAME}:${e.line}  ${e.key}`);
        this.out.log(`      ${e.message}`);
      }
    }

    if (r.undeclaredCalls.length > 0) {
      this.out.log('');
      this.out.log(
        `${r.undeclaredCalls.length} call(s) in the code absent from the table -- ` +
          "for information: not every operation is meant to work offline.",
      );
      for (const c of r.undeclaredCalls.slice(0, 20)) {
        this.out.log(`  ${c.file}:${c.line}  ${c.path}`);
      }
      if (r.undeclaredCalls.length > 20) {
        this.out.log(`  ... and ${r.undeclaredCalls.length - 20} more.`);
      }
    }

    const toReview = r.reviewOrder.filter((x) => x.score < REVIEW_THRESHOLD);
    if (toReview.length > 0) {
      this.out.log('');
      this.out.log(
        `${toReview.length} weakly similar match(es) -- review these first. Not ` +
          "an error: a correct match can share no word at all.",
      );
      for (const x of toReview) {
        this.out.log(`  ${x.score.toFixed(2)}  ${x.key}`);
        this.out.log(`        ${x.path}  ->  ${x.serverPath}`);
      }
    }

    this.out.log('');
    this.out.log(r.ok ? 'Nothing blocking to report.' : 'Some problems remain to fix.');
    return r;
  }
}

/** `stopped` is not a failure: it's the normal case on a first run, when only the developer can continue. */
export interface ChainStep {
  name: string;
  state: 'done' | 'stopped';
  reason?: string;
}

export interface ChainResult {
  steps: ChainStep[];
  /** The chain ran all the way through. */
  complete: boolean;
}

export interface DraftOptions {
  cwd: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  /** Overwrite an existing table. Default false: it carries a review. */
  force?: boolean;
}

export interface ChainOptions {
  cwd: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  run?: (command: string, cwd: string) => void;
  fetchSchemaFn?: SchemaOptions['fetchSchemaFn'];
  loadOperationsFn?: SchemaOptions['loadOperationsFn'];
  token?: string;
}

/** Next to the schema: both generated, never touched by hand, imported by the same wiring. */
function modulePath(cwd: string, schemaFile: string): string {
  const dir = dirname(isAbsolute(schemaFile) ? schemaFile : join(cwd, schemaFile));
  return join(dir, 'entites.ts');
}

export class Cli {
  constructor(
    private readonly out: CliOutput = consoleOutput,
    private readonly commands = new ExecuteCliCommand(out),
  ) {}

  async run(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
    const command = argv[0];

    try {
      switch (command) {
        case 'init':
          this.commands.init(cwd);
          return 0;
        case 'setup': {
          const r = await this.commands.setup({ cwd });
          return r.complete ? 0 : 1;
        }
        case 'build': {
          const r = await this.commands.build({ cwd });
          return r.complete ? 0 : 1;
        }
        case 'powersync':
          this.commands.powersync({ cwd });
          return 0;
        case 'schema':
          await this.commands.schema({ cwd });
          return 0;
        case 'scaffold':
          this.commands.scaffold({ cwd });
          return 0;
        case 'operations':
          this.commands.operations({ cwd, force: argv.includes('--force') });
          return 0;
        case 'discover':
          await this.commands.discover({ cwd });
          return 0;
        case 'check': {
          const r = await this.commands.check({ cwd });
          return r.ok ? 0 : 1;
        }
        case 'entites':
          this.commands.entites({ cwd });
          return 0;
        case 'check-entites': {
          const r = this.commands.checkEntites({ cwd });
          return r.ok ? 0 : 1;
        }
        default:
          this.out.error(
            command === undefined
              ? 'No command. Expected: setup, build -- or, one at a time: ' +
                'powersync, init, schema, scaffold, entites, check-entites, ' +
                'operations, check, discover.'
              : `Unknown command: "${command}". Expected: setup, build -- or, ` +
                'one at a time: powersync, init, schema, scaffold, entites, ' +
                'check-entites, operations, check, discover.',
          );
          return 1;
      }
    } catch (err) {
      this.out.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
}
