import type { AdapterAnalysis } from './types.js';

export interface SourceFile {
  path: string;
  content: string;
}

export interface CompilerAdapter {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly framework: string;
  analyze(input: {
    files: readonly SourceFile[];
    sourceRevision: string;
  }): Promise<AdapterAnalysis>;
}
