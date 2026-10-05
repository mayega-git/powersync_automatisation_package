import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CompilerAdapter } from './CompilerAdapter.js';
import { compileAnalysis } from './compile.js';
import { signAERISArtifact } from './signature.js';
import type { AERISArtifact, AERISSignedArtifact } from './types.js';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.aeris', '.gradle', '.idea', '.mvn', 'build', 'dist',
  'node_modules', 'out', 'target',
]);

export interface ProjectCompileOptions {
  rootDir: string;
  adapter: CompilerAdapter;
  outputFile?: string;
  signingKeyFile?: string;
  keyId?: string;
}

export interface ProjectCompileResult {
  artifact: AERISArtifact;
  signedArtifact?: AERISSignedArtifact;
  sourceFiles: number;
  outputFile: string;
}

export async function compileProject(options: ProjectCompileOptions): Promise<ProjectCompileResult> {
  if ((options.signingKeyFile === undefined) !== (options.keyId === undefined)) {
    throw new Error('Both signingKeyFile and keyId are required to sign an AERIS artifact.');
  }
  if (options.keyId !== undefined && !options.keyId.trim()) {
    throw new Error('AERIS signing key id must not be empty.');
  }
  const rootDir = resolve(options.rootDir);
  const rootStats = await lstat(rootDir);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Backend source root is not a regular directory: ${rootDir}`);
  }

  const extension = options.adapter.language === 'java' ? '.java' : undefined;
  if (extension === undefined) {
    throw new Error(`Project scanning is not configured for ${options.adapter.language}.`);
  }

  const files = await collectSourceFiles(rootDir, extension);
  if (files.length === 0) {
    throw new Error(`No ${extension} source files found under ${rootDir}.`);
  }

  const sourceRevision = fingerprint(files);
  const analysis = await options.adapter.analyze({ files, sourceRevision });
  const artifact = compileAnalysis(analysis);
  const signedArtifact = options.signingKeyFile === undefined
    ? undefined
    : signAERISArtifact(
      artifact,
      await readFile(resolve(options.signingKeyFile), 'utf8'),
      options.keyId!,
    );
  const outputFile = resolve(rootDir, options.outputFile ?? '.aeris/aeris-ir.json');
  const outputRelative = relative(rootDir, outputFile);
  if (outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)) {
    throw new Error('AERIS artifact output must be inside the backend source root.');
  }

  await writeAtomically(rootDir, outputFile, `${JSON.stringify(signedArtifact ?? artifact, null, 2)}\n`);
  return {
    artifact,
    ...(signedArtifact === undefined ? {} : { signedArtifact }),
    sourceFiles: files.length,
    outputFile,
  };
}

async function collectSourceFiles(rootDir: string, extension: string) {
  const paths: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        paths.push(fullPath);
      }
    }
  }

  await visit(rootDir);
  return Promise.all(paths.map(async (path) => ({
    path: relative(rootDir, path).split(sep).join('/'),
    content: await readFile(path, 'utf8'),
  })));
}

function fingerprint(files: readonly { path: string; content: string }[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(String(Buffer.byteLength(file.path))).update(':').update(file.path);
    hash.update(String(Buffer.byteLength(file.content))).update(':').update(file.content);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function writeAtomically(rootDir: string, path: string, content: string): Promise<void> {
  await ensureOutputDirectory(rootDir, dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureOutputDirectory(rootDir: string, outputDirectory: string): Promise<void> {
  const directoryRelative = relative(rootDir, outputDirectory);
  let current = rootDir;
  for (const segment of directoryRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`AERIS output path contains a non-directory or symbolic link: ${current}`);
    }
  }
}
