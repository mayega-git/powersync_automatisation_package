import type { Expr } from '../../ir/types.js';
import type { JType } from '../java/model.js';
import type { SyntaxNode } from '../java/parser.js';
import { attempt, branch, mergeEmission } from './branching.js';
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
    case 'RoundingMode':
      return ['UP', 'DOWN', 'CEILING', 'FLOOR', 'HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UNNECESSARY'].includes(name)
        ? pure(lit(name), { name: 'java.math.RoundingMode', args: [], array: 0 })
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
      if (name === 'now' && args.length === 0 && kind !== undefined) {
        if ((type === 'OffsetDateTime' || type === 'ZonedDateTime') && ev.config.serverTimeZone !== 'UTC') {
          throw new Unsupported(`${type}.now() serializes the server offset; only UTC servers are modeled`, node);
        }
        return pure({ k: 'now', type: kind }, { name: `java.time.${type}`, args: [], array: 0 });
      }
      break;
    }
    case 'Objects':
      if (name === 'equals' && args.length === 2) return pure(op('eq', arg(0), arg(1)), T.boolean);
      if (name === 'isNull' && args.length === 1) return pure(op('isNull', arg(0)), T.boolean);
      if (name === 'nonNull' && args.length === 1) return pure(op('notNull', arg(0)), T.boolean);
      if (name === 'requireNonNullElse' && args.length === 2) return { ...(args[0] as SV & { t: 'pure' }), e: op('coalesce', arg(0), arg(1)) } as SV;
      if (name === 'requireNonNull' && (args.length === 1 || args.length === 2)) {
        const target = args[0]!;
        const nullable = target.t === 'pure' ? target.e : target.t === 'obj' && target.base !== undefined && target.fields.size === 0 ? target.base : undefined;
        if (nullable !== undefined) {
          scope.block.emit({ op: 'ASSERT', test: op('notNull', nullable), error: { status: 500, code: 'NULL_POINTER', message: args[1]?.t === 'pure' ? args[1].e : lit('null') } });
        }
        return target;
      }
      break;
    case 'String':
      if (name === 'valueOf' && args.length === 1) return pure(op('concat', lit(''), arg(0)), T.string);
      break;
    case 'Optional':
      if (name === 'ofNullable' && args.length === 1) return { t: 'optional', value: args[0]!, present: args[0]!.t === 'pure' ? op('notNull', arg(0)) : TRUE };
      if (name === 'of' && args.length === 1) {
        if (args[0]!.t === 'pure') {
          scope.block.emit({ op: 'ASSERT', test: op('notNull', arg(0)), error: { status: 500, code: 'NULL_POINTER', message: lit('Optional.of(null)') } });
        }
        return { t: 'optional', value: args[0]!, present: TRUE };
      }
      if (name === 'empty' && args.length === 0) return { t: 'optional', value: pure(NULL, T.object), present: FALSE };
      break;
    case 'List':
      if (name === 'of') return listOf(ev, args, args[0]?.t === 'pure' ? args[0].jt : T.object);
      if (name === 'copyOf' && args.length === 1 && args[0]!.t === 'list') return args[0]!;
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
      if (name === 'copyOf' && args.length === 1 && args[0]!.t === 'list') throw new Unsupported('Set.copyOf() removes duplicates', node);
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
    case 'Collectors':
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
      if (args.length >= 2 && args.every((arg) => arg.t === 'mono')) {
        return mono(T.object, (block) => {
          const emissions: Emission[] = (args as MonoSV[]).map((arg) => arg.run(block));
          const empty = emissions.reduce<Expr>((acc, emission) => (isLit(acc, false) ? emission.empty : isLit(emission.empty, false) ? acc : op('or', acc, emission.empty)), FALSE);
          return { value: { t: 'tuple', items: emissions.map((emission) => emission.value) }, empty };
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
      if ((name === 'getMessage' || name === 'getLocalizedMessage' || name === 'getReason') && args.length === 0) return pure(receiver.message, T.string);
      break;
  }
  throw new Unsupported(`${receiver.t}.${name}/${args.length} is not modeled`, node);
}

function valueMethod(ev: Evaluator, receiver: SV & { t: 'pure' }, name: string, args: SV[], node: SyntaxNode): SV {
  const self = receiver.e;
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
      scope.block.emit({ op: 'ASSERT', test: receiver.present, error: { status: 500, code: 'NO_SUCH_ELEMENT', message: lit('No value present') } });
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
    if (!probe.outcome.ok || probe.instrs.length > 0) throw new Unsupported(`${what} has side effects per element`, node);
    return { as, value: probe.outcome.value };
  };
  switch (`${name}/${args.length}`) {
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
      break;
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
