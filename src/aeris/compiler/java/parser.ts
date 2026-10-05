import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

export type SyntaxNode = Node;

let parser: Parser | undefined;

/** Lazily initialized tree-sitter Java parser (WebAssembly, no native build). */
export async function javaParser(): Promise<Parser> {
  if (parser !== undefined) return parser;
  const require = createRequire(import.meta.url);
  await Parser.init();
  const language = await Language.load(require.resolve('tree-sitter-java/tree-sitter-java.wasm'));
  parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export function named(node: SyntaxNode | null | undefined): SyntaxNode[] {
  if (node == null) return [];
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

export function field(node: SyntaxNode | null | undefined, name: string): SyntaxNode | undefined {
  return node?.childForFieldName(name) ?? undefined;
}

export function fields(node: SyntaxNode | null | undefined, name: string): SyntaxNode[] {
  if (node == null) return [];
  return node.childrenForFieldName(name).filter((child): child is SyntaxNode => child !== null);
}

export function childrenOfType(node: SyntaxNode | null | undefined, ...types: string[]): SyntaxNode[] {
  return named(node).filter((child) => types.includes(child.type));
}

export function firstOfType(node: SyntaxNode | null | undefined, ...types: string[]): SyntaxNode | undefined {
  return childrenOfType(node, ...types)[0];
}

/** Decodes a Java string literal node (including text blocks) to its value. */
export function stringValue(node: SyntaxNode): string | undefined {
  if (node.type !== 'string_literal') return undefined;
  const raw = node.text;
  if (raw.startsWith('"""')) {
    const body = raw.slice(3, -3).replace(/^[ \t]*\r?\n/, '');
    const lines = body.split('\n');
    const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => /^[ \t]*/.exec(line)![0].length));
    return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n').replace(/\n[ \t]*$/, '');
  }
  return unescapeJava(raw.slice(1, -1));
}

function unescapeJava(text: string): string {
  return text.replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_match, escape: string) => {
    if (escape.startsWith('u')) return String.fromCharCode(parseInt(escape.replace(/^u+/, ''), 16));
    if (/^[0-7]+$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    switch (escape) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 's': return ' ';
      default: return escape;
    }
  });
}
