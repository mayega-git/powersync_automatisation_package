import type { Expr } from '../../ir/types.js';
import type { JType } from '../java/model.js';
import type { SyntaxNode } from '../java/parser.js';
import { attempt, branch, foldPureInstrs, mergeEmission, pureValue } from './branching.js';
import { fieldTypeOf } from './persistence.js';
import { mapElements } from './reactive.js';
import type { Evaluator, Scope } from './evaluator.js';
import {
  and,
  cond,
  FALSE,
  isLit,
  lit,
  not,
  NULL,
  op,
  pure,
  T,
  TRUE,
  Unsupported,
  VOID,
  vr,
  type Emission,
  type ExceptionSV,
  type FluxSV,
  type ListSV,
  type MonoSV,
  type SV,
} from './sv.js';

/** org.springframework.http.HttpStatus constant names -> codes. */
export const HTTP_STATUS: Readonly<Record<string, number>> = {
  CONTINUE: 100, OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, RESET_CONTENT: 205, PARTIAL_CONTENT: 206,
  MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304, TEMPORARY_REDIRECT: 307, PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406, REQUEST_TIMEOUT: 408, CONFLICT: 409, GONE: 410, LENGTH_REQUIRED: 411, PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, UNPROCESSABLE_ENTITY: 422, UNPROCESSABLE_CONTENT: 422, LOCKED: 423,
  FAILED_DEPENDENCY: 424, PRECONDITION_REQUIRED: 428, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
};

const HTTP_STATUS_TYPE: JType = { name: 'org.springframework.http.HttpStatus', args: [], array: 0 };

const TEMPORAL_NOW: Readonly<Record<string, 'datetime' | 'datetime-local' | 'date'>> = {
  'java.time.LocalDateTime': 'datetime-local',
  'java.time.Instant': 'datetime',
  'java.time.LocalDate': 'date',
  'java.time.OffsetDateTime': 'datetime',
  'java.time.ZonedDateTime': 'datetime',
};

function simple(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf('.') + 1);
}

function scalar(sv: SV | undefined, what: string, node: SyntaxNode): Expr {
  if (sv === undefined) throw new Unsupported(`${what}: missing argument`, node);
  if (sv.t === 'pure') return sv.e;
  if (sv.t === 'list') return sv.e;
  throw new Unsupported(`${what}: argument is ${sv.t}, not a value`, node);
}

function mono(elem: JType, run: MonoSV['run']): MonoSV {
  return { t: 'mono', elem, run };
}

function listOf(ev: Evaluator, items: SV[], elem: JType): ListSV {
  return { t: 'list', e: { k: 'list', items: items.map((item) => ev.encode(item)) }, elem, element: (item) => ev.view(item, elem) };
}

/** Static fields of library types (HttpStatus.X, BigDecimal.ZERO, Boolean.TRUE...). */
const TEXT_SAFE = new Set(['java.lang.String', 'java.util.UUID', 'int', 'long', 'short', 'byte', 'java.lang.Integer', 'java.lang.Long',
  'java.lang.Short', 'java.lang.Byte', 'boolean', 'java.lang.Boolean', 'java.time.YearMonth']);
const INTEGRAL = new Set(['int', 'long', 'short', 'byte', 'java.lang.Integer', 'java.lang.Long', 'java.lang.Short', 'java.lang.Byte']);

/** Left-pads `text` with `pad` up to `width` characters (never truncates), like Formatter widths. */
function padded(text: Expr, width: number, pad: string): Expr {
  let result: Expr = text;
  for (let length = width - 1; length >= 0; length -= 1) {
    result = cond(op('eq', op('length', text), lit(length)), op('concat', lit(pad.repeat(width - length)), text), result);
  }
  return result;
}

/**
 * String.format with a constant pattern: %s (values whose text form is
 * unambiguous), %d / %0Nd / %Nd (integers), %% and %n. Anything else is refused.
 */
function formatString(pattern: SV | undefined, values: SV[], node: SyntaxNode): Expr {
  if (pattern?.t !== 'pure' || pattern.e.k !== 'lit' || typeof pattern.e.v !== 'string') throw new Unsupported('String.format() with a non-constant pattern', node);
  const parts: Expr[] = [];
  let next = 0;
  const text = pattern.e.v;
  const spec = /%(0?)(\d*)([sdn%])/g;
  let last = 0;
  for (const match of text.matchAll(spec)) {
    const literal = text.slice(last, match.index);
    if (/%/.test(literal)) throw new Unsupported(`String.format() conversion in "${text}" is not modeled`, node);
    if (literal.length > 0) parts.push(lit(literal));
    last = match.index! + match[0].length;
    const [, zero, widthText, conversion] = match;
    if (conversion === '%') { parts.push(lit('%')); continue; }
    if (conversion === 'n') { parts.push(lit('\n')); continue; }
    const value = values[next];
    next += 1;
    if (value?.t !== 'pure') throw new Unsupported('String.format() argument is not a value', node);
    const width = widthText === '' ? 0 : Number(widthText);
    if (conversion === 's') {
      if (zero === '0') throw new Unsupported('%0s is invalid in String.format()', node);
      const enumType = value.jt.name;
      if (!TEXT_SAFE.has(enumType)) throw new Unsupported(`String.format("%s") of ${enumType} depends on its toString()`, node);
      parts.push(width > 0 ? padded(op('concat', lit(''), value.e), width, ' ') : op('concat', lit(''), value.e));
      continue;
    }
    if (!INTEGRAL.has(value.jt.name)) throw new Unsupported(`String.format("%d") of ${value.jt.name}`, node);
    const digits = op('concat', lit(''), value.e);
    if (width === 0) { parts.push(digits); continue; }
    if (zero === '0') {
      // %0Nd: the sign comes first, zeros fill up to N characters in total (boxed nulls print differently: refused).
      if (!['int', 'long', 'short', 'byte'].includes(value.jt.name)) throw new Unsupported('String.format("%0Nd") of a nullable integer', node);
      const magnitude = op('concat', lit(''), op('abs', value.e));
      parts.push(cond(op('lt', value.e, lit(0)), op('concat', lit('-'), padded(magnitude, width - 1, '0')), padded(magnitude, width, '0')));
    } else {
      parts.push(padded(digits, width, ' '));
    }
  }
  const tail = text.slice(last);
  if (/%/.test(tail)) throw new Unsupported(`String.format() conversion in "${text}" is not modeled`, node);
  if (tail.length > 0) parts.push(lit(tail));
  if (next !== values.length) throw new Unsupported('String.format() argument count does not match the pattern', node);
  return parts.length === 0 ? lit('') : parts.length === 1 ? op('concat', lit(''), parts[0]!) : op('concat', ...parts);
}

/** java.time.YearMonth values are their ISO text "uuuu-MM". */
const YEAR_MONTH: JType = { name: 'java.time.YearMonth', args: [], array: 0 };

/** java.math.MathContext values are compile-time constants "mc:<precision>:<mode>". */
const MATH_CONTEXT: JType = { name: 'java.math.MathContext', args: [], array: 0 };

function mathContext(sv: SV | undefined): { precision: number; mode: string } | undefined {
  if (sv?.t !== 'pure' || sv.e.k !== 'lit' || typeof sv.e.v !== 'string') return undefined;
  const match = /^mc:(\d+):([A-Z_]+)$/.exec(sv.e.v);
  return match === null ? undefined : { precision: Number(match[1]), mode: match[2]! };
}

export function libraryStaticField(fqn: string, name: string): SV | undefined {
  switch (simple(fqn)) {
    case 'HttpStatus':
      return HTTP_STATUS[name] === undefined ? undefined : pure(lit(HTTP_STATUS[name]!), HTTP_STATUS_TYPE);
    case 'BigDecimal': {
      const values: Record<string, number> = { ZERO: 0, ONE: 1, TWO: 2, TEN: 10 };
      return values[name] === undefined ? undefined : pure(lit(values[name]!), { name: 'java.math.BigDecimal', args: [], array: 0 });
    }
    case 'Boolean':
      return name === 'TRUE' || name === 'FALSE' ? pure(lit(name === 'TRUE'), { name: 'java.lang.Boolean', args: [], array: 0 }) : undefined;
    case 'Direction':
      return name === 'ASC' || name === 'DESC' ? pure(lit(`direction:${name}`), T.string) : undefined;
    case 'String':
      return name === 'CASE_INSENSITIVE_ORDER' ? { t: 'comparator', keys: [{ fn: undefined, desc: false, nulls: 'error', caseInsensitive: true }] } : undefined;
    case 'Integer':
      if (name === 'MAX_VALUE') return pure(lit(2147483647), T.int);
      if (name === 'MIN_VALUE') return pure(lit(-2147483648), T.int);
      return undefined;
    case 'StringUtils':
      return name === 'EMPTY' ? pure(lit(''), T.string) : undefined;
    case 'MathContext': {
      const contexts: Record<string, string> = { DECIMAL32: 'mc:7:HALF_EVEN', DECIMAL64: 'mc:16:HALF_EVEN', DECIMAL128: 'mc:34:HALF_EVEN', UNLIMITED: 'mc:0:HALF_UP' };
      return contexts[name] === undefined ? undefined : pure(lit(contexts[name]!), MATH_CONTEXT);
    }
    case 'RoundingMode':
      return ['UP', 'DOWN', 'CEILING', 'FLOOR', 'HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UNNECESSARY'].includes(name)
        ? pure(lit(name), { name: 'java.math.RoundingMode', args: [], array: 0 })
        : undefined;
    case 'DateTimeFormatter':
      // Only the ISO constants whose grammar is fixed; `ofPattern` stays online.
      return name === 'ISO_LOCAL_DATE' || name === 'ISO_LOCAL_DATE_TIME'
        ? pure(lit(`formatter:${name}`), { name: 'java.time.format.DateTimeFormatter', args: [], array: 0 })
        : undefined;
    case 'Locale':
      return ['ROOT', 'ENGLISH', 'US', 'UK', 'FRENCH', 'FRANCE', 'GERMAN', 'CANADA', 'CANADA_FRENCH'].includes(name)
        ? pure(lit(`locale:${name}`), { name: 'java.util.Locale', args: [], array: 0 })
        : undefined;
    default:
      return undefined;
  }
}

export function libraryStatic(ev: Evaluator, fqn: string, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  const type = simple(fqn);
  const arg = (index: number, what = `${type}.${name}`) => scalar(args[index], what, node);
  switch (type) {
    case 'System':
      if (name === 'currentTimeMillis' && args.length === 0) return pure({ k: 'now', type: 'epoch-millis' }, T.long);
      break;
    case 'YearMonth':
      if (name === 'parse' && args.length === 1) {
        // YearMonth.parse(text): ISO "uuuu-MM"; null -> NullPointerException, anything else -> DateTimeParseException.
        const text = arg(0);
        scope.block.emit({ op: 'ASSERT', test: op('notNull', text), error: ev.errors.map({ t: 'exception', cls: 'java.lang.NullPointerException', message: lit('text') }) });
        scope.block.emit({
          op: 'ASSERT',
          test: op('matches', text, lit('(-?\\d{4}|[+-]\\d{5,9})-(0[1-9]|1[0-2])')),
          error: ev.errors.map({ t: 'exception', cls: 'java.time.format.DateTimeParseException', message: op('concat', op('concat', lit("Text '"), text), lit("' could not be parsed at index 0")) }),
        });
        return pure(text, YEAR_MONTH);
      }
      break;
    case 'MathContext':
      if (name === '<init>' && (args.length === 1 || args.length === 2)) {
        const precision = args[0]!.t === 'pure' && args[0].e.k === 'lit' ? args[0].e.v : undefined;
        const mode = args.length === 2 ? (args[1]!.t === 'pure' && args[1].e.k === 'lit' ? args[1].e.v : undefined) : 'HALF_UP';
        if (typeof precision === 'number' && Number.isInteger(precision) && precision >= 0 && typeof mode === 'string') {
          return pure(lit(`mc:${precision}:${mode}`), MATH_CONTEXT);
        }
      }
      break;
    case 'Mono':
      return monoStatic(ev, name, args, node, scope);
    case 'Flux':
      return fluxStatic(ev, name, args, node, scope);
    case 'UUID':
      if (name === 'randomUUID' && args.length === 0) {
        const slot = ev.counters.uuidSlots;
        ev.counters.uuidSlots += 1;
        return pure({ k: 'uuid', slot }, T.uuid);
      }
      if (name === 'fromString' && args.length === 1) return pure({ k: 'cast', to: 'uuid', of: arg(0) }, T.uuid);
      break;
    case 'LocalDateTime':
    case 'Instant':
    case 'LocalDate':
    case 'OffsetDateTime':
    case 'ZonedDateTime': {
      const kind = TEMPORAL_NOW[fqn] ?? TEMPORAL_NOW[`java.time.${type}`];
      // LocalDate.parse / LocalDateTime.parse, either in their one-argument
      // form or with the matching ISO formatter -- which is what the
      // one-argument form uses, so the two are the same program. The guard is
      // a real parse, calendar included (`isoTemporal`), so a text the backend
      // rejects is rejected here with the backend's own exception. Any other
      // formatter has a grammar of its own and stays online.
      if (name === 'parse' && (type === 'LocalDate' || type === 'LocalDateTime') && (args.length === 1 || args.length === 2)) {
        const expected = type === 'LocalDate' ? 'local-date' : 'local-datetime';
        const formatter = args.length === 2 ? arg(1) : undefined;
        const iso = type === 'LocalDate' ? 'formatter:ISO_LOCAL_DATE' : 'formatter:ISO_LOCAL_DATE_TIME';
        if (formatter !== undefined && !(formatter.k === 'lit' && formatter.v === iso)) break;
        const text = arg(0);
        scope.block.emit({ op: 'ASSERT', test: op('notNull', text), error: ev.errors.map({ t: 'exception', cls: 'java.lang.NullPointerException', message: lit('text') }) });
        scope.block.emit({
          op: 'ASSERT',
          test: op('isoTemporal', text, lit(expected)),
          error: ev.errors.map({ t: 'exception', cls: 'java.time.format.DateTimeParseException', message: op('concat', op('concat', lit("Text '"), text), lit("' could not be parsed at index 0")) }),
        });
        return pure(text, { name: `java.time.${type}`, args: [], array: 0 });
      }
      if (name === 'now' && args.length === 0 && kind !== undefined) {
        if ((type === 'OffsetDateTime' || type === 'ZonedDateTime') && ev.config.serverTimeZone !== 'UTC') {
          throw new Unsupported(`${type}.now() serializes the server offset; only UTC servers are modeled`, node);
        }
        return pure({ k: 'now', type: kind }, { name: `java.time.${type}`, args: [], array: 0 });
      }
      break;
    }
    case 'ReactiveSecurityContextHolder':
      if (name === 'getContext' && args.length === 0) return ev.securityContext(node);
      break;
    case 'Objects':
      if (name === 'equals' && args.length === 2) return pure(op('eq', arg(0), arg(1)), T.boolean);
      if (name === 'isNull' && args.length === 1) return pure(op('isNull', arg(0)), T.boolean);
      if (name === 'nonNull' && args.length === 1) return pure(op('notNull', arg(0)), T.boolean);
      if (name === 'requireNonNullElse' && args.length === 2) return { ...(args[0] as SV & { t: 'pure' }), e: op('coalesce', arg(0), arg(1)) } as SV;
      if (name === 'requireNonNull' && (args.length === 1 || args.length === 2)) {
        const target = args[0]!;
        const nullable = target.t === 'pure' ? target.e : target.t === 'obj' && target.base !== undefined && target.fields.size === 0 ? target.base : undefined;
        if (nullable !== undefined) {
          scope.block.emit({ op: 'ASSERT', test: op('notNull', nullable), error: ev.errors.map({ t: 'exception', cls: 'java.lang.NullPointerException', message: args[1]?.t === 'pure' ? args[1].e : NULL }) });
        }
        return target;
      }
      break;
    case 'String':
      if (name === 'valueOf' && args.length === 1) return pure(op('concat', lit(''), arg(0)), T.string);
      if (name === 'format' && args.length >= 1) return pure(formatString(args[0], args.slice(1), node), T.string);
      break;
    case 'Optional':
      if (name === 'ofNullable' && args.length === 1) return { t: 'optional', value: args[0]!, present: args[0]!.t === 'pure' ? op('notNull', arg(0)) : TRUE };
      if (name === 'of' && args.length === 1) {
        if (args[0]!.t === 'pure') {
          scope.block.emit({ op: 'ASSERT', test: op('notNull', arg(0)), error: ev.errors.map({ t: 'exception', cls: 'java.lang.NullPointerException', message: NULL }) });
        }
        return { t: 'optional', value: args[0]!, present: TRUE };
      }
      if (name === 'empty' && args.length === 0) return { t: 'optional', value: pure(NULL, T.object), present: FALSE };
      break;
    case 'List':
      if (name === 'of') return listOf(ev, args, args[0]?.t === 'pure' ? args[0].jt : T.object);
      if (name === 'copyOf' && args.length === 1 && args[0]!.t === 'list') return args[0]!;
      if (name === 'copyOf' && args.length === 1 && args[0]!.t === 'obj') return ev.asList(args[0], node, scope);
      break;
    case 'Set':
      // Immutable sets: membership semantics; iteration order is unspecified in Java as well.
      if (name === 'of') {
        const literals = args.map((arg) => (arg.t === 'pure' && arg.e.k === 'lit' ? JSON.stringify(arg.e.v) : undefined));
        if (literals.every((item) => item !== undefined) && new Set(literals).size !== literals.length) {
          throw new Unsupported('Set.of() with duplicate elements throws IllegalArgumentException', node);
        }
        if (literals.some((item) => item === undefined) && args.length > 1) throw new Unsupported('Set.of() over dynamic values may reject duplicates', node);
        return listOf(ev, args, args[0]?.t === 'pure' ? args[0].jt : T.object);
      }
      if (name === 'copyOf' && args.length === 1 && args[0]!.t === 'obj' && args[0].cls === 'aeris.MutableSet') return ev.asList(args[0], node, scope);
      if (name === 'copyOf' && args.length === 1 && args[0]!.t === 'list') {
        // Duplicates collapse; Java's iteration order of the copy is unspecified, first occurrence order is one valid order.
        const source = args[0];
        // Only value elements: Java's equality of other objects may be identity.
        if (fieldTypeOf(ev.project, source.elem) === undefined) throw new Unsupported('Set.copyOf() of objects relies on their equals()', node);
        return { ...source, e: op('distinct', source.e, FALSE) };
      }
      break;
    case 'Map':
      if (name === 'of' && args.length % 2 === 0) {
        const fields = new Map<string, SV>();
        for (let index = 0; index < args.length; index += 2) {
          const key = args[index]!;
          if (key.t !== 'pure' || key.e.k !== 'lit' || typeof key.e.v !== 'string') throw new Unsupported('Map.of() with a dynamic key', node);
          if (fields.has(key.e.v)) throw new Unsupported('Map.of() with duplicate keys throws', node);
          fields.set(key.e.v, args[index + 1]!);
        }
        return ev.newObject('aeris.MutableMap', fields);
      }
      break;
    case 'Collections':
      if (name === 'emptyList' && args.length === 0) return listOf(ev, [], T.object);
      if (['unmodifiableList', 'unmodifiableSet', 'unmodifiableMap', 'unmodifiableCollection'].includes(name) && args.length === 1) return args[0]!;
      break;
    case 'Arrays':
      if (name === 'asList') return listOf(ev, args, args[0]?.t === 'pure' ? args[0].jt : T.object);
      if (name === 'stream' && args.length === 1 && args[0]!.t === 'list') return args[0]!;
      break;
    case 'Math':
      if ((name === 'max' || name === 'min') && args.length === 2) return pure(op(name, arg(0), arg(1)), (args[0] as { jt: JType }).jt);
      if (name === 'abs' && args.length === 1) return pure(op('abs', arg(0)), (args[0] as { jt: JType }).jt);
      break;
    case 'Integer':
    case 'Long':
      if ((name === 'valueOf' || name === 'parseInt' || name === 'parseLong') && args.length === 1) {
        const value = args[0]!;
        if (value.t === 'pure' && value.jt.name === 'java.lang.String') return pure({ k: 'cast', to: 'integer', of: value.e }, type === 'Long' ? T.long : T.int);
        return value;
      }
      break;
    case 'Boolean':
      if (name === 'valueOf' && args.length === 1 && args[0]!.t === 'pure' && args[0]!.jt.name !== 'java.lang.String') return args[0]!;
      break;
    case 'BigDecimal':
      if (name === 'valueOf' && args.length === 1) return pure(arg(0), { name: 'java.math.BigDecimal', args: [], array: 0 });
      if (name === '<init>' && args.length === 1) {
        const value = arg(0);
        if (value.k === 'lit' && typeof value.v === 'string' && /^-?\d+(\.\d+)?$/.test(value.v)) return pure(lit(Number(value.v)), { name: 'java.math.BigDecimal', args: [], array: 0 });
        if (value.k === 'lit' && typeof value.v === 'number' && Number.isInteger(value.v)) return pure(value, { name: 'java.math.BigDecimal', args: [], array: 0 });
      }
      break;
    case 'HttpStatus':
      if ((name === 'valueOf' || name === 'resolve') && args.length === 1) return args[0]!;
      break;
    case 'HttpStatusCode':
      if (name === 'valueOf' && args.length === 1) return args[0]!;
      break;
    case 'ResponseEntity':
      return responseEntityStatic(name, args, node);
    case 'URI':
      if (name === 'create' && args.length === 1) return pure(arg(0), T.string);
      break;
    case 'Criteria':
      if (name === 'where' && args.length === 1 && args[0]!.t === 'pure' && args[0].e.k === 'lit' && typeof args[0].e.v === 'string') {
        return { t: 'criteria', conditions: [], pending: args[0].e.v, orderBy: [], isQuery: false };
      }
      if (name === 'empty' && args.length === 0) return { t: 'criteria', conditions: [], orderBy: [], isQuery: false };
      break;
    case 'Query':
      if (name === 'query' && args.length === 1 && args[0]!.t === 'criteria') return { ...args[0], isQuery: true };
      if (name === 'empty' && args.length === 0) return { t: 'criteria', conditions: [], orderBy: [], isQuery: true };
      break;
    case 'Sort':
      if (name === 'by') {
        let dir: 'asc' | 'desc' = 'asc';
        const columns: string[] = [];
        for (const item of args) {
          if (item.t === 'pure' && item.e.k === 'lit' && typeof item.e.v === 'string') {
            if (item.e.v === 'direction:DESC') dir = 'desc';
            else if (item.e.v === 'direction:ASC') dir = 'asc';
            else columns.push(item.e.v);
          } else if (item.t === 'sort') {
            return item;
          } else {
            throw new Unsupported('Sort.by() with a dynamic property', node);
          }
        }
        return { t: 'sort', orders: columns.map((column) => ({ column, dir })) };
      }
      break;
    case 'Comparator':
      if (['comparingInt', 'comparingLong', 'comparingDouble'].includes(name) && args.length === 1) {
        return { t: 'comparator', keys: [{ fn: args[0], desc: false, nulls: 'error', caseInsensitive: false }] };
      }
      if (name === 'comparing' && (args.length === 1 || args.length === 2)) {
        const inner = args[1];
        if (inner !== undefined && inner.t !== 'comparator') break;
        const nested = inner?.keys[0];
        return { t: 'comparator', keys: [{ fn: args[0], desc: nested?.desc ?? false, nulls: nested?.nulls ?? 'error', caseInsensitive: nested?.caseInsensitive ?? false }] };
      }
      if ((name === 'naturalOrder' || name === 'reverseOrder') && args.length === 0) {
        return { t: 'comparator', keys: [{ fn: undefined, desc: name === 'reverseOrder', nulls: 'error', caseInsensitive: false }] };
      }
      if ((name === 'nullsLast' || name === 'nullsFirst') && args.length === 1 && args[0]!.t === 'comparator') {
        const base = args[0];
        return { t: 'comparator', keys: base.keys.map((key) => ({ ...key, nulls: name === 'nullsLast' ? 'last' as const : 'first' as const })) };
      }
      break;
    case 'TransactionalOperator':
      if (name === 'create') return { t: 'txop' };
      break;
    case 'LoggerFactory':
      if (name === 'getLogger') return { t: 'logger' };
      break;
    case 'IntStream':
      if ((name === 'range' || name === 'rangeClosed') && args.length === 2) {
        const end = name === 'rangeClosed' ? op('add', arg(1), lit(1)) : arg(1);
        return { t: 'list', e: op('range', arg(0), end), elem: T.int, element: (item) => pure(item, T.int) };
      }
      break;
    case 'Collectors':
      if (name === 'toSet' && args.length === 0) return { t: 'type', fqn: 'aeris.collector.toSet' };
      if (name === 'toList' && args.length === 0) return { t: 'type', fqn: 'aeris.collector.toList' };
      break;
  }
  throw new Unsupported(`Library call ${fqn}.${name}/${args.length} is not modeled`, node);
}

function responseEntityStatic(name: string, args: SV[], node: SyntaxNode): SV {
  const statusOf = (sv: SV | undefined): number => {
    if (sv?.t === 'pure' && sv.e.k === 'lit' && typeof sv.e.v === 'number') return sv.e.v;
    throw new Unsupported('ResponseEntity status is not a constant', node);
  };
  switch (name) {
    case 'ok': return { t: 'response', status: 200, body: args[0] };
    case 'status': return { t: 'response', status: statusOf(args[0]), body: undefined };
    case 'created': return { t: 'response', status: 201, body: undefined };
    case 'accepted': return { t: 'response', status: 202, body: undefined };
    case 'noContent': return { t: 'response', status: 204, body: undefined };
    case 'badRequest': return { t: 'response', status: 400, body: undefined };
    case 'notFound': return { t: 'response', status: 404, body: undefined };
    case 'unprocessableEntity': return { t: 'response', status: 422, body: undefined };
    case 'of':
      if (args[0]?.t === 'optional') {
        throw new Unsupported('ResponseEntity.of(Optional) is not modeled', node);
      }
      break;
    case '<init>':
      if (args.length === 2) return { t: 'response', status: statusOf(args[1]), body: args[0] };
      if (args.length === 1) return { t: 'response', status: statusOf(args[0]), body: undefined };
  }
  throw new Unsupported(`ResponseEntity.${name} is not modeled`, node);
}

function monoStatic(ev: Evaluator, name: string, args: SV[], node: SyntaxNode, scope: Scope): MonoSV {
  const elem = (sv: SV | undefined): JType => (sv?.t === 'pure' ? sv.jt : sv?.t === 'obj' ? { name: sv.cls, args: [], array: 0 } : T.object);
  switch (name) {
    case 'just':
      if (args.length === 1) return mono(elem(args[0]), () => ({ value: args[0]!, empty: FALSE }));
      break;
    case 'justOrEmpty':
      if (args.length === 1) {
        const value = args[0]!;
        if (value.t === 'optional') return mono(elem(value.value), () => ({ value: value.value, empty: not(value.present) }));
        if (value.t === 'pure') return mono(value.jt, () => ({ value, empty: op('isNull', value.e) }));
        return mono(elem(value), () => ({ value, empty: FALSE }));
      }
      break;
    case 'empty':
      return mono(T.void, () => ({ value: VOID, empty: TRUE }));
    case 'error':
      if (args.length === 1) {
        return mono(T.object, (block) => {
          const exception = args[0]!.t === 'lambda' || args[0]!.t === 'mref' ? ev.apply(args[0]!, [], block, node, scope) : args[0]!;
          return ev.fault(exception, block, node, scope);
        });
      }
      break;
    case 'defer':
      if (args.length === 1) {
        return mono(T.object, (block) => {
          const inner = ev.apply(args[0]!, [], block, node, scope);
          if (inner.t !== 'mono') throw new Unsupported('Mono.defer() supplier does not return a Mono', node);
          return inner.run(block);
        });
      }
      break;
    case 'fromCallable':
    case 'fromSupplier':
      if (args.length === 1) {
        return mono(T.object, (block) => {
          const value = ev.apply(args[0]!, [], block, node, scope);
          return { value, empty: value.t === 'pure' ? op('isNull', value.e) : FALSE };
        });
      }
      break;
    case 'zip':
      if (args.length >= 2 && (args[0]!.t === 'lambda' || args[0]!.t === 'mref') && args.slice(1).every((arg) => arg.t === 'mono')) {
        const combinator = args[0]!;
        const sources = args.slice(1) as MonoSV[];
        return mono(T.object, (block) => {
          const emissions: Emission[] = sources.map((source) => source.run(block));
          const empty = emissions.reduce<Expr>((acc, emission) => (isLit(acc, false) ? emission.empty : isLit(emission.empty, false) ? acc : op('or', acc, emission.empty)), FALSE);
          const combined = (child: typeof block) => ({ value: ev.apply(combinator, [{ t: 'tuple', items: emissions.map((emission) => emission.value) }], child, node, scope), empty: FALSE });
          if (isLit(empty, false)) return combined(block);
          return branch(block, not(empty), combined, () => ({ value: VOID, empty: TRUE }), (t, a, b) => mergeEmission(t, a, b, (t2, x, y) => ev.merge(t2, x, y)));
        });
      }
      if (args.length >= 2 && args.every((arg) => arg.t === 'mono')) {
        return mono(T.object, (block) => {
          const emissions: Emission[] = (args as MonoSV[]).map((arg) => arg.run(block));
          const empty = emissions.reduce<Expr>((acc, emission) => (isLit(acc, false) ? emission.empty : isLit(emission.empty, false) ? acc : op('or', acc, emission.empty)), FALSE);
          return { value: { t: 'tuple', items: emissions.map((emission) => emission.value) }, empty };
        });
      }
      break;
    case 'deferContextual':
      if (args.length === 1) {
        // Only the configured context sources may read the Reactor Context.
        return mono(T.object, (block) => {
          const inner = ev.apply(args[0]!, [{ t: 'opaque', what: 'Reactor ContextView' }], block, node, scope);
          if (inner.t !== 'mono') throw new Unsupported('Mono.deferContextual() function does not return a Mono', node);
          return inner.run(block);
        });
      }
      break;
    case 'when':
      if (args.every((arg) => arg.t === 'mono')) {
        return mono(T.void, (block) => {
          for (const arg of args as MonoSV[]) arg.run(block);
          return { value: VOID, empty: TRUE };
        });
      }
      break;
  }
  throw new Unsupported(`Mono.${name}/${args.length} is not modeled`, node);
}

function fluxStatic(ev: Evaluator, name: string, args: SV[], node: SyntaxNode, scope: Scope): FluxSV {
  switch (name) {
    case 'fromIterable':
      if (args.length === 1 && args[0]!.t === 'list') {
        const list = args[0];
        return { t: 'flux', elem: list.elem, run: () => ({ list: list.e, element: list.element }) };
      }
      break;
    case 'just': {
      const items = listOf(ev, args, args[0]?.t === 'pure' ? args[0].jt : T.object);
      return { t: 'flux', elem: items.elem, run: () => ({ list: items.e, element: items.element }) };
    }
    case 'empty':
      return { t: 'flux', elem: T.object, run: () => ({ list: lit([]), element: (item) => pure(item, T.object) }) };
    case 'defer':
      if (args.length === 1) {
        return { t: 'flux', elem: T.object, run: (block) => {
          const inner = ev.apply(args[0]!, [], block, node, scope);
          if (inner.t !== 'flux') throw new Unsupported('Flux.defer() supplier does not return a Flux', node);
          return inner.run(block);
        } };
      }
      break;
    case 'error':
      if (args.length === 1) {
        return { t: 'flux', elem: T.object, run: (block) => {
          const exception = args[0]!.t === 'lambda' || args[0]!.t === 'mref' ? ev.apply(args[0]!, [], block, node, scope) : args[0]!;
          return ev.fault(exception, block, node, scope);
        } };
      }
      break;
  }
  throw new Unsupported(`Flux.${name}/${args.length} is not modeled`, node);
}

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

export function libraryInstance(ev: Evaluator, receiver: SV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  switch (receiver.t) {
    case 'pure':
      return valueMethod(ev, receiver, name, args, node);
    case 'optional':
      return optionalMethod(ev, receiver, name, args, node, scope);
    case 'list':
      return listMethod(ev, receiver, name, args, node, scope);
    case 'response':
      if (name === 'body' && args.length === 1) return { ...receiver, body: args[0] };
      if (name === 'build' && args.length === 0) return receiver;
      if (['header', 'headers', 'contentType', 'location', 'eTag', 'lastModified', 'cacheControl', 'varyBy', 'allow', 'contentLength'].includes(name)) return receiver;
      if (name === 'getBody' && args.length === 0) return receiver.body ?? pure(NULL, T.object);
      if ((name === 'getStatusCode' || name === 'getStatusCodeValue') && args.length === 0) return pure(lit(receiver.status), T.int);
      break;
    case 'tuple': {
      const match = /^getT([1-8])$/.exec(name);
      if (match !== null && args.length === 0) {
        const item = receiver.items[Number(match[1]) - 1];
        if (item !== undefined) return item;
      }
      break;
    }
    case 'comparator':
      if (name === 'reversed' && args.length === 0) return { t: 'comparator', keys: receiver.keys.map((key) => ({ ...key, desc: !key.desc })) };
      if ((name === 'thenComparing') && (args.length === 1 || args.length === 2)) {
        const next: SV = args[0]!.t === 'comparator' ? args[0]! : libraryStatic(ev, 'java.util.Comparator', 'comparing', args, node, scope);
        if (next.t === 'comparator') return { t: 'comparator', keys: [...receiver.keys, ...next.keys] };
      }
      break;
    case 'exception':
      if (receiver.status !== undefined && args.length === 0) {
        // ResponseStatusException family: the status is known; getMessage() is "<code> <NAME> \"reason\"".
        if (name === 'getStatusCode' || name === 'getStatus' || name === 'getRawStatusCode') return pure(lit(receiver.status), T.int);
        if (name === 'getReason') return pure(receiver.message, T.string);
        if (name === 'getMessage' || name === 'getLocalizedMessage') {
          const statusName = Object.entries(HTTP_STATUS).find(([, code]) => code === receiver.status)?.[0];
          if (statusName === undefined) throw new Unsupported(`Status ${receiver.status} has no HttpStatus name`, node);
          const prefix = lit(`${receiver.status} ${statusName}`);
          return pure(cond(op('isNull', receiver.message), prefix, op('concat', op('concat', op('concat', prefix, lit(' "')), receiver.message), lit('"'))), T.string);
        }
      }
      if ((name === 'getMessage' || name === 'getLocalizedMessage' || name === 'getReason') && args.length === 0) return pure(receiver.message, T.string);
      break;
  }
  throw new Unsupported(`${receiver.t}.${name}/${args.length} is not modeled`, node);
}

/**
 * The plain separator a `split()` pattern stands for, or undefined when the
 * pattern is a real regular expression. Only a literal separator is modeled:
 * a pattern that can match nothing brings Java's own exceptions to the rule
 * (no empty leading part for a zero-width match at index 0), and guessing
 * them would be worse than staying online.
 */
function literalSeparator(pattern: string): string | undefined {
  const meta = '\\.[]{}()*+?^$|';
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined || !meta.includes(escaped)) return undefined;
      out += escaped;
      index += 1;
      continue;
    }
    if (meta.includes(character)) return undefined;
    out += character;
  }
  return out.length > 0 ? out : undefined;
}

function valueMethod(ev: Evaluator, receiver: SV & { t: 'pure' }, name: string, args: SV[], node: SyntaxNode): SV {
  const self = receiver.e;
  // A constant string seen through a wider static type (Object varargs): String.toString() is the identity.
  if (name === 'toString' && args.length === 0 && self.k === 'lit' && typeof self.v === 'string') return pure(self, T.string);
  const arg = (index: number) => scalar(args[index], `${name}()`, node);
  const type = receiver.jt.name;
  if (name === 'equals' && args.length === 1) {
    if (type === 'java.math.BigDecimal') throw new Unsupported('BigDecimal.equals() compares scale, which JSON numbers do not carry', node);
    return pure(op('eq', self, arg(0)), T.boolean);
  }
  switch (type) {
    case 'java.lang.String':
      switch (`${name}/${args.length}`) {
        case 'isEmpty/0': return pure(op('isEmpty', self), T.boolean);
        case 'isBlank/0': return pure(op('isBlank', self), T.boolean);
        case 'trim/0': return pure(op('trim', self), T.string);
        case 'strip/0': return pure(op('strip', self), T.string);
        case 'length/0': return pure(op('length', self), T.int);
        case 'toLowerCase/0': return pure(op('lower', self), T.string);
        case 'toUpperCase/0': return pure(op('upper', self), T.string);
        case 'toLowerCase/1':
        case 'toUpperCase/1': {
          const locale = arg(0);
          if (locale.k !== 'lit' || typeof locale.v !== 'string' || !locale.v.startsWith('locale:')) break;
          return pure(op(name === 'toLowerCase' ? 'lower' : 'upper', self), T.string);
        }
        case 'startsWith/1': return pure(op('startsWith', self, arg(0)), T.boolean);
        case 'endsWith/1': return pure(op('endsWith', self, arg(0)), T.boolean);
        case 'contains/1': return pure(op('contains', self, arg(0)), T.boolean);
        case 'concat/1': return pure(op('concat', self, arg(0)), T.string);
        case 'replaceAll/2':
        case 'matches/1': {
          const regex = arg(0);
          if (regex.k !== 'lit' || typeof regex.v !== 'string' || !portableRegex(regex.v)) break;
          if (name === 'matches') return pure(op('matches', self, regex), T.boolean);
          const replacement = arg(1);
          if (replacement.k !== 'lit' || typeof replacement.v !== 'string' || replacement.v.includes('\\')) break;
          return pure(op('replaceAll', self, regex, replacement), T.string);
        }
        case 'split/1': {
          const pattern = arg(0);
          if (pattern.k !== 'lit' || typeof pattern.v !== 'string') break;
          const separator = literalSeparator(pattern.v);
          if (separator === undefined) break;
          return { t: 'list', e: op('split', self, lit(separator)), elem: T.string, element: (item) => pure(item, T.string) };
        }
        case 'replace/2': {
          const target = args[0];
          if (target?.t === 'pure' && target.jt.name === 'char') break;
          return pure(op('replace', self, arg(0), arg(1)), T.string);
        }
        case 'equalsIgnoreCase/1': return pure(and(op('notNull', arg(0)), op('eq', op('lower', self), op('lower', arg(0)))), T.boolean);
        case 'toString/0': return receiver;
      }
      break;
    case 'java.util.UUID':
      if (name === 'toString' && args.length === 0) return pure(self, T.string);
      break;
    case 'org.springframework.security.core.GrantedAuthority':
    case 'org.springframework.security.core.authority.SimpleGrantedAuthority':
      // Granted authorities are carried as their string form in the session claims.
      if (name === 'getAuthority' && args.length === 0) return pure(self, T.string);
      break;
    case 'java.time.YearMonth':
      switch (`${name}/${args.length}`) {
        case 'getYear/0': return pure({ k: 'cast', of: op('replaceAll', self, lit('-\\d{2}$'), lit('')), to: 'integer' } as Expr, T.int);
        case 'getMonthValue/0': return pure({ k: 'cast', of: op('replaceAll', self, lit('^.*-'), lit('')), to: 'integer' } as Expr, T.int);
        case 'toString/0': return pure(self, T.string);
      }
      break;
    case 'java.math.BigDecimal': {
      const decimal = { name: 'java.math.BigDecimal', args: [], array: 0 };
      switch (`${name}/${args.length}`) {
        case 'add/1': return pure(op('add', self, arg(0)), decimal);
        case 'subtract/1': return pure(op('sub', self, arg(0)), decimal);
        case 'multiply/1': return pure(op('mul', self, arg(0)), decimal);
        case 'negate/0': return pure(op('neg', self), decimal);
        case 'abs/0': return pure(op('abs', self), decimal);
        case 'max/1': return pure(op('max', self, arg(0)), decimal);
        case 'stripTrailingZeros/0': return receiver;
        case 'setScale/2': return pure(op('setScale', self, arg(0), arg(1)), decimal);
        case 'divide/3': return pure(op('divide', self, arg(0), arg(1), arg(2)), decimal);
        case 'divide/2':
        case 'multiply/2':
        case 'add/2':
        case 'subtract/2':
        case 'round/1': {
          const mc = mathContext(args.at(-1));
          if (mc === undefined) break;
          const precision = lit(mc.precision);
          const mode = lit(mc.mode);
          if (name === 'divide') return pure(op('divideP', self, arg(0), precision, mode), decimal);
          if (name === 'round') return pure(op('roundP', self, precision, mode), decimal);
          const exact = op(name === 'multiply' ? 'mul' : name === 'add' ? 'add' : 'sub', self, arg(0));
          return pure(op('roundP', exact, precision, mode), decimal);
        }
        case 'min/1': return pure(op('min', self, arg(0)), decimal);
        case 'compareTo/1': return pure(cond(op('lt', self, arg(0)), lit(-1), cond(op('gt', self, arg(0)), lit(1), lit(0))), T.int);
        case 'signum/0': return pure(cond(op('lt', self, lit(0)), lit(-1), cond(op('gt', self, lit(0)), lit(1), lit(0))), T.int);
      }
      break;
    }
    case 'java.lang.Integer':
    case 'java.lang.Long':
    case 'java.lang.Boolean':
    case 'java.lang.Double':
      if (['intValue', 'longValue', 'booleanValue'].includes(name) && args.length === 0) return receiver;
      if (name === 'compareTo' && args.length === 1) return pure(cond(op('lt', self, arg(0)), lit(-1), cond(op('gt', self, arg(0)), lit(1), lit(0))), T.int);
      break;
    case 'java.time.LocalDateTime':
    case 'java.time.Instant':
    case 'java.time.LocalDate':
    case 'java.time.OffsetDateTime':
    case 'java.time.ZonedDateTime':
      if (name === 'isBefore' && args.length === 1) return pure(op('lt', self, arg(0)), T.boolean);
      if (name === 'isAfter' && args.length === 1) return pure(op('gt', self, arg(0)), T.boolean);
      if (name === 'isEqual' && args.length === 1) return pure(op('eq', self, arg(0)), T.boolean);
      break;
  }
  void ev;
  throw new Unsupported(`${simple(type)}.${name}/${args.length} is not modeled`, node);
}

function optionalMethod(ev: Evaluator, receiver: SV & { t: 'optional' }, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  switch (`${name}/${args.length}`) {
    case 'isPresent/0':
      return pure(receiver.present, T.boolean);
    case 'isEmpty/0':
      return pure(not(receiver.present), T.boolean);
    case 'get/0':
    case 'orElseThrow/0':
      scope.block.emit({ op: 'ASSERT', test: receiver.present, error: ev.errors.map({ t: 'exception', cls: 'java.util.NoSuchElementException', message: lit('No value present') }) });
      return receiver.value;
    case 'orElse/1':
      return ev.merge(receiver.present, receiver.value, args[0]!);
    case 'orElseGet/1':
      return branch(scope.block, receiver.present, () => receiver.value, (child) => ev.apply(args[0]!, [], child, node, scope), (t, a, b) => ev.merge(t, a, b));
    case 'orElseThrow/1': {
      const probe = attempt(scope.block, (child) => ev.apply(args[0]!, [], child, node, scope));
      if (!probe.outcome.ok || probe.instrs.length > 0 || probe.outcome.value.t !== 'exception') throw new Unsupported('orElseThrow() supplier is not a plain exception', node);
      scope.block.emit({ op: 'ASSERT', test: receiver.present, error: ev.errors.map(probe.outcome.value as ExceptionSV) });
      return receiver.value;
    }
    case 'map/1': {
      const mapped = branch(scope.block, receiver.present, (child) => ev.apply(args[0]!, [receiver.value], child, node, scope), () => pure(NULL, T.object), (t, a, b) => ev.merge(t, a, b));
      const present = mapped.t === 'pure' ? and(receiver.present, op('notNull', mapped.e)) : receiver.present;
      return { t: 'optional', value: mapped, present };
    }
    case 'filter/1': {
      const kept = ev.apply(args[0]!, [receiver.value], scope.block, node, scope);
      if (kept.t !== 'pure') throw new Unsupported('Optional.filter() predicate is not boolean', node);
      return { t: 'optional', value: receiver.value, present: and(receiver.present, kept.e) };
    }
  }
  throw new Unsupported(`Optional.${name}/${args.length} is not modeled`, node);
}

function listMethod(ev: Evaluator, receiver: ListSV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  const element = (item: Expr) => receiver.element(item);
  const lambda = (fn: SV, what: string): { as: string; value: SV } => {
    const as = scope.block.fresh('it');
    const probe = attempt(scope.block, (child) => ev.apply(fn, [element(vr(as))], child, node, scope));
    const value = probe.outcome.ok ? pureValue(probe.instrs, probe.outcome.value) : undefined;
    if (value === undefined) throw new Unsupported(`${what} has side effects per element`, node);
    return { as, value };
  };
  switch (`${name}/${args.length}`) {
    case 'forEach/1': {
      const fn = args[0]!;
      ev.foldLoop(receiver, (env, item) => env.define('__aeris_each__', item), (inner) => {
        ev.apply(fn, [inner.env.get('__aeris_each__')!], inner.block, node, inner);
      }, node, scope);
      return { t: 'void' };
    }
    case 'get/1':
      return element(op('at', receiver.e, scalar(args[0], 'get()', node), lit('list')));
    case 'reduce/2': {
      // stream.reduce(identity, accumulator): a left fold, the accumulator must be a pure function.
      const identity = args[0]!;
      if (identity.t !== 'pure') throw new Unsupported('reduce() identity is not a value', node);
      const acc = scope.block.fresh('acc');
      const as = scope.block.fresh('it');
      const probe = attempt(scope.block, (child) => ev.apply(args[1]!, [pure(vr(acc), identity.jt), element(vr(as))], child, node, scope));
      if (!probe.outcome.ok || probe.outcome.value.t !== 'pure') throw new Unsupported('reduce() accumulator is not a pure value function', node);
      const [body] = foldPureInstrs(probe.instrs, [probe.outcome.value.e]);
      return pure({ k: 'fold', of: receiver.e, as, acc, init: identity.e, body: body! }, identity.jt);
    }
    case 'getFirst/0':
    case 'getLast/0': {
      // Java 21 sequenced collections: NoSuchElementException on an empty list.
      scope.block.emit({ op: 'ASSERT', test: not(op('isEmpty', receiver.e)), error: ev.errors.map({ t: 'exception', cls: 'java.util.NoSuchElementException', message: lit(null) }) });
      if (name === 'getFirst') return element(op('first', receiver.e));
      const as = scope.block.fresh('it');
      return element({ k: 'fold', of: receiver.e, as, acc: scope.block.fresh('acc'), init: NULL, body: vr(as) });
    }
    case 'findFirst/0':
    case 'findAny/0':
      return { t: 'optional', value: element(op('first', receiver.e)), present: not(op('isEmpty', receiver.e)) };
    case 'sorted/1':
    case 'sort/1':
      return { ...receiver, e: sortExpr(ev, receiver.e, element, args[0]!, node, scope) };
    case 'size/0':
    case 'count/0':
      return pure(op('size', receiver.e), T.int);
    case 'isEmpty/0':
      return pure(op('isEmpty', receiver.e), T.boolean);
    case 'contains/1':
      return pure(op('contains', receiver.e, scalar(args[0], 'contains()', node)), T.boolean);
    case 'stream/0':
    case 'toList/0':
      return receiver;
    case 'limit/1':
      return { ...receiver, e: op('take', receiver.e, scalar(args[0], 'limit()', node)) };
    case 'collect/1':
      if (args[0]?.t === 'type' && args[0].fqn === 'aeris.collector.toList') return receiver;
      if (args[0]?.t === 'type' && args[0].fqn === 'aeris.collector.toSet') {
        // HashSet: duplicates removed; iteration order is unspecified in Java too.
        const acc = scope.block.fresh('acc');
        const as = scope.block.fresh('it');
        return { ...receiver, e: { k: 'fold', of: receiver.e, as, acc, init: lit([]), body: cond(op('contains', vr(acc), vr(as)), vr(acc), op('append', vr(acc), vr(as))) } };
      }
      break;
    case 'sorted/0':
      // Natural order (sortExpr refuses element types whose Java order differs: UUID, enums...).
      return { ...receiver, e: sortExpr(ev, receiver.e, element, { t: 'comparator', keys: [{ fn: undefined, desc: false, nulls: 'error', caseInsensitive: false }] }, node, scope) };
    case 'boxed/0':
      return receiver;
    case 'sum/0': {
      const acc = scope.block.fresh('acc');
      const as = scope.block.fresh('it');
      return pure({ k: 'fold', of: receiver.e, as, acc, init: lit(0), body: op('add', vr(acc), vr(as)) }, receiver.elem.name === 'java.lang.Object' ? T.int : receiver.elem);
    }
    case 'mapToObj/1':
    case 'mapToInt/1':
    case 'mapToLong/1':
    case 'map/1': {
      const as = scope.block.fresh('it');
      const value = mapElements(ev, args[0]!, receiver.e, as, element(vr(as)), scope.block, node, scope, 'Stream.map()');
      const jt = value.t === 'pure' ? value.jt : value.t === 'obj' ? { name: value.cls, args: [], array: 0 } : T.object;
      return { t: 'list', e: { k: 'map', of: receiver.e, as, body: ev.encode(value) }, elem: jt, element: (item) => ev.view(item, jt) };
    }
    case 'filter/1': {
      const { as, value } = lambda(args[0]!, 'Stream.filter()');
      if (value.t !== 'pure') break;
      return { ...receiver, e: { k: 'filter', of: receiver.e, as, body: value.e } };
    }
    case 'anyMatch/1':
    case 'allMatch/1':
    case 'noneMatch/1': {
      const { as, value } = lambda(args[0]!, `Stream.${name}()`);
      if (value.t !== 'pure') break;
      const body = name === 'allMatch' ? not(value.e) : value.e;
      const matching = op('size', { k: 'filter', of: receiver.e, as, body });
      return pure(name === 'anyMatch' ? op('gt', matching, lit(0)) : op('eq', matching, lit(0)), T.boolean);
    }
  }
  throw new Unsupported(`List.${name}/${args.length} is not modeled`, node);
}

/** Regex constructs whose meaning differs between java.util.regex and JavaScript are refused. */
function portableRegex(pattern: string): boolean {
  if (/\(\?[<>=!]|\(\?[a-z]|[*+?}]\+|\\[pPQEAzZGRhHXkbB]/.test(pattern)) return false;
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/** Builds a stable sort over a list from a Comparator value. */
export function sortExpr(ev: Evaluator, list: Expr, element: (item: Expr) => SV, comparator: SV, node: SyntaxNode, scope: Scope): Expr {
  if (comparator.t !== 'comparator') throw new Unsupported('Sorting needs a Comparator built from comparing()', node);
  const as = scope.block.fresh('it');
  const keys = comparator.keys.map((key) => {
    const subject = element(vr(as));
    const extracted = key.fn === undefined ? subject : ev.apply(key.fn, [subject], scope.block.child(), node, scope);
    if (extracted.t !== 'pure') throw new Unsupported('Sort key is not a scalar value', node);
    const type = extracted.jt.name;
    if (type === 'java.util.UUID' || ev.project.type(type)?.kind === 'enum' || type === 'java.lang.Object' || type === 'java.lang.Boolean' || type === 'boolean') {
      throw new Unsupported(`Sorting by ${type} uses a Java order the IR does not reproduce`, node);
    }
    return { key: key.caseInsensitive ? op('lower', extracted.e) : extracted.e, desc: key.desc, nulls: key.nulls };
  });
  return { k: 'sort', of: list, as, keys };
}

export { mergeEmission, TRUE };
