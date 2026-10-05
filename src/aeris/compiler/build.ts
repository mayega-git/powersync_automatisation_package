import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importPrivateKeyPem, signArtifact } from '../ir/signing.js';
import { LOCAL_CLASSES, OFFLINE_CLASSES, type AerisArtifact, type AerisSignedArtifact, type OfflineClass } from '../ir/types.js';
import { assemble } from './assemble.js';
import { loadConfig, type CompilerConfig } from './config.js';
import { JavaProject } from './java/model.js';
import { collectSources, fingerprint, writeInside } from './project.js';
import { compileEndpoints } from './spring/endpoints.js';
import { ExceptionHandlers } from './spring/errors.js';
import { PersistenceModel } from './spring/persistence.js';
import { buildVectors } from './vectors.js';
import { checkProjections, readConstraints } from './schema-check.js';

export const SPRING_ADAPTER = { id: 'aeris.spring-boot', version: '1.0.0', language: 'java', framework: 'spring-boot-webflux' };

export interface BuildOptions {
  rootDir: string;
  /** Defaults to <root>/aeris.config.yaml when present. */
  configPath?: string;
  config?: CompilerConfig;
  /** Output directory, relative to the root (default .aeris). */
  outputDir?: string;
  signingKeyPem?: string;
  keyId?: string;
  sourceCommit?: string;
  /** Write files (default true). */
  write?: boolean;
  /** Live database to check projections against (recommended in CI). */
  databaseUrl?: string;
}

export interface BuildReport {
  generatedAt: string;
  artifactVersion: number;
  sourceRevision: string;
  sourceFiles: number;
  durationMs: number;
  endpoints: number;
  byClass: Record<OfflineClass, number>;
  offlineCapable: number;
  projections: { entity: string; table: string; scope: string[]; public: boolean }[];
  topBlockers: { reason: string; endpoints: number }[];
  details: { id: string; class: OfflineClass; reasons: readonly string[]; handler: string }[];
  diagnostics: readonly string[];
}

export interface BuildResult {
  artifact: AerisArtifact;
  signed?: AerisSignedArtifact;
  report: BuildReport;
  outputs: string[];
}

/** Analyzes a Spring Boot backend and produces the AERIS artifact, its signature and a report. */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const rootDir = resolve(options.rootDir);
  const config = options.config ?? await loadConfig(options.configPath ?? resolve(rootDir, 'aeris.config.yaml'));
  const outputDir = options.outputDir ?? '.aeris';
  const files = await collectSources(rootDir);
  const sourceRevision = fingerprint(files);
  const project = await JavaProject.load(files, config.activeProfiles);
  const persistence = new PersistenceModel(project);
  const diagnostics = [...project.diagnostics];
  for (const type of project.types.values()) {
    if (type.kind !== 'class' || !project.profileActive(type)) continue;
    const supertypes = project.supertypeNames(type);
    if (supertypes.has('org.springframework.web.server.WebFilter') || supertypes.has('WebFilter')) {
      diagnostics.push(`filter: ${type.simple} (${type.file.path}) runs before handlers and is not analyzed; if it can reject requests, declare an equivalent in requestGates.`);
    }
  }
  const drafts = compileEndpoints({ project, persistence, config, handlers: new ExceptionHandlers(project) }, diagnostics);
  let previous: AerisArtifact | undefined;
  try {
    previous = JSON.parse(await readFile(resolve(rootDir, outputDir, 'aeris-artifact.json'), 'utf8')) as AerisArtifact;
  } catch {
    previous = undefined;
  }
  let assembled = assemble({
    drafts, config, adapter: SPRING_ADAPTER, sourceRevision, diagnostics, previous,
    ...(options.sourceCommit === undefined ? {} : { sourceCommit: options.sourceCommit }),
  });
  if (options.databaseUrl !== undefined) {
    // Projections of every compiled entity, so constraints are known for all of them.
    const unavailableEntities = await checkProjections(options.databaseUrl, assembled.projections);
    for (const [entity, problem] of unavailableEntities) diagnostics.push(`schema: ${entity}: ${problem}`);
    const allEntities = assemble({ drafts, config, adapter: SPRING_ADAPTER, sourceRevision, diagnostics: [], previous });
    const constraints = await readConstraints(options.databaseUrl, allEntities.projections);
    assembled = assemble({
      drafts, config, adapter: SPRING_ADAPTER, sourceRevision, diagnostics: [...diagnostics], previous, unavailableEntities, constraints,
      ...(options.sourceCommit === undefined ? {} : { sourceCommit: options.sourceCommit }),
    });
  }
  const vectors = await buildVectors(assembled);
  const byEndpoint = new Map<string, string[]>();
  for (const vector of vectors) byEndpoint.set(vector.endpoint, [...(byEndpoint.get(vector.endpoint) ?? []), vector.id]);
  const artifact: AerisArtifact = {
    ...assembled,
    testVectors: vectors,
    endpoints: assembled.endpoints.map((plan) => ({ ...plan, testVectors: byEndpoint.get(plan.id) ?? [] })),
  };

  let signed: AerisSignedArtifact | undefined;
  if (options.signingKeyPem !== undefined) {
    if (options.keyId === undefined) throw new Error('A key id is required to sign the artifact.');
    signed = await signArtifact(artifact, await importPrivateKeyPem(options.signingKeyPem), options.keyId);
  }
  const report = buildReport(artifact, files.length, Date.now() - started);
  const outputs: string[] = [];
  if (options.write !== false) {
    const write = async (name: string, content: string) => {
      await writeInside(rootDir, `${outputDir}/${name}`, content);
      outputs.push(resolve(rootDir, outputDir, name));
    };
    await write('aeris-artifact.json', `${JSON.stringify(artifact, null, 2)}\n`);
    if (signed !== undefined) await write('aeris-artifact.signed.json', `${JSON.stringify(signed)}\n`);
    await write('aeris-report.json', `${JSON.stringify(report, null, 2)}\n`);
    await write('aeris-report.html', renderReportHtml(report));
  }
  return { artifact, ...(signed === undefined ? {} : { signed }), report, outputs };
}

export function buildReport(artifact: AerisArtifact, sourceFiles: number, durationMs: number): BuildReport {
  const byClass = Object.fromEntries(OFFLINE_CLASSES.map((name) => [name, 0])) as Record<OfflineClass, number>;
  const blockers = new Map<string, number>();
  for (const plan of artifact.endpoints) {
    byClass[plan.offlineClass] += 1;
    if (!LOCAL_CLASSES.has(plan.offlineClass)) {
      const reason = (plan.reasons[0] ?? 'unknown').replace(/\s*\([^()]*:\d+\)$/, '');
      blockers.set(reason, (blockers.get(reason) ?? 0) + 1);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    artifactVersion: artifact.artifactVersion,
    sourceRevision: artifact.sourceRevision,
    sourceFiles,
    durationMs,
    endpoints: artifact.endpoints.length,
    byClass,
    offlineCapable: artifact.endpoints.filter((plan) => LOCAL_CLASSES.has(plan.offlineClass)).length,
    projections: artifact.projections.map((projection) => ({
      entity: projection.entity,
      table: `${projection.schema === undefined ? '' : `${projection.schema}.`}${projection.table}`,
      scope: projection.scope.map((filter) => `${filter.field} = session.${filter.value?.k === 'ctx' ? filter.value.name : '?'}`),
      public: projection.public,
    })),
    topBlockers: [...blockers].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([reason, endpoints]) => ({ reason, endpoints })),
    details: artifact.endpoints.map((plan) => ({ id: plan.id, class: plan.offlineClass, reasons: plan.reasons, handler: plan.handler.symbol })),
    diagnostics: artifact.diagnostics,
  };
}

const CLASS_COLORS: Record<OfflineClass, string> = {
  LOCAL_READ_SAFE: '#1f8a4c', LOCAL_WRITE_SAFE: '#1f8a4c', REPLAYABLE: '#2b6cb0', SPECULATIVE: '#b7791f', ONLINE_REQUIRED: '#718096', UNSUPPORTED: '#c53030',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** A self-contained HTML report (no external resources). */
export function renderReportHtml(report: BuildReport): string {
  const rows = report.details.map((detail) => `<tr data-class="${detail.class}"><td><code>${escapeHtml(detail.id)}</code></td><td><span class="badge" style="background:${CLASS_COLORS[detail.class]}">${detail.class}</span></td><td>${escapeHtml(detail.reasons[0] ?? '')}</td><td><code>${escapeHtml(detail.handler)}</code></td></tr>`).join('\n');
  const classes = Object.entries(report.byClass).map(([name, count]) => `<div class="tile"><div class="n">${count}</div><div class="l">${name}</div></div>`).join('');
  const blockers = report.topBlockers.map((blocker) => `<tr><td>${blocker.endpoints}</td><td>${escapeHtml(blocker.reason)}</td></tr>`).join('');
  const projections = report.projections.map((projection) => `<tr><td><code>${escapeHtml(projection.table)}</code></td><td>${projection.public ? 'public' : escapeHtml(projection.scope.join(', '))}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AERIS report</title>
<style>
:root{--bg:#fff;--fg:#1a202c;--muted:#718096;--line:#e2e8f0}
@media (prefers-color-scheme: dark){:root{--bg:#171923;--fg:#e2e8f0;--muted:#a0aec0;--line:#2d3748}}
body{font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px;max-width:1200px;margin-inline:auto}
h1{margin:0 0 4px}.meta{color:var(--muted);margin-bottom:24px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.tile{border:1px solid var(--line);border-radius:8px;padding:12px}.n{font-size:28px;font-weight:700}.l{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;margin-bottom:32px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.badge{color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap}code{font-size:12px;word-break:break-all}
input{width:100%;padding:8px;margin-bottom:12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.wrap{overflow-x:auto}
</style></head><body>
<h1>AERIS offline compatibility</h1>
<div class="meta">Artifact v${report.artifactVersion} · ${report.endpoints} endpoints · ${report.offlineCapable} usable offline · ${report.sourceFiles} source files · ${new Date(report.generatedAt).toUTCString()}</div>
<div class="tiles">${classes}</div>
<h2>Projections (data kept on devices)</h2><div class="wrap"><table><tr><th>Table</th><th>Rows kept</th></tr>${projections}</table></div>
<h2>Main reasons endpoints stay online</h2><div class="wrap"><table><tr><th>Endpoints</th><th>Reason</th></tr>${blockers}</table></div>
<h2>Endpoints</h2><input id="q" placeholder="Filter endpoints, classes or reasons…">
<div class="wrap"><table id="t"><tr><th>Endpoint</th><th>Class</th><th>Reason</th><th>Handler</th></tr>${rows}</table></div>
<script>document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const r of document.querySelectorAll('#t tr[data-class]'))r.style.display=r.textContent.toLowerCase().includes(q)?'':'none'});</script>
</body></html>
`;
}
