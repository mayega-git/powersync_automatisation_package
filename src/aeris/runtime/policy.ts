import type { JsonValue } from '../ir/types.js';

/**
 * Application-provided implementations of the backend's authorization beans,
 * e.g. `@businessAccessPolicy.hasPermission(authentication, 'products:write')`.
 * They receive the cached session claims as `authentication`.
 */
export type PolicyBeans = Readonly<Record<string, Readonly<Record<string, (...args: JsonValue[]) => boolean>>>>;

type Value = JsonValue | undefined | ((...args: Value[]) => Value) | { $claims: Record<string, JsonValue> };

class Undecidable extends Error {}

/** Granted authorities from the usual claim names. */
export function authoritiesOf(claims: Readonly<Record<string, JsonValue>>): string[] {
  const out: string[] = [];
  for (const name of ['authorities', 'permissions', 'roles', 'scope', 'scp']) {
    const value = claims[name];
    if (Array.isArray(value)) out.push(...value.filter((item): item is string => typeof item === 'string'));
    else if (typeof value === 'string') out.push(...value.split(/[\s,]+/).filter(Boolean));
  }
  return out;
}

/**
 * Evaluates a Spring Security expression subset on cached claims. Returns
 * undefined when the expression cannot be decided offline (unknown function,
 * method argument reference...): the caller must then refuse local execution.
 */
export function evaluatePolicy(expression: string, claims: Readonly<Record<string, JsonValue>>, beans: PolicyBeans = {}): boolean | undefined {
  try {
    const parser = new Parser(tokenize(expression), claims, beans);
    const value = parser.parseExpression();
    parser.expectEnd();
    if (typeof value !== 'boolean') return undefined;
    return value;
  } catch (error) {
    if (error instanceof Undecidable) return undefined;
    return undefined;
  }
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'bean';
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      let text = '';
      while (end < source.length && source[end] !== char) {
        text += source[end];
        end += 1;
      }
      if (end >= source.length) throw new Undecidable();
      tokens.push({ kind: 'string', text });
      index = end + 1;
      continue;
    }
    if (char === '@') {
      const match = /^@([A-Za-z_$][\w$]*)/.exec(source.slice(index));
      if (match === null) throw new Undecidable();
      tokens.push({ kind: 'bean', text: match[1]! });
      index += match[0].length;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (['&&', '||', '==', '!='].includes(two)) {
      tokens.push({ kind: 'punct', text: two });
      index += 2;
      continue;
    }
    if ('()!,.'.includes(char)) {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    if (name !== null) {
      tokens.push({ kind: 'name', text: name[0] });
      index += name[0].length;
      continue;
    }
    const number = /^\d+(\.\d+)?/.exec(source.slice(index));
    if (number !== null) {
      tokens.push({ kind: 'number', text: number[0] });
      index += number[0].length;
      continue;
    }
    throw new Undecidable();
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[], private readonly claims: Readonly<Record<string, JsonValue>>, private readonly beans: PolicyBeans) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private take(text?: string): Token {
    const token = this.tokens[this.index];
    if (token === undefined || (text !== undefined && token.text !== text)) throw new Undecidable();
    this.index += 1;
    return token;
  }

  expectEnd(): void {
    if (this.index !== this.tokens.length) throw new Undecidable();
  }

  parseExpression(): Value {
    let left = this.parseAnd();
    while (this.peek()?.text === 'or' || this.peek()?.text === '||') {
      this.take();
      const right = this.parseAnd();
      left = truth(left) || truth(right);
    }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseNot();
    while (this.peek()?.text === 'and' || this.peek()?.text === '&&') {
      this.take();
      const right = this.parseNot();
      left = truth(left) && truth(right);
    }
    return left;
  }

  private parseNot(): Value {
    if (this.peek()?.text === 'not' || this.peek()?.text === '!') {
      this.take();
      return !truth(this.parseNot());
    }
    return this.parseComparison();
  }

  private parseComparison(): Value {
    const left = this.parsePostfix();
    const operator = this.peek()?.text;
    if (operator === '==' || operator === '!=') {
      this.take();
      const right = this.parsePostfix();
      const equal = JSON.stringify(left) === JSON.stringify(right);
      return operator === '==' ? equal : !equal;
    }
    return left;
  }

  private parsePostfix(): Value {
    let value = this.parsePrimary();
    while (this.peek()?.text === '.') {
      this.take('.');
      const member = this.take().text;
      const args = this.peek()?.text === '(' ? this.parseArgs() : undefined;
      value = member === 'contains' && args?.length === 1
        ? (Array.isArray(value) ? value.some((item) => JSON.stringify(item) === JSON.stringify(args[0])) : typeof value === 'string' && typeof args[0] === 'string' ? value.includes(args[0]) : false)
        : this.member(value, member, args);
    }
    return value;
  }

  private member(target: Value, member: string, args: Value[] | undefined): Value {
    if (args !== undefined) throw new Undecidable();
    if (target !== null && typeof target === 'object' && !Array.isArray(target) && '$claims' in target) return (target as { $claims: Record<string, JsonValue> }).$claims[member];
    if (target !== null && typeof target === 'object' && !Array.isArray(target)) return (target as Record<string, JsonValue>)[member];
    throw new Undecidable();
  }

  private parseArgs(): Value[] {
    this.take('(');
    const args: Value[] = [];
    if (this.peek()?.text !== ')') {
      args.push(this.parseExpression());
      while (this.peek()?.text === ',') {
        this.take(',');
        args.push(this.parseExpression());
      }
    }
    this.take(')');
    return args;
  }

  private parsePrimary(): Value {
    const token = this.take();
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.text === '(') {
      const value = this.parseExpression();
      this.take(')');
      return value;
    }
    if (token.kind === 'bean') {
      this.take('.');
      const method = this.take().text;
      const args = this.parseArgs();
      const impl = this.beans[token.text]?.[method];
      if (impl === undefined) throw new Undecidable();
      return impl(...args.map((arg) => (arg !== null && typeof arg === 'object' && !Array.isArray(arg) && '$claims' in arg ? (arg as { $claims: JsonValue }).$claims : arg as JsonValue)));
    }
    if (token.kind !== 'name') throw new Undecidable();
    const authorities = authoritiesOf(this.claims);
    switch (token.text) {
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      case 'permitAll': return true;
      case 'denyAll': return false;
      case 'authentication':
      case 'principal':
        return { $claims: { ...this.claims } };
    }
    if (this.peek()?.text !== '(') throw new Undecidable();
    const args = this.parseArgs();
    const strings = args.filter((arg): arg is string => typeof arg === 'string');
    switch (token.text) {
      case 'isAuthenticated': case 'isFullyAuthenticated': return true;
      case 'isAnonymous': return false;
      case 'hasAuthority': return authorities.includes(strings[0] ?? '');
      case 'hasAnyAuthority': return strings.some((name) => authorities.includes(name));
      case 'hasRole': return authorities.includes(role(strings[0] ?? ''));
      case 'hasAnyRole': return strings.some((name) => authorities.includes(role(name)));
      case 'claim': return this.claims[strings[0] ?? ''] ?? null;
      default: throw new Undecidable();
    }
  }
}

function role(name: string): string {
  return name.startsWith('ROLE_') ? name : `ROLE_${name}`;
}

function truth(value: Value): boolean {
  if (typeof value !== 'boolean') throw new Undecidable();
  return value;
}
