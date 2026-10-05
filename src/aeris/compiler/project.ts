import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SourceFile } from './java/model.js';

/** Tool and build directories, never sources. Package names such as `out` or `test` are not excluded. */
const EXCLUDED_DIRECTORIES = new Set(['.git', '.aeris', '.gradle', '.idea', '.mvn', 'node_modules', 'target']);

/** Production sources under `rootDir` (test trees excluded), sorted for a stable fingerprint. */
export async function collectSources(rootDir: string, extension = '.java'): Promise<SourceFile[]> {
  const root = resolve(rootDir);
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Backend source root is not a regular directory: ${root}`);
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
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
  };
  await visit(root);
  // Maven/Gradle layout: production code only (src/main), never src/test.
  const conventional = paths.filter((path) => path.split(sep).join('/').includes('/src/main/'));
  const selected = conventional.length > 0 ? conventional : paths.filter((path) => !/\/(build|out)\//.test(path.split(sep).join('/').slice(root.length)));
  paths.length = 0;
  paths.push(...selected);
  if (paths.length === 0) throw new Error(`No ${extension} source files found under ${root}.`);
  return Promise.all(paths.map(async (path) => ({
    path: relative(root, path).split(sep).join('/'),
    content: await readFile(path, 'utf8'),
  })));
}

export function fingerprint(files: readonly SourceFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(String(Buffer.byteLength(file.path))).update(':').update(file.path);
    hash.update(String(Buffer.byteLength(file.content))).update(':').update(file.content);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Writes through a temporary file and rename, refusing symlinks and paths outside `rootDir`. */
export async function writeInside(rootDir: string, path: string, content: string): Promise<void> {
  const root = resolve(rootDir);
  const target = resolve(root, path);
  const relativePath = relative(root, target);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Refusing to write outside ${root}: ${target}`);
  }
  let current = root;
  for (const segment of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Output path contains a non-directory or symbolic link: ${current}`);
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
