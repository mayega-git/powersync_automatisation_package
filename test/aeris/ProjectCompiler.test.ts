import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/aeris/ProjectCompiler.js';
import { SpringBootAdapter } from '../../src/aeris/SpringBootAdapter.js';
import { verifyAERISArtifact } from '../../src/aeris/signature.js';

const temporaryDirectories: string[] = [];

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aeris-project-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('compileProject', () => {
  it('writes a deterministic artifact and ignores generated source directories', async () => {
    const rootDir = await createProject();
    await mkdir(join(rootDir, 'src/main/java'), { recursive: true });
    await mkdir(join(rootDir, 'target/generated-sources'), { recursive: true });
    await writeFile(join(rootDir, 'src/main/java/OrderController.java'),
      '@RestController @RequestMapping("/orders") class OrderController { @GetMapping Object list() {} }');
    await writeFile(join(rootDir, 'target/generated-sources/Generated.java'), 'not valid controller source');

    const first = await compileProject({ rootDir, adapter: new SpringBootAdapter() });
    const firstContent = await readFile(first.outputFile, 'utf8');
    const second = await compileProject({ rootDir, adapter: new SpringBootAdapter() });

    expect(first.sourceFiles).toBe(1);
    expect(first.artifact.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.artifact.sourceRevision).toBe(second.artifact.sourceRevision);
    expect(await readFile(second.outputFile, 'utf8')).toBe(firstContent);
    expect(first.artifact.endpoints[0]?.policy).toBe('UNSUPPORTED');
  });

  it('signs build artifacts with Ed25519 and detects tampering', async () => {
    const rootDir = await createProject();
    const keys = generateKeyPairSync('ed25519');
    const privateKeyFile = join(rootDir, 'signing-private.pem');
    await writeFile(privateKeyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(join(rootDir, 'OrderController.java'),
      '@RestController class OrderController { @GetMapping("/orders") Object list() { return null; } }');

    const result = await compileProject({
      rootDir,
      adapter: new SpringBootAdapter(),
      signingKeyFile: privateKeyFile,
      keyId: 'ci-2026',
    });
    const envelope = JSON.parse(await readFile(result.outputFile, 'utf8')) as typeof result.signedArtifact;

    expect(result.signedArtifact?.keyId).toBe('ci-2026');
    expect(verifyAERISArtifact(envelope, keys.publicKey)).toBe(true);
    const altered = structuredClone(envelope);
    altered!.artifact.endpoints[0]!.path = '/tampered';
    expect(verifyAERISArtifact(altered, keys.publicKey)).toBe(false);
    const relabeled = structuredClone(envelope);
    relabeled!.keyId = 'other-key';
    expect(verifyAERISArtifact(relabeled, keys.publicKey)).toBe(false);
    const extended = { ...envelope, unprotectedMetadata: 'injected' };
    expect(verifyAERISArtifact(extended, keys.publicKey)).toBe(false);
    expect(verifyAERISArtifact(envelope, generateKeyPairSync('ed25519').publicKey)).toBe(false);
    expect(verifyAERISArtifact(envelope, 'not a public key')).toBe(false);
  });

  it('requires a key id whenever artifact signing is enabled', async () => {
    await expect(compileProject({
      rootDir: await createProject(),
      adapter: new SpringBootAdapter(),
      signingKeyFile: '/unused/private.pem',
    })).rejects.toThrow(/Both signingKeyFile and keyId/);
  });

  it('refuses to write the artifact outside the backend root', async () => {
    const rootDir = await createProject();
    await writeFile(join(rootDir, 'Example.java'), 'class Example {}');

    await expect(compileProject({
      rootDir,
      adapter: new SpringBootAdapter(),
      outputFile: '../outside.json',
    })).rejects.toThrow(/inside the backend source root/);
  });

  it('refuses an artifact directory redirected through a symbolic link', async () => {
    const rootDir = await createProject();
    const outsideDir = await createProject();
    await writeFile(join(rootDir, 'Example.java'), 'class Example {}');
    await symlink(outsideDir, join(rootDir, '.aeris'));

    await expect(compileProject({
      rootDir,
      adapter: new SpringBootAdapter(),
    })).rejects.toThrow(/symbolic link/);
  });

  it('fails instead of emitting an empty report when no source files exist', async () => {
    await expect(compileProject({
      rootDir: await createProject(),
      adapter: new SpringBootAdapter(),
    })).rejects.toThrow(/No \.java source files found/);
  });
});
