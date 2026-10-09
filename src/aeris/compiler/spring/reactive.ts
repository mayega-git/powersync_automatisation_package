import type { Expr, Instr } from '../../ir/types.js';
import type { JType } from '../java/model.js';
import type { SyntaxNode } from '../java/parser.js';
import { attempt, branch, mergeEmission, pureValue, restoreObjects, snapshotObjects } from './branching.js';
import { sortExpr } from './library.js';
import type { Evaluator, Scope } from './evaluator.js';
import {
  and,
  cond,
  FALSE,
  getf,
  isLit,
  lit,
  NULL,
  not,
  op,
  or,
  pure,
  T,
  TRUE,
  Unsupported,
  VOID,
  vr,
  Block,
  type Emission,
  type FluxSV,
  type MonoSV,
  type ResponseSV,
  type ResponsesSV,
  responseCases,
  type SV,
} from './sv.js';

const IDENTITY_OPERATORS = new Set([
  'subscribeOn', 'publishOn', 'timeout', 'cache', 'retry', 'retryWhen', 'share', 'hide',
  'onTerminateDetach', 'log', 'name', 'tag', 'checkpoint', 'metrics', 'cancelOn', 'cast',
]);

const SIDE_CHANNEL_OPERATORS = new Set([
  'doOnNext', 'doOnSuccess', 'doOnError', 'doOnSubscribe', 'doFinally', 'doOnTerminate', 'doAfterTerminate',
  'doOnCancel', 'doOnEach', 'doOnRequest', 'doOnComplete', 'doOnDiscard',
]);

const ERROR_HANDLERS = new Set(['onErrorComplete', 'onErrorResume', 'onErrorReturn', 'onErrorMap', 'onErrorContinue', 'onErrorStop']);

/** Instructions that can fail at run time (an error handler would change their outcome). */
function fallible(instrs: readonly Instr[]): boolean {
  return instrs.some((instr) => {
    if (instr.op === 'LET' || instr.op === 'EMIT_LOCAL_EVENT' || instr.op === 'QUEUE_INTENT') return false;
    if (instr.op === 'IF') return fallible(instr.then) || fallible(instr.else);
    if (instr.op === 'TRY') return fallible(instr.fallback);
    if (instr.op === 'EACH') return true;
    return true;
  });
}

/**
 * Runs a per-element function returning a Mono on a symbolic element. The
 * caller either uses the result directly (no instructions) or emits one
 * read-only EACH collecting the given fields per element.
 */
function perElement(ev: Evaluator, block: Block, list: Expr, element: (item: Expr) => SV, apply: (item: SV, child: Block) => Emission, node: SyntaxNode, what: string) {
  const as = block.fresh('it');
  const before = snapshotObjects(ev.objects);
  const probe = attempt(block, (child) => apply(element(vr(as)), child));
  const mutated = [...before].some(([target, fields]) => [...target.fields].some(([key, value]) => fields.get(key) !== value));
  restoreObjects(before);
  if (mutated) throw new Unsupported(`${what} mutates shared objects per element`, node);
  if (!probe.outcome.ok) throw new Unsupported(`${what} fails for every element`, node);
  const instrs = probe.instrs;
  return {
    as,
    emission: probe.outcome.value,
    instrs,
    emit: (fields: Record<string, Expr>): string => {
      if (!readOnly(instrs)) throw new Unsupported(`${what} writes per element`, node);
      const out = block.fresh('each');
      block.emit({ op: 'EACH', of: list, as, body: instrs, yield: { k: 'object', fields }, out });
      return out;
    },
  };
}

/** Applies a function returning a Mono and runs it. */
function applyMono(ev: Evaluator, fn: SV, node: SyntaxNode, scope: Scope, what: string): (item: SV, child: Block) => Emission {
  return (item, child) => {
    const inner = ev.apply(fn, [item], child, node, scope);
    if (inner.t !== 'mono') throw new Unsupported(`${what} function does not return a Mono`, node);
    return inner.run(child);
  };
}

function mono(elem: JType, run: (block: Block) => Emission): MonoSV {
  return { t: 'mono', elem, run };
}

/** Runs `onValue` only when the emission is not empty, keeping the emptiness. */
function whenPresent(ev: Evaluator, block: Block, source: Emission, onValue: (child: Block) => Emission): Emission {
  if (isLit(source.empty, true)) return { value: VOID, empty: TRUE };
  if (isLit(source.empty, false)) return onValue(block);
  return branch(
    block,
    not(source.empty),
    onValue,
    () => ({ value: VOID, empty: TRUE }),
    (test, a, b) => mergeEmission(test, a, b, (t, x, y) => ev.merge(t, x, y)),
  );
}

function elemOf(sv: SV): JType {
  switch (sv.t) {
    case 'pure': return sv.jt;
    case 'obj': return { name: sv.cls, args: [], array: 0 };
    case 'list': return T.list(sv.elem);
    default: return T.object;
  }
}

/** Evaluates a function that must not emit instructions (per-element or side-channel lambdas). */
function pureApply(ev: Evaluator, fn: SV, args: SV[], block: Block, node: SyntaxNode, scope: Scope, what: string): SV {
  const probe = attempt(block, (child) => ev.apply(fn, args, child, node, scope));
  if (!probe.outcome.ok) throw new Unsupported(`${what} can throw for some elements`, node);
  const value = pureValue(probe.instrs, probe.outcome.value);
  if (value === undefined) throw new Unsupported(`${what} has side effects per element`, node);
  return value;
}

/**
 * Per-element mapping whose only effects are checks (domain invariants that
 * throw): the checks are hoisted into one list-level ASSERT, which fails with
 * the same error as the first failing element would.
 */
export function mapElements(ev: Evaluator, fn: SV, list: Expr, as: string, element: SV, block: Block, node: SyntaxNode, scope: Scope, what: string): SV {
  const probe = attempt(block, (child) => ev.apply(fn, [element], child, node, scope));
  if (!probe.outcome.ok) throw new Unsupported(`${what} always throws for an element`, node);
  for (const instr of probe.instrs) {
    if (instr.op !== 'ASSERT') throw new Unsupported(`${what} has side effects per element`, node);
    const failing: Expr = { k: 'filter', of: list, as, body: not(instr.test) };
    block.emit({
      op: 'ASSERT',
      test: op('isEmpty', failing),
      error: { ...instr.error, message: op('first', { k: 'map', of: failing, as, body: instr.error.message }) },
    });
  }
  return probe.outcome.value;
}

/**
 * `contextWrite(context)` decides what everything downstream of it reads as the
 * session. Waving it through would mean a handler that writes a *different*
 * organization into the Context gets the caller's own rows locally and that
 * organization's rows from the backend -- the same request answered two ways.
 *
 * So it is an identity only when what is written is provably the session
 * itself: every entry carries the claim that bears its own key's name, which is
 * what a filter copying a ThreadLocal into the Reactor Context does. Anything
 * else stays online; nothing about the session is guessed.
 */
function contextWrite(receiver: MonoSV | FluxSV, args: SV[], node: SyntaxNode): SV {
  const written = args[0];
  if (written === undefined) return receiver;
  if (written.t !== 'ctxmap') {
    throw new Unsupported('contextWrite() is given a Context the compiler cannot read', node);
  }
  for (const entry of written.entries) {
    const value = entry.value;
    const claim = value.t === 'pure' && value.e.k === 'ctx' ? value.e.name : undefined;
    if (claim !== entry.key) {
      throw new Unsupported(`contextWrite() puts ${claim === undefined ? 'a computed value' : `the claim ${claim}`} under "${entry.key}", which changes the session the code downstream reads`, node);
    }
  }
  return receiver;
}

export function reactiveCall(ev: Evaluator, receiver: MonoSV | FluxSV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  if (IDENTITY_OPERATORS.has(name)) return receiver;
  if (name === 'contextWrite') return contextWrite(receiver, args, node);
  // Mono.flux() / Flux.next(): the same values under the other publisher.
  if (name === 'flux' && args.length === 0 && receiver.t === 'mono') {
    return { t: 'flux', elem: receiver.elem, run: (block) => {
      const emission = receiver.run(block);
      const item = ev.encode(emission.value);
      return { list: cond(emission.empty, lit([]), { k: 'list', items: [item] }), element: () => emission.value };
    } };
  }
  if (name === 'as' && args.length === 1) return ev.apply(args[0]!, [receiver], scope.block, node, scope);
  if (SIDE_CHANNEL_OPERATORS.has(name)) return sideChannel(ev, receiver, args, node, scope, name);
  if (ERROR_HANDLERS.has(name)) return errorHandler(ev, receiver, args, node, scope, name);
  return receiver.t === 'mono' ? monoCall(ev, receiver, name, args, node, scope) : fluxCall(ev, receiver, name, args, node, scope);
}

function sideChannel(ev: Evaluator, receiver: MonoSV | FluxSV, args: SV[], node: SyntaxNode, scope: Scope, name: string): SV {
  const fn = args.at(-1);
  if (receiver.t === 'mono') {
    return mono(receiver.elem, (block) => {
      const emission = receiver.run(block);
      if (fn !== undefined && (fn.t === 'lambda' || fn.t === 'mref')) {
        const arity = fn.t === 'lambda' ? fn.params.length : 1;
        const sample = arity === 0 ? [] : [name === 'doOnError' ? { t: 'exception', cls: 'java.lang.Throwable', message: lit(null) } as SV : emission.value];
        const probe = attempt(block, (child) => ev.apply(fn, sample.slice(0, arity), child, node, scope));
        if (!probe.outcome.ok || probe.instrs.length > 0) throw new Unsupported(`${name}() callback has effects beyond logging`, node);
      }
      return emission;
    });
  }
  return receiver;
}

/** Marks the caught error inside a fallback: its message and class are not modeled, so it may only be logged. */
const CAUGHT = '__aeris_caught_error__';

function readOnly(instrs: readonly Instr[]): boolean {
  return instrs.every((instr) => {
    if (instr.op === 'IF') return readOnly(instr.then) && readOnly(instr.else);
    if (instr.op === 'TRY') return readOnly(instr.body) && readOnly(instr.fallback);
    if (instr.op === 'EACH') return readOnly(instr.body);
    return instr.op === 'QUERY' || instr.op === 'LET' || instr.op === 'ASSERT';
  });
}

/**
 * Mono.onErrorReturn(v) / onErrorResume(e -> mono) / onErrorComplete() over a
 * read-only source: a TRY whose body forces the emitted value (Reactor
 * computes it inside the chain, so its failures are caught too) and whose
 * fallback produces the replacement.
 */
function recoverMono(ev: Evaluator, receiver: MonoSV, args: SV[], node: SyntaxNode, scope: Scope, name: string): MonoSV {
  return mono(receiver.elem, (block) => {
    const probe = attempt(block, (child) => receiver.run(child));
    if (probe.outcome.ok && !fallible(probe.instrs)) {
      // Nothing in the source can fail before the value is used: the handler never runs.
      for (const instr of probe.instrs) block.emit(instr);
      return probe.outcome.value;
    }
    const emptySlot = block.fresh('recovered');
    const valueSlot = block.fresh('recovered');
    // ResponseEntity values: each possible response is a template; a tag says which one was produced.
    const templates: { status: number; like?: SV; slot: string }[] = [];
    const settle = (child: Block, emission: Emission) => {
      child.emit({ op: 'LET', out: emptySlot, expr: emission.empty });
      const value = emission.value;
      if (value.t === 'response' || value.t === 'responses') {
        let tag: Expr = lit(-1);
        for (const { test, response } of responseCases(value).reverse()) {
          const index = templates.length;
          const slot = block.fresh('recovered');
          templates.push({ status: response.status, ...(response.body === undefined ? {} : { like: response.body }), slot });
          if (response.body !== undefined) child.emit({ op: 'LET', out: slot, expr: cond(and(not(emission.empty), test), ev.encode(response.body), NULL) });
          tag = cond(test, lit(index), tag);
        }
        child.emit({ op: 'LET', out: valueSlot, expr: cond(emission.empty, lit(-1), tag) });
        return;
      }
      if (value.t !== 'void') child.emit({ op: 'LET', out: valueSlot, expr: cond(emission.empty, NULL, ev.encode(value)) });
    };
    const body = attempt(block, (child) => {
      const emission = receiver.run(child);
      settle(child, emission);
      return emission;
    });
    const fallback = attempt(block, (child): Emission => {
      let emission: Emission;
      if (name === 'onErrorComplete') {
        emission = { value: VOID, empty: TRUE };
      } else if (name === 'onErrorReturn') {
        const value = args[0]!;
        if (value.t === 'pure' && isLit(value.e, null)) throw new Unsupported('onErrorReturn(null) throws', node);
        emission = { value, empty: FALSE };
      } else {
        const resumed = ev.apply(args[0]!, [{ t: 'exception', cls: 'java.lang.Throwable', message: vr(CAUGHT) }], child, node, scope);
        if (resumed.t !== 'mono') throw new Unsupported('onErrorResume() does not resume with a Mono', node);
        emission = resumed.run(child);
      }
      settle(child, emission);
      return emission;
    });
    if (!fallback.outcome.ok) throw new Unsupported(`${name}() rethrows`, node);
    if (!readOnly(body.instrs) || !readOnly(fallback.instrs)) throw new Unsupported(`${name}() recovers from an operation that writes`, node);
    if (JSON.stringify(fallback.instrs).includes(CAUGHT)) throw new Unsupported(`${name}() inspects the caught error`, node);
    const recovered = fallback.outcome.value.value;
    const produced = body.outcome.ok ? body.outcome.value.value : recovered;
    const isResponse = (value: SV) => value.t === 'response' || value.t === 'responses';
    if (isResponse(produced) !== isResponse(recovered)) throw new Unsupported(`${name}() recovers a response with a plain value`, node);
    // Both sides define every body slot (null on the side that cannot produce that response).
    for (const instrs of [body.instrs, fallback.instrs]) {
      const defined = new Set(instrs.flatMap((instr) => (instr.op === 'LET' ? [instr.out] : [])));
      for (const template of templates) {
        if (template.like !== undefined && !defined.has(template.slot)) instrs.push({ op: 'LET', out: template.slot, expr: NULL });
      }
    }
    const definesValue = (instrs: Instr[]) => instrs.some((instr) => instr.op === 'LET' && instr.out === valueSlot);
    if (definesValue(body.instrs) || definesValue(fallback.instrs)) {
      for (const instrs of [body.instrs, fallback.instrs]) if (!definesValue(instrs)) instrs.push({ op: 'LET', out: valueSlot, expr: NULL });
    }
    block.emit({ op: 'TRY', body: body.instrs, fallback: fallback.instrs });
    if (templates.length > 0) {
      // Rebuild the choice of responses over the tag; bodies are viewed through their slot.
      const responseAt = (index: number): ResponseSV => {
        const template = templates[index]!;
        return { t: 'response', status: template.status, body: template.like === undefined ? undefined : shapeOf(ev, template.like, template.like, vr(template.slot), node) };
      };
      let value: ResponseSV | ResponsesSV = responseAt(templates.length - 1);
      for (let index = templates.length - 2; index >= 0; index -= 1) {
        value = { t: 'responses', test: op('eq', vr(valueSlot), lit(index)), a: responseAt(index), b: value };
      }
      return { value, empty: vr(emptySlot) };
    }
    const value = shapeOf(ev, produced, recovered, vr(valueSlot), node);
    return { value, empty: vr(emptySlot) };
  });
}

/** One symbolic view over the value of either side of a TRY. */
function shapeOf(ev: Evaluator, a: SV, b: SV, e: Expr, node: SyntaxNode): SV {
  if (a.t === 'void' && b.t === 'void') return VOID;
  const known = [a, b].filter((value) => value.t !== 'void');
  const like = known[0]!;
  for (const other of known) {
    if (other.t !== like.t || (other.t === 'obj' && like.t === 'obj' && other.cls !== like.cls)) {
      throw new Unsupported('The recovered value has a different shape than the original one', node);
    }
  }
  if (like.t !== 'pure' && like.t !== 'list' && like.t !== 'obj') throw new Unsupported('The recovered value is not a plain value', node);
  return ev.reView(like, e);
}

/** Every way the instructions can fail: thrown classes, or undefined for failures of unknown class. */
function failureClasses(instrs: readonly Instr[], out: (string | undefined)[] = []): (string | undefined)[] {
  for (const instr of instrs) {
    if (instr.op === 'ASSERT') out.push(instr.error.exception);
    else if (instr.op === 'IF') { failureClasses(instr.then, out); failureClasses(instr.else, out); }
    else if (instr.op === 'TRY') failureClasses(instr.fallback, out);
    else if (instr.op === 'EACH') { failureClasses(instr.body, out); out.push(undefined); }
    else if (instr.op !== 'LET' && instr.op !== 'EMIT_LOCAL_EVENT' && instr.op !== 'QUEUE_INTENT') out.push(undefined);
  }
  return out;
}

/**
 * onErrorX(SomeException.class, ...) where SomeException is a project exception
 * that nothing upstream can throw: the handler never runs.
 */
function handlerNeverFires(ev: Evaluator, receiver: MonoSV | FluxSV, filter: SV): boolean {
  if (filter.t !== 'type') return false;
  const decl = ev.project.type(filter.fqn);
  if (decl === undefined) return false;
  const probe = attempt(new Block({ vars: 0, uuidSlots: 0 }), (child) => (receiver.t === 'mono' ? receiver.run(child) : receiver.run(child)));
  if (!probe.outcome.ok) return false;
  return failureClasses(probe.instrs).every((cls) => {
    if (cls === undefined) return true; // run-time failures (null dereference, row counts) are library exceptions, never a project class
    if (cls === filter.fqn) return false;
    const thrown = ev.project.type(cls);
    return thrown !== undefined ? !ev.project.supertypeNames(thrown).has(filter.fqn) : true;
  });
}

function errorHandler(ev: Evaluator, receiver: MonoSV | FluxSV, args: SV[], node: SyntaxNode, scope: Scope, name: string): SV {
  if (args.length === 2 && ['onErrorResume', 'onErrorReturn', 'onErrorMap', 'onErrorComplete', 'onErrorContinue'].includes(name) && handlerNeverFires(ev, receiver, args[0]!)) {
    return receiver;
  }
  if (receiver.t === 'mono') {
    const recoverable = (name === 'onErrorReturn' && args.length === 1) || (name === 'onErrorResume' && args.length === 1) || (name === 'onErrorComplete' && args.length === 0);
    if (recoverable) return recoverMono(ev, receiver, args, node, scope, name);
    return mono(receiver.elem, (block) => {
      const probe = attempt(block, (child) => receiver.run(child));
      if (!probe.outcome.ok || fallible(probe.instrs)) throw new Unsupported(`${name}() changes the outcome of a failing operation`, node);
      for (const instr of probe.instrs) block.emit(instr);
      return probe.outcome.value;
    });
  }
  return {
    t: 'flux',
    elem: receiver.elem,
    run: (block) => {
      const probe = attempt(block, (child) => receiver.run(child));
      if (!probe.outcome.ok || fallible(probe.instrs)) throw new Unsupported(`${name}() changes the outcome of a failing operation`, node);
      for (const instr of probe.instrs) block.emit(instr);
      return probe.outcome.value;
    },
  };
  void ev;
}

function monoCall(ev: Evaluator, source: MonoSV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  const fn = args[0];
  switch (name) {
    case 'map':
      return mono(T.object, (block) => {
        const emission = source.run(block);
        return whenPresent(ev, block, emission, (child) => {
          const value = ev.apply(fn!, [emission.value], child, node, scope);
          return { value, empty: value.t === 'pure' && isLit(value.e, null) ? TRUE : FALSE };
        });
      });
    case 'flatMap':
      return mono(T.object, (block) => {
        const emission = source.run(block);
        return whenPresent(ev, block, emission, (child) => {
          const inner = ev.apply(fn!, [emission.value], child, node, scope);
          if (inner.t !== 'mono') throw new Unsupported(`flatMap() mapper returns ${inner.t}, not a Mono`, node);
          return inner.run(child);
        });
      });
    case 'flatMapMany':
      return {
        t: 'flux',
        elem: T.object,
        run: (block) => {
          const emission = source.run(block);
          if (isLit(emission.empty, true)) return { list: lit([]), element: (item: Expr) => pure(item, T.object) };
          const produce = (child: Block) => {
            const inner = ev.apply(fn!, [emission.value], child, node, scope);
            if (inner.t !== 'flux') throw new Unsupported(`flatMapMany() mapper returns ${inner.t}, not a Flux`, node);
            return inner.run(child);
          };
          if (isLit(emission.empty, false)) return produce(block);
          return branch(block, not(emission.empty), produce, () => ({ list: lit([]), element: (item: Expr) => pure(item, T.object) }),
            (test, a, b) => ({ list: cond(test, a.list, b.list), element: a.element }));
        },
      };
    case 'filter':
      return mono(source.elem, (block) => {
        const emission = source.run(block);
        if (isLit(emission.empty, true)) return emission;
        const probe = attempt(block, (child) => ev.apply(fn!, [emission.value], child, node, scope));
        if (probe.outcome.ok && probe.instrs.length === 0 && probe.outcome.value.t === 'pure') {
          return { value: emission.value, empty: or(emission.empty, not(probe.outcome.value.e)) };
        }
        return whenPresent(ev, block, emission, (child) => {
          const kept = ev.apply(fn!, [emission.value], child, node, scope);
          if (kept.t !== 'pure') throw new Unsupported('filter() predicate is not boolean', node);
          return { value: emission.value, empty: not(kept.e) };
        });
      });
    case 'filterWhen':
      return mono(source.elem, (block) => {
        const emission = source.run(block);
        return whenPresent(ev, block, emission, (child) => {
          const predicate = ev.apply(fn!, [emission.value], child, node, scope);
          if (predicate.t !== 'mono') throw new Unsupported('filterWhen() predicate is not a Mono', node);
          const result = predicate.run(child);
          if (result.value.t !== 'pure') throw new Unsupported('filterWhen() predicate is not boolean', node);
          // An empty predicate Mono filters the value out, like false.
          return { value: emission.value, empty: or(result.empty, not(result.value.e)) };
        });
      });
    case 'switchIfEmpty':
      return mono(source.elem, (block) => {
        const emission = source.run(block);
        const alternative = fn!;
        if (alternative.t !== 'mono') throw new Unsupported('switchIfEmpty() alternative is not a Mono', node);
        if (isLit(emission.empty, false)) return emission;
        if (isLit(emission.empty, true)) return alternative.run(block);
        return branch(block, emission.empty, (child) => alternative.run(child), () => ({ value: emission.value, empty: FALSE }),
          (test, a, b) => mergeEmission(test, a, b, (t, x, y) => ev.merge(t, x, y)));
      });
    case 'defaultIfEmpty':
      return mono(source.elem, (block) => {
        const emission = source.run(block);
        if (isLit(emission.empty, false)) return emission;
        return { value: ev.merge(emission.empty, fn!, emission.value), empty: FALSE };
      });
    case 'then':
      if (args.length === 0) {
        return mono(T.void, (block) => {
          source.run(block);
          return { value: VOID, empty: TRUE };
        });
      }
      return mono(fn!.t === 'mono' ? fn!.elem : T.object, (block) => {
        source.run(block);
        if (fn!.t !== 'mono') throw new Unsupported('then() argument is not a Mono', node);
        return fn!.run(block);
      });
    case 'thenReturn':
      return mono(elemOf(fn!), (block) => {
        source.run(block);
        return { value: fn!, empty: FALSE };
      });
    case 'thenMany':
      return {
        t: 'flux',
        elem: fn!.t === 'flux' ? fn!.elem : T.object,
        run: (block) => {
          source.run(block);
          if (fn!.t !== 'flux') throw new Unsupported('thenMany() argument is not a Flux', node);
          return fn!.run(block);
        },
      };
    case 'hasElement':
      return mono(T.boolean, (block) => {
        const emission = source.run(block);
        return { value: pure(not(emission.empty), T.boolean), empty: FALSE };
      });
    case 'single':
      return mono(source.elem, (block) => {
        const emission = source.run(block);
        if (!isLit(emission.empty, false)) {
          block.emit({ op: 'ASSERT', test: not(emission.empty), error: ev.errors.map({ t: 'exception', cls: 'java.util.NoSuchElementException', message: lit('Source was empty') }) });
        }
        return { value: emission.value, empty: FALSE };
      });
    case 'singleOrEmpty':
      return source;
    case 'zipWith':
    case 'zipWhen':
      return mono(T.object, (block) => {
        const left = source.run(block);
        return whenPresent(ev, block, left, (child) => {
          const other = name === 'zipWhen' ? ev.apply(fn!, [left.value], child, node, scope) : fn!;
          if (other.t !== 'mono') throw new Unsupported(`${name}() argument is not a Mono`, node);
          const right = other.run(child);
          const value: SV = args[1] !== undefined
            ? ev.apply(args[1], [left.value, right.value], child, node, scope)
            : { t: 'tuple', items: [left.value, right.value] };
          return { value, empty: right.empty };
        });
      });
    case 'switchIfEmptyOrError':
    default:
      throw new Unsupported(`Mono.${name}() is not modeled`, node);
  }
}

function fluxCall(ev: Evaluator, source: FluxSV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
  const fn = args[0];
  switch (name) {
    case 'map':
      return {
        t: 'flux',
        elem: T.object,
        run: (block) => {
          const { list, element } = source.run(block);
          const as = block.fresh('it');
          let mapped: SV;
          try {
            mapped = mapElements(ev, fn!, list, as, element(vr(as)), block, node, scope, 'Flux.map()');
          } catch (error) {
            if (!(error instanceof Unsupported) || !/side effects per element/.test(error.reason)) throw error;
            // The mapper reads data or binds values: one read-only EACH computing it per element, in order.
            const each = perElement(ev, block, list, element, (item, child) => ({ value: ev.apply(fn!, [item], child, node, scope), empty: FALSE }), node, 'Flux.map()');
            const jt = elemOf(each.emission.value);
            const out = each.emit({ value: ev.encode(each.emission.value) });
            const item = block.fresh('it');
            return { list: { k: 'map', of: vr(out), as: item, body: getf(vr(item), 'value') }, element: (value: Expr) => ev.view(value, jt) };
          }
          const body = ev.encode(mapped);
          const jt = elemOf(mapped);
          return { list: { k: 'map', of: list, as, body }, element: (item: Expr) => ev.view(item, jt) };
        },
      };
    case 'flatMap':
    case 'concatMap':
    case 'flatMapSequential':
      return {
        t: 'flux',
        elem: T.object,
        run: (block) => {
          const { list, element } = source.run(block);
          const each = perElement(ev, block, list, element, applyMono(ev, fn!, node, scope, `Flux.${name}()`), node, `Flux.${name}()`);
          const { emission, as } = each;
          const jt = elemOf(emission.value);
          if (each.instrs.length === 0 && isLit(emission.empty, false)) {
            return { list: { k: 'map', of: list, as, body: ev.encode(emission.value) }, element: (item: Expr) => ev.view(item, jt) };
          }
          // Per-element lookups: one EACH; empty inner results contribute nothing (Reactor flattening).
          const out = each.emit({ empty: emission.empty, value: cond(emission.empty, NULL, ev.encode(emission.value)) });
          const kept = block.fresh('it');
          const present: Expr = { k: 'filter', of: vr(out), as: kept, body: not(getf(vr(kept), 'empty')) };
          const item = block.fresh('it');
          return { list: { k: 'map', of: present, as: item, body: getf(vr(item), 'value') }, element: (value: Expr) => ev.view(value, jt) };
        },
      };
    case 'filterWhen':
      return {
        t: 'flux',
        elem: source.elem,
        run: (block) => {
          const { list, element } = source.run(block);
          const each = perElement(ev, block, list, element, applyMono(ev, fn!, node, scope, 'Flux.filterWhen()'), node, 'Flux.filterWhen()');
          const { emission, as } = each;
          if (emission.value.t !== 'pure') throw new Unsupported('Flux.filterWhen() predicate is not boolean', node);
          // An empty predicate filters the element out, like false.
          const keep = and(not(emission.empty), op('eq', cond(emission.empty, FALSE, emission.value.e), TRUE));
          if (each.instrs.length === 0) return { list: { k: 'filter', of: list, as, body: keep }, element };
          const out = each.emit({ keep, item: vr(as) });
          const row = block.fresh('it');
          const item = block.fresh('it');
          return {
            list: { k: 'map', of: { k: 'filter', of: vr(out), as: row, body: getf(vr(row), 'keep') }, as: item, body: getf(vr(item), 'item') },
            element,
          };
        },
      };
    case 'filter':
      return {
        t: 'flux',
        elem: source.elem,
        run: (block) => {
          const { list, element } = source.run(block);
          const as = block.fresh('it');
          const kept = pureApply(ev, fn!, [element(vr(as))], block, node, scope, 'Flux.filter()');
          if (kept.t !== 'pure') throw new Unsupported('Flux.filter() predicate is not boolean', node);
          return { list: { k: 'filter', of: list, as, body: kept.e }, element };
        },
      };
    case 'sort':
      if (args.length !== 1) throw new Unsupported('Flux.sort() without a comparator uses natural order', node);
      return {
        t: 'flux',
        elem: source.elem,
        run: (block) => {
          const result = source.run(block);
          return { list: sortExpr(ev, result.list, result.element, fn!, node, { ...scope, block }), element: result.element };
        },
      };
    case 'take':
      if (args.length !== 1 || fn!.t !== 'pure') throw new Unsupported('Flux.take() with a non-constant bound', node);
      return {
        t: 'flux',
        elem: source.elem,
        run: (block) => {
          const result = source.run(block);
          return { list: op('take', result.list, (fn as SV & { t: 'pure' }).e), element: result.element };
        },
      };
    case 'next':
      return mono(source.elem, (block) => {
        const { list, element } = source.run(block);
        return { value: element(op('first', list)), empty: op('isEmpty', list) };
      });
    case 'collectList':
      return mono(T.list(source.elem), (block) => {
        const { list, element } = source.run(block);
        return { value: { t: 'list', e: list, elem: source.elem, element }, empty: FALSE };
      });
    case 'count':
      return mono(T.long, (block) => {
        const { list } = source.run(block);
        return { value: pure(op('size', list), T.long), empty: FALSE };
      });
    case 'any':
    case 'all':
      return mono(T.boolean, (block) => {
        const { list, element } = source.run(block);
        const as = block.fresh('it');
        const test = pureApply(ev, fn!, [element(vr(as))], block, node, scope, `Flux.${name}()`);
        if (test.t !== 'pure') throw new Unsupported(`Flux.${name}() predicate is not boolean`, node);
        const matching = op('size', { k: 'filter', of: list, as, body: name === 'any' ? test.e : not(test.e) });
        return { value: pure(name === 'any' ? op('gt', matching, lit(0)) : op('eq', matching, lit(0)), T.boolean), empty: FALSE };
      });
    case 'hasElements':
      return mono(T.boolean, (block) => {
        const { list } = source.run(block);
        return { value: pure(not(op('isEmpty', list)), T.boolean), empty: FALSE };
      });
    case 'then':
      if (args.length === 0) {
        return mono(T.void, (block) => {
          source.run(block);
          return { value: VOID, empty: TRUE };
        });
      }
      throw new Unsupported('Flux.then(Mono) is not modeled', node);
    case 'switchIfEmpty':
      return {
        t: 'flux',
        elem: source.elem,
        run: (block) => {
          const result = source.run(block);
          if (fn!.t !== 'flux') throw new Unsupported('switchIfEmpty() alternative is not a Flux', node);
          const alternative = fn!;
          return branch(block, op('isEmpty', result.list), (child) => alternative.run(child), () => result,
            (test, a, b) => ({ list: cond(test, a.list, b.list), element: b.element }));
        },
      };
    case 'defaultIfEmpty':
      return {
        t: 'flux',
        elem: source.elem,
        run: (block) => {
          const result = source.run(block);
          return { list: cond(op('isEmpty', result.list), { k: 'list', items: [ev.encode(fn!)] }, result.list), element: result.element };
        },
      };
    default:
      throw new Unsupported(`Flux.${name}() is not modeled`, node);
  }
}
