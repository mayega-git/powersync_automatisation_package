import type {
  OfflineClass,
  AuthRequirement,
  EndpointPlan,
  ErrorSpec,
  Evidence,
  Expr,
  FieldType,
  HttpMethod,
  InputSpec,
  Instr,
} from '../../ir/types.js';
import type { CompilerConfig } from '../config.js';
import { typeName, type Annotation, type JavaProject, type JType, type MethodDecl, type Param, type TypeDecl } from '../java/model.js';
import { field, named, stringValue, type SyntaxNode } from '../java/parser.js';
import { Diverged, emitIf } from './branching.js';
import { ControllerErrorMapper, VALIDATION_EXCEPTION, type ExceptionHandlers } from './errors.js';
import { Evaluator, type Scope } from './evaluator.js';
import { HTTP_STATUS } from './library.js';
import { fieldTypeOf, type EntityModel, type PersistenceModel } from './persistence.js';
import { JacksonModel } from './serialize.js';
import { compilePolicy } from './policies.js';
import {
  and,
  Block,
  Env,
  FALSE,
  isLit,
  lit,
  not,
  NULL,
  obj,
  op,
  pure,
  T,
  Unsupported,
  VOID,
  type ObjSV,
  type SV,
} from './sv.js';

const OPAQUE_PARAMETERS = new Set([
  'ServerHttpRequest', 'ServerHttpResponse', 'ServerWebExchange', 'Authentication', 'Principal', 'JwtAuthenticationToken',
  'AbstractAuthenticationToken', 'UsernamePasswordAuthenticationToken', 'Jwt', 'WebSession', 'Locale', 'TimeZone', 'ZoneId',
]);

const MAPPINGS: Readonly<Record<string, HttpMethod | undefined>> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE', RequestMapping: undefined,
};

/** Everything the compiler learned about one endpoint. */
export interface EndpointDraft {
  id: string;
  method: HttpMethod;
  path: string;
  handler: { file: string; symbol: string };
  input: InputSpec;
  output: { status: number; list: boolean; empty: boolean };
  auth: AuthRequirement;
  program?: Instr[];
  uuidSlots: number;
  reads: string[];
  writes: string[];
  entities: EntityModel[];
  evidence: Evidence[];
  /** Why no program could be proven (fail-closed). */
  unsupported?: string;
  /** External effect found: online only. */
  external?: string;
  /** Behaviors the local plan does not reproduce exactly (validation, nested input). */
  speculative: string[];
  /** From @AerisOnlineOnly / @AerisOffline: restricts the computed class. */
  declared?: { offlineClass: OfflineClass; reason: string };
  runtimeErrors?: Record<string, ErrorSpec>;
  opaqueFailures?: string[];
}

/** Java exception behind each failure the runtime detects itself (status for ResponseStatusException kinds). */
const RUNTIME_FAILURES: Readonly<Record<string, { cls: string; status?: number }>> = {
  NULL_DEREFERENCE: { cls: 'java.lang.NullPointerException' },
  ARITHMETIC: { cls: 'java.lang.ArithmeticException' },
  CAST: { cls: 'java.lang.IllegalArgumentException' },
  TYPE_MISMATCH: { cls: 'java.lang.ClassCastException' },
  INCORRECT_RESULT_SIZE: { cls: 'org.springframework.dao.IncorrectResultSizeDataAccessException' },
  DUPLICATE_KEY: { cls: 'org.springframework.dao.DuplicateKeyException' },
  NOT_NULL_VIOLATION: { cls: 'org.springframework.dao.DataIntegrityViolationException' },
  VALUE_TOO_LONG: { cls: 'org.springframework.dao.DataIntegrityViolationException' },
  ROW_NOT_FOUND: { cls: 'org.springframework.dao.TransientDataAccessResourceException' },
  MISSING_PATH_VARIABLE: { cls: 'org.springframework.web.server.ServerWebInputException', status: 400 },
  MISSING_PARAMETER: { cls: 'org.springframework.web.server.ServerWebInputException', status: 400 },
  MISSING_BODY: { cls: 'org.springframework.web.server.ServerWebInputException', status: 400 },
  INVALID_BODY: { cls: 'org.springframework.web.server.ServerWebInputException', status: 400 },
  INVALID_VALUE: { cls: 'org.springframework.web.server.ServerWebInputException', status: 400 },
  ACCESS_DENIED: { cls: 'org.springframework.security.access.AccessDeniedException', status: 403 },
  ARRAY_INDEX: { cls: 'java.lang.ArrayIndexOutOfBoundsException' },
  LIST_INDEX: { cls: 'java.lang.IndexOutOfBoundsException' },
};

function runtimeErrors(evaluator: Evaluator): { runtimeErrors?: Record<string, ErrorSpec>; opaqueFailures?: string[] } {
  const errors: Record<string, ErrorSpec> = {};
  const opaque: string[] = [];
  for (const [failure, { cls, status }] of Object.entries(RUNTIME_FAILURES)) {
    let spec: ErrorSpec;
    try {
      // The ResponseStatusException family carries its status; AccessDeniedException's is applied by Spring Security.
      const exception = { t: 'exception' as const, cls, message: NULL, ...(status === undefined || failure === 'ACCESS_DENIED' ? {} : { status }) };
      spec = evaluator.errors.map(exception);
      if (spec.unreproducible === true) {
        opaque.push(failure);
        continue;
      }
      if (failure === 'ACCESS_DENIED' && spec.status === 500 && spec.body === undefined) spec = { ...spec, status: 403 };
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      opaque.push(failure);
      continue;
    }
    // Without a handler the runtime's own default (Spring's default error response) already applies.
    if (spec.body !== undefined || spec.status !== (status ?? 500)) errors[failure] = { ...spec };
  }
  return {
    ...(Object.keys(errors).length > 0 ? { runtimeErrors: errors } : {}),
    ...(opaque.length > 0 ? { opaqueFailures: opaque } : {}),
  };
}

export interface CompileContext {
  project: JavaProject;
  persistence: PersistenceModel;
  config: CompilerConfig;
  handlers: ExceptionHandlers;
}

/** Discovers every @RestController handler and compiles it. */
export function compileEndpoints(context: CompileContext, diagnostics: string[]): EndpointDraft[] {
  const drafts: EndpointDraft[] = [];
  for (const controller of context.project.types.values()) {
    if (controller.kind !== 'class' || !isController(controller) || !context.project.profileActive(controller)) continue;
    const classMapping = controller.annotations.find((annotation) => annotation.name === 'RequestMapping');
    const classPaths = classMapping === undefined ? [''] : pathsOf(classMapping, context.project, controller);
    if (classPaths === undefined) {
      diagnostics.push(`${controller.file.path}: ${controller.simple} has a non-constant class-level mapping.`);
      continue;
    }
    for (const method of controller.methods) {
      for (const annotation of method.annotations) {
        if (!(annotation.name in MAPPINGS)) continue;
        const methods = httpMethods(annotation);
        const paths = pathsOf(annotation, context.project, controller);
        if (methods.length === 0 || paths === undefined) {
          diagnostics.push(`${controller.file.path}:${method.node.startPosition.row + 1}: ${controller.simple}.${method.name} has a dynamic or unsupported mapping.`);
          continue;
        }
        for (const httpMethod of methods) {
          for (const classPath of classPaths) {
            for (const methodPath of paths) {
              drafts.push(compileEndpoint(context, controller, method, annotation, httpMethod, joinPath(classPath, methodPath)));
            }
          }
        }
      }
    }
  }
  return deduplicate(drafts, diagnostics);
}

function isController(type: TypeDecl): boolean {
  return type.annotations.some((annotation) => annotation.name === 'RestController' ||
    (annotation.name === 'Controller' && type.annotations.some((other) => other.name === 'ResponseBody')));
}

function httpMethods(annotation: Annotation): HttpMethod[] {
  const fixed = MAPPINGS[annotation.name];
  if (fixed !== undefined) return [fixed];
  const value = annotation.args.get('method');
  if (value === undefined) return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const items = value.type === 'element_value_array_initializer' ? named(value) : [value];
  return items.map((item) => /RequestMethod\.([A-Z]+)/.exec(item.text)?.[1]).filter((name): name is HttpMethod => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(name ?? ''));
}

/** Constant paths of a mapping annotation; undefined when not statically known. */
function pathsOf(annotation: Annotation, project: JavaProject, owner: TypeDecl): string[] | undefined {
  if (annotation.args.has('params') || annotation.args.has('headers')) return undefined;
  const value = annotation.args.get('value') ?? annotation.args.get('path');
  if (value === undefined) return [''];
  const items = value.type === 'element_value_array_initializer' ? named(value) : [value];
  const out: string[] = [];
  for (const item of items) {
    const text = constantString(item, project, owner);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out.length === 0 ? [''] : out;
}

function constantString(node: SyntaxNode, project: JavaProject, owner: TypeDecl): string | undefined {
  if (node.type === 'string_literal') return stringValue(node);
  if (node.type === 'binary_expression' && field(node, 'operator')?.type === '+') {
    const left = constantString(field(node, 'left')!, project, owner);
    const right = constantString(field(node, 'right')!, project, owner);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === 'identifier' || node.type === 'field_access') {
    const parts = node.text.split('.');
    const name = parts.pop()!;
    const type = parts.length === 0 ? owner : project.type(project.resolveTypeName(parts.join('.'), owner) ?? '');
    const decl = type === undefined ? undefined : project.staticField(type, name);
    if (decl?.initializer !== undefined && decl.modifiers.has('final')) return constantString(decl.initializer, project, decl.owner);
  }
  return undefined;
}

export function joinPath(base: string, path: string): string {
  const joined = `/${base}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
}

/** Route shape: variable names do not matter to the router (Spring treats /x/{a} and /x/{b} as the same). */
export function routeShape(method: string, path: string): string {
  return `${method} ${path.replace(/\{[^}]*\}/g, '{}')}`;
}

function deduplicate(drafts: EndpointDraft[], diagnostics: string[]): EndpointDraft[] {
  const byId = new Map<string, EndpointDraft>();
  const byShape = new Map<string, EndpointDraft[]>();
  for (const draft of drafts) {
    const existing = byId.get(draft.id);
    if (existing === undefined) byId.set(draft.id, draft);
    else {
      diagnostics.push(`${draft.id} is mapped by ${existing.handler.symbol} and ${draft.handler.symbol}.`);
      byId.set(draft.id, { ...existing, program: undefined, unsupported: 'Several handlers map the same route.' });
    }
  }
  for (const draft of byId.values()) {
    const shape = routeShape(draft.method, draft.path);
    byShape.set(shape, [...(byShape.get(shape) ?? []), draft]);
  }
  for (const group of byShape.values()) {
    if (group.length < 2) continue;
    diagnostics.push(`Ambiguous mappings: ${group.map((draft) => `${draft.id} (${draft.handler.symbol})`).join(', ')}.`);
    for (const draft of group) byId.set(draft.id, { ...draft, program: undefined, unsupported: 'Ambiguous mapping: another handler matches the same requests.' });
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// One endpoint
// ---------------------------------------------------------------------------

function compileEndpoint(
  context: CompileContext,
  controller: TypeDecl,
  method: MethodDecl,
  mapping: Annotation,
  httpMethod: HttpMethod,
  path: string,
): EndpointDraft {
  let ev: Evaluator | undefined;
  let jackson: JacksonModel | undefined;
  const errors = new ControllerErrorMapper(context.handlers, controller, () => ev!, () => jackson!);
  ev = new Evaluator(context.project, context.persistence, context.config, errors);
  jackson = new JacksonModel(ev);
  const evaluator = ev;
  const id = `${httpMethod} ${path}`;
  const handler = { file: controller.file.path, symbol: `${controller.simple}.${method.name}` };
  evaluator.record('route', mapping.node, controller.file.path, handler.symbol);
  evaluator.record('handler', method.node, controller.file.path, handler.symbol);

  const input: InputSpec & { params: Record<string, FieldType>; query: Record<string, FieldType & { required: boolean }> } = { params: {}, query: {} };
  const auth: { authenticated: boolean; context: string[]; policies: string[]; checks: { policy: string; test: Expr }[] } = { authenticated: true, context: [], policies: [], checks: [] };
  const speculative: string[] = [];
  const onlineOnly = [...controller.annotations, ...method.annotations].find((annotation) => annotation.name === 'AerisOnlineOnly');
  const offlineAnnotation = method.annotations.find((annotation) => annotation.name === 'AerisOffline');
  const declaredPolicy = /([A-Z_]+)\s*$/.exec(offlineAnnotation?.args.get('policy')?.text ?? '')?.[1] as OfflineClass | undefined;
  const declared = onlineOnly !== undefined
    ? { offlineClass: 'ONLINE_REQUIRED' as OfflineClass, reason: `@AerisOnlineOnly${onlineOnly.args.get('value') ? `: ${stringValue(onlineOnly.args.get('value')!) ?? ''}` : ''}` }
    : declaredPolicy !== undefined ? { offlineClass: declaredPolicy, reason: `@AerisOffline(policy = ${declaredPolicy})` } : undefined;
  const draft = (extra: Partial<EndpointDraft>): EndpointDraft => ({
    ...(declared === undefined ? {} : { declared }),
    id,
    method: httpMethod,
    path,
    handler,
    input,
    output: { status: 200, list: false, empty: false },
    auth: {
      authenticated: auth.authenticated,
      context: auth.context,
      ...(auth.policies.length > 0 ? { policies: auth.policies } : {}),
      ...(auth.checks.length > 0 ? { checks: auth.checks } : {}),
    },
    uuidSlots: evaluator.counters.uuidSlots,
    reads: [...evaluator.reads],
    writes: [...evaluator.writes],
    entities: [...evaluator.entities.values()],
    evidence: evaluator.evidence,
    speculative,
    ...extra,
  });

  for (const annotation of [...controller.annotations, ...method.annotations]) {
    if (annotation.name === 'PreAuthorize' || annotation.name === 'PostAuthorize') {
      const valueNode = annotation.args.get('value');
      const expression = valueNode === undefined ? undefined : constantString(valueNode, context.project, controller);
      if (expression === undefined) return draft({ unsupported: 'Authorization expression is not constant.' });
      if (annotation.name === 'PostAuthorize') return draft({ unsupported: '@PostAuthorize depends on the returned value.' });
      auth.policies.push(expression);
      const compiled = compilePolicy(expression, evaluator);
      if (compiled !== undefined) auth.checks.push({ policy: expression, test: compiled });
      evaluator.record('authorization', annotation.node, controller.file.path, handler.symbol);
    } else if (annotation.name === 'Secured' || annotation.name === 'RolesAllowed') {
      return draft({ unsupported: `@${annotation.name} is not modeled.` });
    } else if (annotation.name === 'PermitAll') {
      auth.authenticated = false;
    }
  }
  if (path.includes('*') || /\{[^}]*:/.test(path)) return draft({ unsupported: 'Route uses wildcards or regular-expression variables.' });

  const block = new Block(evaluator.counters);
  const scope: Scope = { env: new Env(), self: { t: 'bean', cls: controller }, owner: controller, block };
  try {
    const args = bindParameters(evaluator, context, method, path, input, scope, speculative);
    const result = evaluator.inline(method, scope.self, args, method.node, scope);
    const output = finalize(evaluator, jackson, method, result, scope);
    const program = block.instrs;
    if (evaluator.writes.size > 0) insertQueueIntent(program);
    const claims = new Set<string>();
    collectClaims(program, claims);
    collectClaims(auth.checks, claims);
    auth.context.push(...[...claims].sort());
    return draft({ program, output, uuidSlots: evaluator.counters.uuidSlots, ...runtimeErrors(evaluator) });
  } catch (error) {
    if (error instanceof Diverged) return draft({ unsupported: 'The handler always fails.' });
    if (error instanceof Unsupported) {
      return error.external ? draft({ external: error.reason }) : draft({ unsupported: error.reason });
    }
    throw error;
  }
}

/** Binds handler parameters to symbolic request values and emits Bean Validation checks. */
function bindParameters(
  ev: Evaluator,
  context: CompileContext,
  method: MethodDecl,
  path: string,
  input: InputSpec & { params: Record<string, FieldType>; query: Record<string, FieldType & { required: boolean }> },
  scope: Scope,
  speculative: string[],
): SV[] {
  const variables = new Set([...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!));
  const args: SV[] = [];
  const validations: (() => void)[] = [];
  for (const param of method.params) {
    const annotation = (name: string) => param.annotations.find((candidate) => candidate.name === name);
    const valid = annotation('Valid') ?? annotation('Validated');
    const pathVariable = annotation('PathVariable');
    const requestParam = annotation('RequestParam');
    const body = annotation('RequestBody');
    const typeOk = (jt: JType, what: string): FieldType => {
      const type = fieldTypeOf(context.project, jt);
      if (type === undefined) throw new Unsupported(`${what} ${param.name} has type ${typeName(jt)}, which is not a scalar`);
      return type;
    };
    if (pathVariable !== undefined) {
      const name = annotationName(pathVariable) ?? param.name;
      if (!variables.has(name)) throw new Unsupported(`@PathVariable ${name} is not in the route ${path}`);
      input.params[name] = { ...typeOk(param.type, 'Path variable'), nullable: false };
      args.push(pure({ k: 'param', name }, param.type));
    } else if (requestParam !== undefined || (isSimple(context.project, param.type) && body === undefined && annotation('ModelAttribute') === undefined)) {
      const name = (requestParam === undefined ? undefined : annotationName(requestParam)) ?? param.name;
      const defaultNode = requestParam?.args.get('defaultValue');
      const required = requestParam === undefined ? false : requestParam.args.get('required')?.text !== 'false' && defaultNode === undefined;
      const type = typeOk(param.type, 'Request parameter');
      if (!required && defaultNode === undefined && !type.nullable) throw new Unsupported(`Optional primitive parameter ${name} would fail when absent`);
      input.query[name] = { ...type, required };
      let value: Expr = { k: 'query', name };
      if (defaultNode !== undefined) value = op('coalesce', value, { k: 'cast', to: type.type, of: lit(stringValue(defaultNode) ?? ''), ...(type.values ? { values: type.values } : {}) });
      args.push(pure(value, param.type));
    } else if (body !== undefined) {
      const reactive = ['Mono', 'Flux'].includes(typeName(param.type));
      if (typeName(param.type) === 'Flux') throw new Unsupported('Streaming request bodies are not modeled');
      const dtoType = reactive ? param.type.args[0]! : param.type;
      const dto = bodyObject(ev, context, dtoType, input, speculative);
      input.body = { required: body.args.get('required')?.text !== 'false', fields: input.body?.fields ?? {} };
      if (valid !== undefined) validations.push(() => validate(ev, context, dto, [], scope, speculative, 0));
      args.push(reactive ? { t: 'mono', elem: dtoType, run: () => ({ value: dto, empty: FALSE }) } : dto);
    } else if (annotation('ModelAttribute') !== undefined || context.project.type(param.type.name)?.kind === 'class' || context.project.type(param.type.name)?.kind === 'record') {
      const dto = queryObject(ev, context, param.type, input);
      if (valid !== undefined) validations.push(() => validate(ev, context, dto, [], scope, speculative, 0));
      args.push(dto);
    } else if (AUTHENTICATION_PARAMETERS.has(typeName(param.type)) && context.config.context.authentication !== undefined) {
      args.push(ev.authenticationValue(context.config.context.authentication, param.node ?? method.node));
    } else if (typeName(param.type) === 'ServerHttpRequest') {
      args.push({ t: 'opaque', what: `ServerHttpRequest ${param.name}`, path: pathExpression(path) });
    } else if (OPAQUE_PARAMETERS.has(typeName(param.type)) || annotation('AuthenticationPrincipal') !== undefined) {
      // Passed along freely; any read of it makes the endpoint unsupported.
      args.push({ t: 'opaque', what: `${typeName(param.type)} ${param.name}` });
    } else {
      throw new Unsupported(`Handler parameter ${param.name} (${typeName(param.type)}) is not modeled`);
    }
  }
  for (const validation of validations) validation();
  return args;
}

const AUTHENTICATION_PARAMETERS = new Set(['Authentication', 'AbstractAuthenticationToken']);

/** The concrete request path for a route template, built from its path variables. */
function pathExpression(template: string): Expr {
  const parts: Expr[] = [];
  let rest = template;
  for (const match of template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const [before] = rest.split(match[0]);
    if (before) parts.push(lit(before));
    parts.push({ k: 'param', name: match[1]! });
    rest = rest.slice((before ?? '').length + match[0].length);
  }
  if (rest) parts.push(lit(rest));
  return parts.length === 1 && parts[0]!.k === 'lit' ? parts[0]! : op('concat', ...parts);
}

function annotationName(annotation: Annotation): string | undefined {
  const node = annotation.args.get('value') ?? annotation.args.get('name');
  return node === undefined ? undefined : stringValue(node);
}

function isSimple(project: JavaProject, jt: JType): boolean {
  return fieldTypeOf(project, jt) !== undefined;
}

/** Request body as an object whose properties read the bound input. */
function bodyObject(ev: Evaluator, context: CompileContext, jt: JType, input: InputSpec & { body?: InputSpec['body'] }, speculative: string[]): ObjSV {
  const decl = context.project.type(jt.name);
  if (decl === undefined || (decl.kind !== 'class' && decl.kind !== 'record')) throw new Unsupported(`Request body type ${typeName(jt)} is not a DTO in the sources`);
  if (decl.annotations.some((annotation) => ['JsonTypeInfo', 'JsonDeserialize', 'JsonCreator'].includes(annotation.name))) {
    throw new Unsupported(`Request body ${decl.simple} uses custom Jackson deserialization`);
  }
  const fields: Record<string, FieldType> = {};
  const values = new Map<string, SV>();
  for (const property of ev.properties(decl.fqn)) {
    const declField = context.project.instanceFields(decl).find((candidate) => candidate.name === property.name);
    const component = decl.recordComponents.find((candidate) => candidate.name === property.name);
    const annotations = [...(declField?.annotations ?? []), ...(component?.annotations ?? [])];
    if (annotations.some((annotation) => annotation.name === 'JsonIgnore')) {
      values.set(property.name, defaultOf(property.jt));
      continue;
    }
    const renamed = annotations.find((annotation) => annotation.name === 'JsonProperty');
    const jsonName = renamed === undefined ? property.name : annotationName(renamed) ?? property.name;
    const scalarType = fieldTypeOf(context.project, property.jt);
    const listElement = ['java.util.List', 'java.util.Set', 'java.util.Collection'].includes(property.jt.name) ? property.jt.args[0] : undefined;
    const listType = listElement === undefined ? undefined : fieldTypeOf(context.project, listElement);
    let read: Expr = { k: 'input', path: [jsonName] };
    if (scalarType !== undefined) {
      fields[jsonName] = scalarType;
      if (!scalarType.nullable) read = op('coalesce', read, scalarType.type === 'boolean' ? lit(false) : lit(0));
    } else if (listType !== undefined) {
      fields[jsonName] = { ...listType, list: true, nullable: true };
    } else {
      fields[jsonName] = { type: 'json', nullable: true };
      speculative.push(`Nested request object ${decl.simple}.${property.name} is not validated locally.`);
    }
    values.set(property.name, ev.view(read, property.jt));
  }
  input.body = { required: true, fields };
  return obj(decl.fqn, values);
}

/** @ModelAttribute object bound from query parameters. */
function queryObject(ev: Evaluator, context: CompileContext, jt: JType, input: InputSpec & { query: Record<string, FieldType & { required: boolean }> }): ObjSV {
  const decl = context.project.type(jt.name);
  if (decl === undefined) throw new Unsupported(`Query object ${typeName(jt)} is not in the sources`);
  const values = new Map<string, SV>();
  for (const property of ev.properties(decl.fqn)) {
    const type = fieldTypeOf(context.project, property.jt);
    if (type === undefined) throw new Unsupported(`Query object property ${decl.simple}.${property.name} is not a scalar`);
    input.query[property.name] = { ...type, required: false };
    values.set(property.name, pure(type.nullable ? { k: 'query', name: property.name } : op('coalesce', { k: 'query', name: property.name }, lit(type.type === 'boolean' ? false : 0)), property.jt));
  }
  return obj(decl.fqn, values);
}

function defaultOf(jt: JType): SV {
  return pure(['int', 'long', 'short', 'byte', 'double', 'float'].includes(jt.name) ? lit(0) : jt.name === 'boolean' ? lit(false) : NULL, jt);
}

// ---------------------------------------------------------------------------
// Bean Validation
// ---------------------------------------------------------------------------

const EXACT_CONSTRAINTS = new Set(['NotNull', 'NotBlank', 'NotEmpty', 'Size', 'Min', 'Max', 'Positive', 'PositiveOrZero', 'Negative', 'NegativeOrZero', 'DecimalMin', 'DecimalMax', 'Null', 'AssertTrue', 'AssertFalse', 'Valid']);

function validate(ev: Evaluator, context: CompileContext, dto: ObjSV, prefix: string[], scope: Scope, speculative: string[], depth: number): void {
  const decl = context.project.type(dto.cls)!;
  const error = ev.errors.map({ t: 'exception', cls: VALIDATION_EXCEPTION, message: NULL });
  for (const property of ev.properties(decl.fqn)) {
    const declField = context.project.instanceFields(decl).find((candidate) => candidate.name === property.name);
    const component = decl.recordComponents.find((candidate) => candidate.name === property.name);
    const annotations = [...(declField?.annotations ?? []), ...(component?.annotations ?? [])];
    const value = ev.readField(dto, property.name);
    const label = [...prefix, property.name].join('.');
    for (const annotation of annotations) {
      if (!EXACT_CONSTRAINTS.has(annotation.name)) {
        if (/^[A-Z]/.test(annotation.name) && isConstraint(context.project, annotation)) {
          speculative.push(`Constraint @${annotation.name} on ${label} is checked by the server only.`);
        }
        continue;
      }
      if (annotation.args.has('groups')) {
        speculative.push(`Validation groups on ${label} are checked by the server only.`);
        continue;
      }
      if (annotation.name === 'Valid') {
        if (value.t === 'obj' && depth < 4) validate(ev, context, value, [...prefix, property.name], scope, speculative, depth + 1);
        else speculative.push(`Nested validation of ${label} is checked by the server only.`);
        continue;
      }
      if (value.t !== 'pure' && value.t !== 'list') {
        speculative.push(`Constraint on ${label} is checked by the server only.`);
        continue;
      }
      const e = value.e;
      const test = constraintTest(annotation, e, property.jt);
      if (test === undefined) {
        speculative.push(`@${annotation.name} on ${label} is checked by the server only.`);
        continue;
      }
      scope.block.emit({ op: 'ASSERT', test, error: { ...error, code: error.code === 'WEB_EXCHANGE_BIND' ? 'VALIDATION' : error.code, message: lit(`${label}: ${defaultMessage(annotation)}`) } });
      ev.record('validation', annotation.node, decl.file.path, `${decl.simple}.${property.name}`);
    }
  }
}

function isConstraint(project: JavaProject, annotation: Annotation): boolean {
  const known = ['Email', 'Pattern', 'Past', 'PastOrPresent', 'Future', 'FutureOrPresent', 'Digits', 'URL', 'Length', 'Range', 'UUID'];
  if (known.includes(annotation.name)) return true;
  const decl = [...(project.bySimple.get(annotation.name) ?? [])].find((type) => type.kind === 'annotation');
  return decl?.annotations.some((candidate) => candidate.name === 'Constraint') ?? false;
}

function numberArg(annotation: Annotation, key = 'value'): number | undefined {
  const node = annotation.args.get(key);
  if (node === undefined) return undefined;
  const text = stringValue(node) ?? node.text.replace(/[lL_]/g, '');
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The Hibernate Validator semantics of each supported constraint (null is valid except for @NotX). */
function constraintTest(annotation: Annotation, e: Expr, jt: JType): Expr | undefined {
  const nullOk = (test: Expr) => op('or', op('isNull', e), test);
  const isString = jt.name === 'java.lang.String';
  const sized = (inner: Expr) => (isString ? op('length', inner) : op('size', inner));
  switch (annotation.name) {
    case 'NotNull': return op('notNull', e);
    case 'Null': return op('isNull', e);
    case 'NotBlank': return isString ? not(op('isBlank', e)) : undefined;
    case 'NotEmpty': return and(op('notNull', e), op('gt', sized(e), lit(0)));
    case 'Size': {
      const min = numberArg(annotation, 'min') ?? 0;
      const max = numberArg(annotation, 'max');
      return nullOk(and(op('ge', sized(e), lit(min)), max === undefined ? lit(true) : op('le', sized(e), lit(max))));
    }
    case 'Min': { const v = numberArg(annotation); return v === undefined ? undefined : nullOk(op('ge', e, lit(v))); }
    case 'Max': { const v = numberArg(annotation); return v === undefined ? undefined : nullOk(op('le', e, lit(v))); }
    case 'DecimalMin':
    case 'DecimalMax': {
      const v = numberArg(annotation);
      if (v === undefined) return undefined;
      const inclusive = annotation.args.get('inclusive')?.text !== 'false';
      const cmp = annotation.name === 'DecimalMin' ? (inclusive ? 'ge' : 'gt') : (inclusive ? 'le' : 'lt');
      return nullOk(op(cmp, e, lit(v)));
    }
    case 'Positive': return nullOk(op('gt', e, lit(0)));
    case 'PositiveOrZero': return nullOk(op('ge', e, lit(0)));
    case 'Negative': return nullOk(op('lt', e, lit(0)));
    case 'NegativeOrZero': return nullOk(op('le', e, lit(0)));
    case 'AssertTrue': return nullOk(op('eq', e, lit(true)));
    case 'AssertFalse': return nullOk(op('eq', e, lit(false)));
    default: return undefined;
  }
}

function defaultMessage(annotation: Annotation): string {
  const explicit = annotation.args.get('message');
  if (explicit !== undefined) return stringValue(explicit) ?? 'invalid';
  const messages: Record<string, string> = {
    NotNull: 'must not be null', NotBlank: 'must not be blank', NotEmpty: 'must not be empty', Null: 'must be null',
    Positive: 'must be greater than 0', PositiveOrZero: 'must be greater than or equal to 0',
    Negative: 'must be less than 0', NegativeOrZero: 'must be less than or equal to 0',
  };
  return messages[annotation.name] ?? 'invalid';
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function declaredStatus(method: MethodDecl): number {
  const annotation = method.annotations.find((candidate) => candidate.name === 'ResponseStatus');
  const value = annotation?.args.get('value') ?? annotation?.args.get('code');
  if (value === undefined) return 200;
  const name = /HttpStatus\.([A-Z_]+)/.exec(value.text)?.[1];
  const status = name === undefined ? Number(value.text) : HTTP_STATUS[name];
  if (status === undefined || !Number.isInteger(status)) throw new Unsupported('@ResponseStatus is not a constant');
  return status;
}

function finalize(ev: Evaluator, jackson: JacksonModel, method: MethodDecl, result: SV, scope: Scope): EndpointDraft['output'] {
  const status = declaredStatus(method);
  const block = scope.block;
  const ret = (code: number, body: Expr | null): Instr => {
    // A 5xx answer is reproduced only by programs that do not write (it is never a provisional success).
    if (code < 200 || code > 599 || (code >= 500 && ev.writes.size > 0)) throw new Unsupported(`The handler answers ${code}`);
    return { op: 'RETURN', status: code, body };
  };
  /** Emits the RETURN(s) of a value; a choice of responses becomes IFs. */
  const emitValue = (value: SV, child: Block): { code: number; body: Expr | null } => {
    if (value.t === 'responses') {
      const left = child.child();
      const right = child.child();
      const chosen = emitValue(value.a, left);
      emitValue(value.b, right);
      emitIf(child, value.test, left.instrs, right.instrs);
      return chosen;
    }
    const { code, body } = bodyOf(value, child);
    child.emit(ret(code, body));
    return { code, body };
  };
  const bodyOf = (value: SV, child: Block): { code: number; body: Expr | null } => {
    if (value.t === 'response') {
      return { code: value.status, body: value.body === undefined ? null : jackson.serialize(value.body, method.node, { ...scope, block: child }) };
    }
    if (value.t === 'void') return { code: status, body: null };
    return { code: status, body: jackson.serialize(value, method.node, { ...scope, block: child }) };
  };
  switch (result.t) {
    case 'mono': {
      const emission = result.run(block);
      if (isLit(emission.empty, true)) {
        block.emit(ret(status, null));
        return { status, list: false, empty: true };
      }
      if (isLit(emission.empty, false)) {
        const { code, body } = emitValue(emission.value, block);
        return { status: code, list: false, empty: body === null };
      }
      const present = block.child();
      const { code } = emitValue(emission.value, present);
      emitIf(block, emission.empty, [ret(status, null)], present.instrs);
      return { status: code, list: false, empty: false };
    }
    case 'flux': {
      const { list, element } = result.run(block);
      const as = block.fresh('row');
      block.emit(ret(status, { k: 'map', of: list, as, body: jackson.serialize(element({ k: 'var', name: as }), method.node, scope) }));
      return { status, list: true, empty: false };
    }
    default: {
      const { code, body } = emitValue(result, block);
      return { status: code, list: result.t === 'list', empty: body === null };
    }
  }
  void ev;
}

/** QUEUE_INTENT immediately before every RETURN of a program that writes. */
function insertQueueIntent(program: Instr[]): void {
  for (let index = 0; index < program.length; index += 1) {
    const instr = program[index]!;
    if (instr.op === 'RETURN') {
      program.splice(index, 0, { op: 'QUEUE_INTENT' });
      index += 1;
    } else if (instr.op === 'IF') {
      insertQueueIntent(instr.then as Instr[]);
      insertQueueIntent(instr.else as Instr[]);
    }
  }
}

function collectClaims(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) for (const item of value) collectClaims(item, out);
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.k === 'ctx' && typeof record.name === 'string') out.add(record.name);
    for (const item of Object.values(record)) collectClaims(item, out);
  }
}

export type { Param, EndpointPlan };
