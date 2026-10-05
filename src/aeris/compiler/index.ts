/** AERIS Behavior Compiler (Node.js, build time). */
export { build, buildReport, renderReportHtml, SPRING_ADAPTER, type BuildOptions, type BuildReport, type BuildResult } from './build.js';
export { DEFAULT_CONFIG, globMatch, loadConfig, mergeConfig, type CompilerConfig, type ContextSource } from './config.js';
export { assemble, type AssembleInput } from './assemble.js';
export { buildVectors } from './vectors.js';
export { collectSources, fingerprint } from './project.js';
export { JavaProject, type SourceFile } from './java/model.js';
export { PersistenceModel } from './spring/persistence.js';
export { compileEndpoints, type EndpointDraft } from './spring/endpoints.js';
export { ExceptionHandlers } from './spring/errors.js';
