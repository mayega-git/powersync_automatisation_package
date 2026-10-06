import type { ErrorSpec, Expr } from '../../ir/types.js';
import type { JavaProject, MethodDecl, TypeDecl } from '../java/model.js';
import { named, stringValue, type SyntaxNode } from '../java/parser.js';
import { Block, Env, lit, NULL, Unsupported, vr, type ExceptionSV, type SV } from './sv.js';
import type { Evaluator, ErrorMapper } from './evaluator.js';
import { HTTP_STATUS } from './library.js';
import type { JacksonModel } from './serialize.js';

const LIBRARY_HIERARCHY: Readonly<Record<string, string>> = {
  'org.springframework.web.server.ResponseStatusException': 'org.springframework.web.ErrorResponseException',
  'org.springframework.web.ErrorResponseException': 'org.springframework.core.NestedRuntimeException',
  'org.springframework.core.NestedRuntimeException': 'java.lang.RuntimeException',
  'org.springframework.web.bind.support.WebExchangeBindException': 'org.springframework.web.server.ServerWebInputException',
  'org.springframework.web.server.ServerWebInputException': 'org.springframework.web.server.ResponseStatusException',
  'java.lang.IllegalArgumentException': 'java.lang.RuntimeException',
  'java.lang.IllegalStateException': 'java.lang.RuntimeException',
  'java.lang.NullPointerException': 'java.lang.RuntimeException',
  'java.lang.UnsupportedOperationException': 'java.lang.RuntimeException',
  'java.lang.ArithmeticException': 'java.lang.RuntimeException',
  'java.util.NoSuchElementException': 'java.lang.RuntimeException',
  'java.lang.ClassCastException': 'java.lang.RuntimeException',
  'java.time.format.DateTimeParseException': 'java.time.DateTimeException',
  'java.time.DateTimeException': 'java.lang.RuntimeException',
  'java.lang.ArrayIndexOutOfBoundsException': 'java.lang.IndexOutOfBoundsException',
  'java.lang.IndexOutOfBoundsException': 'java.lang.RuntimeException',
  'org.springframework.security.access.AccessDeniedException': 'java.lang.RuntimeException',
  'org.springframework.dao.IncorrectResultSizeDataAccessException': 'org.springframework.dao.DataRetrievalFailureException',
  'org.springframework.dao.DataRetrievalFailureException': 'org.springframework.dao.NonTransientDataAccessException',
  'org.springframework.dao.DuplicateKeyException': 'org.springframework.dao.DataIntegrityViolationException',
  'org.springframework.dao.DataIntegrityViolationException': 'org.springframework.dao.NonTransientDataAccessException',
  'org.springframework.dao.NonTransientDataAccessException': 'org.springframework.dao.DataAccessException',
  'org.springframework.dao.TransientDataAccessResourceException': 'org.springframework.dao.TransientDataAccessException',
  'org.springframework.dao.OptimisticLockingFailureException': 'org.springframework.dao.ConcurrencyFailureException',
  'org.springframework.dao.ConcurrencyFailureException': 'org.springframework.dao.TransientDataAccessException',
  'org.springframework.dao.TransientDataAccessException': 'org.springframework.dao.DataAccessException',
  'org.springframework.dao.DataAccessException': 'org.springframework.core.NestedRuntimeException',
  'java.lang.RuntimeException': 'java.lang.Exception',
  'java.lang.Exception': 'java.lang.Throwable',
};

export const VALIDATION_EXCEPTION = 'org.springframework.web.bind.support.WebExchangeBindException';

interface Handler {
  exceptions: string[];
  method: MethodDecl;
}

interface Advice {
  decl: TypeDecl;
  order: number;
  assignableTypes: string[];
  basePackages: string[];
  annotations: string[];
  handlers: Handler[];
}

/**
 * Index of @ExceptionHandler methods (in advices and controllers). Given an
 * exception, it reproduces Spring's handler choice: controller-local first,
 * then advices by order, closest exception type within one advice.
 */
export class ExceptionHandlers {
  private readonly advices: Advice[] = [];

  constructor(private readonly project: JavaProject) {
    for (const decl of project.types.values()) {
      const annotation = decl.annotations.find((candidate) => candidate.name === 'RestControllerAdvice' || candidate.name === 'ControllerAdvice');
      if (annotation === undefined || !project.profileActive(decl)) continue;
      const orderAnnotation = decl.annotations.find((candidate) => candidate.name === 'Order');
      const orderValue = orderAnnotation?.args.get('value');
      this.advices.push({
        decl,
        order: orderValue === undefined ? Number.MAX_SAFE_INTEGER : orderConstant(orderValue.text),
        assignableTypes: classList(project, decl, annotation.args.get('assignableTypes')),
        basePackages: stringList(annotation.args.get('basePackages') ?? annotation.args.get('value')),
        annotations: classList(project, decl, annotation.args.get('annotations')),
        handlers: this.handlersOf(decl),
      });
    }
  }

  private handlersOf(decl: TypeDecl): Handler[] {
    const out: Handler[] = [];
    for (const method of decl.methods) {
      const annotation = method.annotations.find((candidate) => candidate.name === 'ExceptionHandler');
      if (annotation === undefined) continue;
      let exceptions = classList(this.project, decl, annotation.args.get('value'));
      if (exceptions.length === 0) {
        exceptions = method.params.map((param) => param.type.name).filter((name) => /(Exception|Error|Throwable)$/.test(name));
      }
      out.push({ exceptions, method });
    }
    return out;
  }

  /** Ancestor chain of an exception class, closest first. */
  chain(cls: string): string[] {
    const out: string[] = [];
    let current: string | undefined = cls;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      out.push(current);
      const decl = this.project.type(current);
      current = decl !== undefined ? decl.superclass?.name ?? 'java.lang.RuntimeException' : LIBRARY_HIERARCHY[current];
    }
    return out;
  }

  /** Candidate handler for an exception thrown from `controller`, or undefined. */
  find(controller: TypeDecl, cls: string): { handler: Handler; owner: TypeDecl } | undefined {
    const chain = this.chain(cls);
    const closest = (handlers: Handler[]) => {
      let best: { handler: Handler; distance: number } | undefined;
      for (const handler of handlers) {
        for (const exception of handler.exceptions) {
          const distance = chain.findIndex((name) => name === exception || name.endsWith(`.${exception}`));
          if (distance >= 0 && (best === undefined || distance < best.distance)) best = { handler, distance };
        }
      }
      return best?.handler;
    };
    const local = closest(this.handlersOf(controller));
    if (local !== undefined) return { handler: local, owner: controller };
    const applicable = this.advices.filter((advice) => this.applies(advice, controller)).sort((a, b) => a.order - b.order);
    let found: { handler: Handler; owner: TypeDecl; order: number } | undefined;
    for (const advice of applicable) {
      const handler = closest(advice.handlers);
      if (handler === undefined) continue;
      if (found === undefined) found = { handler, owner: advice.decl, order: advice.order };
      else if (advice.order === found.order && found.owner !== advice.decl) {
        // Spring's choice between unordered advices is registration order: only safe when both agree.
        const a = staticStatus(found.handler.method);
        const b = staticStatus(handler.method);
        if (a === undefined || a !== b) {
          throw new Unsupported(`Exception ${cls.slice(cls.lastIndexOf('.') + 1)} is handled by two unordered advices (${found.owner.simple}, ${advice.decl.simple})`);
        }
        found = { ...found, ambiguousBody: true } as typeof found;
      }
    }
    return found;
  }

  private applies(advice: Advice, controller: TypeDecl): boolean {
    const scoped = advice.assignableTypes.length > 0 || advice.basePackages.length > 0 || advice.annotations.length > 0;
    if (!scoped) return true;
    const supertypes = this.project.supertypeNames(controller);
    if (advice.assignableTypes.some((type) => supertypes.has(type))) return true;
    if (advice.basePackages.some((pkg) => controller.pkg === pkg || controller.pkg.startsWith(`${pkg}.`))) return true;
    if (advice.annotations.some((name) => controller.annotations.some((annotation) => name.endsWith(annotation.name)))) return true;
    return false;
  }
}

/**
 * Builds ErrorSpecs for one controller. The handler body is evaluated
 * symbolically so the local error carries the same status, code and body.
 */
export class ControllerErrorMapper implements ErrorMapper {
  private readonly cache = new Map<string, ErrorSpec>();

  constructor(
    private readonly handlers: ExceptionHandlers,
    private readonly controller: TypeDecl,
    private readonly ev: () => Evaluator,
    private readonly jackson: () => JacksonModel,
  ) {}

  map(exception: ExceptionSV): ErrorSpec {
    const key = `${exception.cls}#${exception.status ?? ''}`;
    let template = this.cache.get(key);
    if (template === undefined) {
      template = this.resolve(exception);
      this.cache.set(key, template);
    }
    return { ...template, message: exception.message, exception: exception.cls };
  }

  private resolve(exception: ExceptionSV): ErrorSpec {
    const found = this.handlers.find(this.controller, exception.cls);
    const simple = exception.cls.slice(exception.cls.lastIndexOf('.') + 1);
    const fallbackStatus = exception.status ?? this.annotatedStatus(exception.cls) ?? (exception.cls === VALIDATION_EXCEPTION ? 400 : 500);
    const code = simple.replace(/Exception$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() || 'ERROR';
    if (found === undefined) return { status: fallbackStatus, code, message: NULL };
    const evaluated = (found as { ambiguousBody?: boolean }).ambiguousBody === true ? undefined : this.evaluateHandler(found.handler.method, found.owner, exception);
    if (evaluated !== undefined) return { status: evaluated.status, code: evaluated.code ?? code, message: NULL, ...(evaluated.body === undefined ? {} : { body: evaluated.body }) };
    const status = staticStatus(found.handler.method) ?? fallbackStatus;
    return { status, code: literalCode(found.handler.method) ?? code, message: NULL };
  }

  private annotatedStatus(cls: string): number | undefined {
    for (const name of this.handlers.chain(cls)) {
      const decl = this.ev().project.type(name);
      const annotation = decl?.annotations.find((candidate) => candidate.name === 'ResponseStatus');
      if (annotation !== undefined) {
        const value = annotation.args.get('value') ?? annotation.args.get('code');
        const status = value === undefined ? undefined : statusFromText(value.text);
        if (status !== undefined) return status;
      }
    }
    return undefined;
  }

  /** Evaluates the handler with a symbolic exception whose message is `$message`. */
  private evaluateHandler(method: MethodDecl, owner: TypeDecl, exception: ExceptionSV): { status: number; body?: Expr; code?: string } | undefined {
    const ev = this.ev();
    if (method.params.length !== 1 || method.body === undefined) return undefined;
    const block = new Block({ vars: 0, uuidSlots: 0 });
    const symbolic: ExceptionSV = { ...exception, message: vr('$message') };
    try {
      const result = ev.inline(method, { t: 'bean', cls: owner }, [symbolic], method.node, { env: new Env(), self: undefined, owner, block });
      if (block.instrs.length > 0) return undefined;
      const annotated = staticStatusAnnotation(method);
      const response = result.t === 'mono' ? result.run(block).value : result;
      if (block.instrs.length > 0) return undefined;
      const scope = { env: new Env(), self: undefined, owner, block };
      if (response.t === 'response') {
        const body = response.body === undefined ? undefined : this.jackson().serialize(response.body, method.node, scope);
        if (block.instrs.length > 0 || (body !== undefined && !onlyMessageVariable(body))) return { status: response.status, code: literalCode(method) };
        return { status: response.status, ...(body === undefined ? {} : { body }), code: literalCode(method) };
      }
      if (annotated !== undefined && (response.t === 'obj' || response.t === 'pure')) {
        const body = this.jackson().serialize(response, method.node, scope);
        if (block.instrs.length > 0 || !onlyMessageVariable(body)) return { status: annotated, code: literalCode(method) };
        return { status: annotated, body, code: literalCode(method) };
      }
      return undefined;
    } catch (error) {
      if (error instanceof Unsupported) return undefined;
      throw error;
    }
  }
}

function onlyMessageVariable(expr: Expr): boolean {
  const text = JSON.stringify(expr);
  const vars = [...text.matchAll(/"k":"var","name":"([^"]+)"/g)].map((match) => match[1]);
  return vars.every((name) => name === '$message') && !text.includes('"k":"uuid"') && !text.includes('"k":"input"');
}

function staticStatusAnnotation(method: MethodDecl): number | undefined {
  const annotation = method.annotations.find((candidate) => candidate.name === 'ResponseStatus');
  const value = annotation?.args.get('value') ?? annotation?.args.get('code');
  return value === undefined ? undefined : statusFromText(value.text);
}

function staticStatus(method: MethodDecl): number | undefined {
  const annotated = staticStatusAnnotation(method);
  if (annotated !== undefined) return annotated;
  const text = method.body?.text ?? '';
  const statuses = new Set([...text.matchAll(/HttpStatus\.([A-Z_]+)/g)].map((match) => HTTP_STATUS[match[1]!]).filter((code): code is number => code !== undefined));
  for (const [pattern, code] of [[/\.badRequest\(\)/, 400], [/\.notFound\(\)/, 404], [/\.unprocessableEntity\(\)/, 422], [/\.internalServerError\(\)/, 500]] as const) {
    if (pattern.test(text)) statuses.add(code);
  }
  return statuses.size === 1 ? [...statuses][0] : undefined;
}

function literalCode(method: MethodDecl): string | undefined {
  const codes = [...(method.body?.text ?? '').matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((match) => match[1]!);
  return new Set(codes).size === 1 ? codes[0] : undefined;
}

function statusFromText(text: string): number | undefined {
  const name = /HttpStatus\.([A-Z_]+)/.exec(text)?.[1];
  if (name !== undefined) return HTTP_STATUS[name];
  const numeric = Number(text);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function orderConstant(text: string): number {
  if (/HIGHEST_PRECEDENCE/.test(text)) return -2147483648;
  if (/LOWEST_PRECEDENCE/.test(text)) return 2147483647;
  const value = Number(text.replace(/[^-\d]/g, ''));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function stringList(node: SyntaxNode | undefined): string[] {
  if (node === undefined) return [];
  const items = node.type === 'element_value_array_initializer' ? named(node) : [node];
  return items.map((item) => stringValue(item)).filter((item): item is string => item !== undefined);
}

function classList(project: JavaProject, context: TypeDecl, node: SyntaxNode | undefined): string[] {
  if (node === undefined) return [];
  const items = node.type === 'element_value_array_initializer' ? named(node) : [node];
  return items
    .filter((item) => item.type === 'class_literal')
    .map((item) => {
      const typeNode = named(item)[0]!;
      return project.parseType(typeNode, context).name;
    });
}

export { lit };
