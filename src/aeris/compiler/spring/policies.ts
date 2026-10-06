import type { Expr, Instr } from '../../ir/types.js';
import { stringValue } from '../java/parser.js';
import type { TypeDecl } from '../java/model.js';
import { attempt, foldPureInstrs } from './branching.js';
import type { Evaluator, Scope } from './evaluator.js';
import { and, Block, Env, FALSE, lit, not, obj, op, or, pure, T, TRUE, Unsupported, type SV } from './sv.js';
import { fieldTypeOf } from './persistence.js';

const BEAN_ANNOTATIONS = new Set(['Component', 'Service', 'Repository', 'Configuration']);

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'bean';
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "'" || char === '"') {
      const end = source.indexOf(char, index + 1);
      if (end < 0) throw new Unsupported('Unterminated string in authorization expression');
      tokens.push({ kind: 'string', text: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === '@') {
      const match = /^@([A-Za-z_$][\w$]*)/.exec(source.slice(index));
      if (match === null) throw new Unsupported('Malformed bean reference');
      tokens.push({ kind: 'bean', text: match[1]! });
      index += match[0].length;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (['&&', '||', '==', '!='].includes(two)) { tokens.push({ kind: 'punct', text: two }); index += 2; continue; }
    if ('()!,.'.includes(char)) { tokens.push({ kind: 'punct', text: char }); index += 1; continue; }
    const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    if (name !== null) { tokens.push({ kind: 'name', text: name[0] }); index += name[0].length; continue; }
    const number = /^\d+/.exec(source.slice(index));
    if (number !== null) { tokens.push({ kind: 'number', text: number[0] }); index += number[0].length; continue; }
    throw new Unsupported(`Unexpected character ${char} in authorization expression`);
  }
  return tokens;
}

/**
 * Compiles a Spring Security expression (@PreAuthorize) into a boolean IR
 * expression over session claims, by executing the referenced policy beans
 * symbolically. Returns undefined when any part cannot be compiled exactly.
 */
export function compilePolicy(expression: string, ev: Evaluator): Expr | undefined {
  const authenticationType = ev.config.context.authentication;
  try {
    const tokens = tokenize(expression);
    let index = 0;
    const peek = () => tokens[index];
    const take = (text?: string) => {
      const token = tokens[index];
      if (token === undefined || (text !== undefined && token.text !== text)) throw new Unsupported(`Expected ${text ?? 'a token'} in ${expression}`);
      index += 1;
      return token;
    };
    const authorities: Expr = op('coalesce', { k: 'ctx', name: ev.config.context.authoritiesClaim ?? 'authorities' }, lit([]));
    const authentication = (): SV => {
      if (authenticationType === undefined) throw new Unsupported('No authentication class configured');
      const decl = ev.project.type(authenticationType);
      if (decl === undefined) throw new Unsupported(`Authentication class ${authenticationType} not found`);
      const fields = new Map<string, SV>();
      for (const property of ev.properties(decl.fqn)) {
        if (fieldTypeOf(ev.project, property.jt) !== undefined) fields.set(property.name, pure({ k: 'ctx', name: property.name }, property.jt));
      }
      return obj(decl.fqn, fields);
    };
    const asBool = (sv: SV): Expr => {
      if (sv.t !== 'pure') throw new Unsupported('Authorization operand is not boolean');
      return sv.e;
    };
    const parseArgs = (): SV[] => {
      take('(');
      const args: SV[] = [];
      if (peek()?.text !== ')') {
        args.push(parseOr());
        while (peek()?.text === ',') { take(','); args.push(parseOr()); }
      }
      take(')');
      return args;
    };
    const parsePrimary = (): SV => {
      const token = take();
      if (token.kind === 'string') return pure(lit(token.text), T.string);
      if (token.kind === 'number') return pure(lit(Number(token.text)), T.int);
      if (token.text === '(') {
        const value = parseOr();
        take(')');
        return value;
      }
      if (token.kind === 'bean') {
        take('.');
        const method = take().text;
        const args = parseArgs();
        const bean = findBean(ev, token.text);
        if (bean === undefined) throw new Unsupported(`Bean @${token.text} not found`);
        const candidates = ev.project.methodsOf(bean, method).filter((candidate) => candidate.params.length === args.length);
        if (candidates.length !== 1) throw new Unsupported(`@${token.text}.${method} is ambiguous or missing`);
        const block = new Block({ vars: 0, uuidSlots: 0 });
        const scope: Scope = { env: new Env(), self: { t: 'bean', cls: bean }, owner: bean, block };
        const probe = attempt(block, (child) => ev.inline(candidates[0]!, { t: 'bean', cls: bean }, args, bean.node, { ...scope, block: child }));
        if (!probe.outcome.ok) throw new Unsupported(`@${token.text}.${method} cannot be evaluated`);
        return inlineLets(probe.instrs, probe.outcome.value);
      }
      if (token.kind !== 'name') throw new Unsupported(`Unexpected ${token.text}`);
      switch (token.text) {
        case 'true': case 'permitAll': return pure(TRUE, T.boolean);
        case 'false': case 'denyAll': return pure(FALSE, T.boolean);
        case 'authentication': case 'principal': return authentication();
      }
      const args = parseArgs();
      const strings = args.map((arg) => (arg.t === 'pure' && arg.e.k === 'lit' && typeof arg.e.v === 'string' ? arg.e.v : undefined));
      if (strings.some((value) => value === undefined)) {
        if (!['isAuthenticated', 'isFullyAuthenticated', 'isAnonymous'].includes(token.text)) throw new Unsupported(`${token.text} with dynamic arguments`);
      }
      const has = (name: string) => op('contains', authorities, lit(name));
      const role = (name: string) => (name.startsWith('ROLE_') ? name : `ROLE_${name}`);
      switch (token.text) {
        case 'isAuthenticated': case 'isFullyAuthenticated': return pure(TRUE, T.boolean);
        case 'isAnonymous': return pure(FALSE, T.boolean);
        case 'hasAuthority': return pure(has(strings[0]!), T.boolean);
        case 'hasAnyAuthority': return pure(or(...strings.map((name) => has(name!))), T.boolean);
        case 'hasRole': return pure(has(role(strings[0]!)), T.boolean);
        case 'hasAnyRole': return pure(or(...strings.map((name) => has(role(name!)))), T.boolean);
        default: throw new Unsupported(`Function ${token.text} in authorization expression`);
      }
    };
    const parseNot = (): SV => {
      if (peek()?.text === 'not' || peek()?.text === '!') {
        take();
        return pure(not(asBool(parseNot())), T.boolean);
      }
      return parsePrimary();
    };
    const parseAnd = (): SV => {
      let left = parseNot();
      while (peek()?.text === 'and' || peek()?.text === '&&') {
        take();
        left = pure(and(asBool(left), asBool(parseNot())), T.boolean);
      }
      return left;
    };
    function parseOr(): SV {
      let left = parseAnd();
      while (peek()?.text === 'or' || peek()?.text === '||') {
        take();
        left = pure(or(asBool(left), asBool(parseAnd())), T.boolean);
      }
      return left;
    }
    const result = parseOr();
    if (index !== tokens.length) throw new Unsupported('Trailing tokens in authorization expression');
    if (result.t !== 'pure') return undefined;
    return result.e;
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}

/** A policy check is a single expression: folds the pure instructions of the bean call into its result. */
function inlineLets(instrs: readonly Instr[], value: SV): SV {
  if (instrs.length === 0) return value;
  if (value.t !== 'pure') throw new Unsupported('Authorization operand is not boolean');
  return { ...value, e: foldPureInstrs(instrs, [value.e])[0]! };
}

function findBean(ev: Evaluator, name: string): TypeDecl | undefined {
  const matches: TypeDecl[] = [];
  for (const type of ev.project.types.values()) {
    const annotation = type.annotations.find((candidate) => BEAN_ANNOTATIONS.has(candidate.name));
    if (annotation === undefined || !ev.project.profileActive(type)) continue;
    const explicit = annotation.args.get('value');
    const beanName = explicit === undefined ? type.simple.charAt(0).toLowerCase() + type.simple.slice(1) : stringValue(explicit);
    if (beanName === name) matches.push(type);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
