import { createHash } from 'node:crypto';
import { parse, type CstElement, type IToken } from 'java-parser';
import type { CompilerAdapter, SourceFile } from './CompilerAdapter.js';
import type {
  AdapterAnalysis,
  CallSite,
  EndpointFacts,
  EvidenceKind,
  HttpMethod,
  SourceEvidence,
} from './types.js';

const ROUTE_ANNOTATIONS: Readonly<Record<string, HttpMethod>> = {
  GetMapping: 'GET',
  HeadMapping: 'HEAD',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
};

const HTTP_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FRESH_AUTH_ANNOTATIONS = new Set(['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed']);

interface AstNode {
  name: string;
  children: Record<string, CstElement[]>;
  location: {
    startOffset: number;
    startLine: number;
    endOffset: number;
    endLine: number;
  };
}

interface ParsedRoute {
  methods: readonly HttpMethod[];
  paths: readonly string[] | undefined;
}

interface ParsedSource {
  file: SourceFile;
  unit: AstNode;
}

interface JavaMethodInfo {
  name: string;
  argumentCount: number;
  returnType?: string;
  variables: Map<string, string>;
  transactionEvidence: SourceEvidence[];
  body?: AstNode;
  calls: CallSite[];
  owner: JavaClassInfo;
}

interface JavaClassInfo {
  name: string;
  file: SourceFile;
  startOffset: number;
  fields: Map<string, string>;
  methods: JavaMethodInfo[];
  repositoryEntity?: string;
  transactionEvidence: SourceEvidence[];
  isInterface: boolean;
  implementedInterfaces: string[];
}

export class SpringBootAdapter implements CompilerAdapter {
  readonly id = 'aeris.spring-boot';
  readonly version = '0.2.0';
  readonly language = 'java';
  readonly framework = 'spring-boot';

  async analyze(input: {
    files: readonly SourceFile[];
    sourceRevision: string;
  }): Promise<AdapterAnalysis> {
    const endpoints: EndpointFacts[] = [];
    const diagnostics: string[] = [];
    const parsedSources: ParsedSource[] = [];

    for (const file of input.files) {
      if (!file.path.endsWith('.java')) continue;
      try {
        parsedSources.push({
          file,
          unit: parse(file.content) as unknown as AstNode,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        diagnostics.push(`${file.path}: Java parse failed: ${message}`);
      }
    }

    const classes = buildClassIndex(parsedSources);

    for (const { file, unit } of parsedSources) {
      for (const classNode of descendants(unit, 'classDeclaration')) {
        const controllerAnnotations = childNodes(classNode, 'classModifier')
          .flatMap((modifier) => childNodes(modifier, 'annotation'));
        if (!controllerAnnotations.some((annotation) =>
          ['RestController', 'Controller'].includes(annotationName(annotation, file.content)),
        )) continue;

        const normalClass = childNodes(classNode, 'normalClassDeclaration')[0];
        const classBody = normalClass === undefined ? undefined : childNodes(normalClass, 'classBody')[0];
        if (classBody === undefined) {
          diagnostics.push(`${file.path}: controller has no supported class body.`);
          continue;
        }

        const classMappings = controllerAnnotations.filter((annotation) =>
          annotationName(annotation, file.content) === 'RequestMapping',
        );
        const classPaths = classMappings.length === 0
          ? ['']
          : classMappings.length === 1
            ? routePaths(classMappings[0]!, file.content)
            : undefined;
        if (classPaths === undefined) {
          diagnostics.push(`${file.path}: controller has ambiguous or dynamic class-level mappings.`);
          continue;
        }

        const owner = classInfoForClass(classes, classNode, file);
        for (const methodNode of directMethods(classBody)) {
          const methodAnnotations = childNodes(methodNode, 'methodModifier')
            .flatMap((modifier) => childNodes(modifier, 'annotation'));
          const mapped = methodAnnotations
            .map((annotation) => ({ annotation, route: routeFor(annotation, file.content) }))
            .filter((entry): entry is { annotation: AstNode; route: ParsedRoute } => entry.route !== undefined);
          if (mapped.length === 0) continue;

          const handlerName = methodNameOf(methodNode);
          const methodBody = childNodes(methodNode, 'methodBody')[0];
          const hasBody = methodBody !== undefined && childNodes(methodBody, 'block').length > 0;
          const methodInfo = owner?.methods.find((candidate) =>
            candidate.name === handlerName && candidate.body?.location.startOffset === methodBody?.location.startOffset,
          );
          const calls = hasBody && methodInfo !== undefined
            ? expandCallGraph(methodInfo.calls, methodInfo, classes)
            : [];
          const authorizationEvidence = [...controllerAnnotations, ...methodAnnotations]
            .filter((annotation) => FRESH_AUTH_ANNOTATIONS.has(annotationName(annotation, file.content)))
            .map((annotation) => sourceEvidence(
              file,
              annotation.location.startOffset,
              annotation.location.endOffset + 1,
              'authorization',
              handlerName ?? '<unknown-method>',
            ));
          const transactionEvidence = collectTransactionEvidence(methodInfo, calls, classes);
          if (!hasBody) {
            diagnostics.push(`${file.path}:${methodNode.location.startLine}: mapped handler has no analyzable body.`);
          }

          for (const { annotation, route } of mapped) {
            if (route.methods.length === 0) {
              diagnostics.push(`${file.path}:${annotation.location.startLine}: ${annotationName(annotation, file.content)} has no supported constant HTTP method.`);
              continue;
            }
            if (route.paths === undefined) {
              diagnostics.push(`${file.path}:${annotation.location.startLine}: ${annotationName(annotation, file.content)} has a dynamic or unsupported path.`);
              continue;
            }

            for (const method of route.methods) {
              for (const classPath of classPaths) {
                for (const methodPath of route.paths) {
                  const path = joinPath(classPath, methodPath);
                  const evidence = sourceEvidence(
                    file,
                    annotation.location.startOffset,
                    annotation.location.endOffset + 1,
                    'route',
                    handlerName ?? '<unknown-method>',
                  );
                  endpoints.push({
                    operationId: `${method} ${path}`,
                    method,
                    path,
                    complete: false,
                    deterministic: false,
                    requiresFreshAuthorization: authorizationEvidence.length > 0,
                    hasStrictGlobalInvariant: false,
                    hasIrreversibleExternalEffect: false,
                    replaySemantics: 'unknown',
                    reads: repositoryAccesses(calls, classes, 'read'),
                    writes: repositoryAccesses(calls, classes, 'write'),
                    calls,
                    evidence: [evidence, ...authorizationEvidence, ...transactionEvidence],
                    unresolved: [
                      ...(!hasBody ? ['Handler body could not be resolved.'] : []),
                      ...(calls.some((call) => call.resolution !== 'resolved' && call.resolution !== 'known-library')
                        ? ['One or more calls could not be resolved uniquely.']
                        : []),
                      'Data access semantics, authorization, business effects and local execution plans are not analyzed yet.',
                    ],
                  });
                }
              }
            }
          }
        }
      }
    }

    return {
      adapter: {
        id: this.id,
        version: this.version,
        language: this.language,
        framework: this.framework,
      },
      sourceRevision: input.sourceRevision,
      endpoints: deduplicate(endpoints),
      diagnostics,
    };
  }
}

function routeFor(annotation: AstNode, source: string): ParsedRoute | undefined {
  const name = annotationName(annotation, source);
  const shorthand = ROUTE_ANNOTATIONS[name];
  if (shorthand !== undefined) return { methods: [shorthand], paths: routePaths(annotation, source) };
  if (name !== 'RequestMapping') return undefined;

  const pairs = childNodes(annotation, 'elementValuePairList')
    .flatMap((list) => childNodes(list, 'elementValuePair'));
  const methodPair = pairs.find((pair) => tokensIn(pair)
    .find((token) => token.tokenType.name === 'Identifier')?.image === 'method');
  if (methodPair === undefined) return { methods: [], paths: routePaths(annotation, source) };
  const methodValue = childNodes(methodPair, 'elementValue')[0];
  const methods = methodValue === undefined
    ? []
    : [...new Set(tokensIn(methodValue)
      .filter((token) => token.tokenType.name === 'Identifier' && HTTP_METHODS.has(token.image as HttpMethod))
      .map((token) => token.image as HttpMethod))];
  return { methods, paths: routePaths(annotation, source) };
}

function routePaths(annotation: AstNode, source: string): string[] | undefined {
  const pairs = childNodes(annotation, 'elementValuePairList')
    .flatMap((list) => childNodes(list, 'elementValuePair'));
  const pathPair = pairs.find((pair) => {
    const name = childTokens(pair, 'Identifier')[0]?.image;
    return name === 'path' || name === 'value';
  });
  const unnamedValue = childNodes(annotation, 'elementValue')[0];
  const valueNode = pathPair === undefined
    ? pairs.length === 0 ? unnamedValue : undefined
    : childNodes(pathPair, 'elementValue')[0];
  if (valueNode === undefined) return [''];

  const tokens = tokensIn(valueNode);
  const stringTokens = tokens.filter((token) => token.tokenType.name === 'StringLiteral');
  if (stringTokens.length === 0 || tokens.some((token) =>
    token.tokenType.name !== 'StringLiteral' && !['LCurly', 'RCurly', 'Comma'].includes(token.tokenType.name),
  )) return undefined;
  const values = stringTokens.map((token) => decodeJavaString(token.image));
  return values.every((value) => value.length > 0) ? values : undefined;
}

function directMethods(classBody: AstNode): AstNode[] {
  return childNodes(classBody, 'classBodyDeclaration')
    .flatMap((declaration) => childNodes(declaration, 'classMemberDeclaration'))
    .flatMap((member) => childNodes(member, 'methodDeclaration'));
}

function methodNameOf(method: AstNode): string | undefined {
  const header = childNodes(method, 'methodHeader')[0];
  const declarator = header === undefined ? undefined : childNodes(header, 'methodDeclarator')[0];
  return childTokens(declarator, 'Identifier')[0]?.image;
}

function classNameOf(classNode: AstNode): string | undefined {
  const identifier = childNodes(classNode, 'typeIdentifier')[0];
  return childTokens(identifier, 'Identifier')[0]?.image;
}

function argumentCount(method: AstNode): number {
  const header = childNodes(method, 'methodHeader')[0];
  const declarator = header === undefined ? undefined : childNodes(header, 'methodDeclarator')[0];
  const parameters = declarator === undefined ? undefined : childNodes(declarator, 'formalParameterList')[0];
  return parameters === undefined
    ? 0
    : childNodes(parameters, 'formalParameter').length + childNodes(parameters, 'lastFormalParameter').length;
}

function methodReturnType(method: AstNode): string | undefined {
  const header = childNodes(method, 'methodHeader')[0];
  const result = header === undefined ? undefined : childNodes(header, 'result')[0];
  return result === undefined ? undefined : firstTypeName(childNodes(result, 'unannType')[0]);
}

function methodVariables(method: AstNode, body: AstNode | undefined): Map<string, string> {
  const variables = new Map<string, string>();
  const header = childNodes(method, 'methodHeader')[0];
  const declarator = header === undefined ? undefined : childNodes(header, 'methodDeclarator')[0];
  const parameters = declarator === undefined ? undefined : childNodes(declarator, 'formalParameterList')[0];
  if (parameters !== undefined) {
    for (const parameter of [
      ...childNodes(parameters, 'formalParameter'),
      ...childNodes(parameters, 'lastFormalParameter'),
    ]) {
      const regular = childNodes(parameter, 'variableParaRegularParameter')[0] ?? parameter;
      const type = firstTypeName(childNodes(regular, 'unannType')[0]);
      const variable = childNodes(regular, 'variableDeclaratorId')[0];
      const name = childTokens(variable, 'Identifier')[0]?.image;
      if (type !== undefined && name !== undefined) variables.set(name, type);
    }
  }

  if (body !== undefined) {
    for (const declaration of descendants(body, 'localVariableDeclaration')) {
      const typeNode = childNodes(declaration, 'localVariableType')[0];
      const type = typeNode === undefined
        ? undefined
        : firstTypeName(childNodes(typeNode, 'unannType')[0]);
      if (type === undefined) continue;
      for (const declarator of childNodes(declaration, 'variableDeclaratorList')
        .flatMap((list) => childNodes(list, 'variableDeclarator'))) {
        const id = childNodes(declarator, 'variableDeclaratorId')[0];
        const name = childTokens(id, 'Identifier')[0]?.image;
        if (name !== undefined && !variables.has(name)) variables.set(name, type);
      }
    }
  }
  return variables;
}

function firstTypeName(type: AstNode | undefined): string | undefined {
  return type === undefined
    ? undefined
    : tokensIn(type).find((token) => token.tokenType.name === 'Identifier')?.image;
}

function repositoryEntityOf(declaration: AstNode): string | undefined {
  for (const extension of childNodes(declaration, 'interfaceExtends')) {
    for (const type of descendants(extension, 'interfaceType')) {
      const classType = childNodes(type, 'classType')[0];
      if (classType === undefined) continue;
      const baseName = childTokens(classType, 'Identifier')[0]?.image;
      if (!['ReactiveCrudRepository', 'R2dbcRepository', 'CrudRepository', 'JpaRepository']
        .includes(baseName ?? '')) continue;
      const argumentsNode = childNodes(classType, 'typeArguments')[0];
      const argumentList = argumentsNode === undefined
        ? undefined
        : childNodes(argumentsNode, 'typeArgumentList')[0];
      const entityArgument = argumentList === undefined
        ? undefined
        : childNodes(argumentList, 'typeArgument')[0];
      return firstTypeName(entityArgument === undefined
        ? undefined
        : childNodes(entityArgument, 'referenceType')[0] ?? entityArgument);
    }
  }
  return undefined;
}

function repositoryAccesses(
  calls: readonly CallSite[],
  classes: readonly JavaClassInfo[],
  access: 'read' | 'write',
): EndpointFacts['reads'] {
  const repositories = new Map(classes
    .filter((entry) => entry.repositoryEntity !== undefined)
    .map((entry) => [entry.name, entry]));
  const entities = new Map<string, SourceEvidence[]>();
  for (const call of calls) {
    if (call.targetClass === undefined) continue;
    const repository = repositories.get(call.targetClass);
    if (repository === undefined) continue;
    const entity = repository.repositoryEntity!;
    const isRead = ['findById', 'findAll', 'findAllById', 'existsById', 'count'].includes(call.name) ||
      (call.resolution === 'resolved' && repository.methods.some((method) =>
        method.name === call.name && method.body === undefined &&
        /^(find|read|get|query|search|stream)(All|Distinct|First|Top)?\d*By/.test(method.name) ||
        method.name === call.name && method.body === undefined && /^(exists|count)By/.test(method.name),
      ));
    const isWrite = ['save', 'saveAll', 'deleteById', 'delete', 'deleteAll', 'deleteAllById']
      .includes(call.name) ||
      (call.resolution === 'resolved' && repository.methods.some((method) =>
        method.name === call.name && method.body === undefined && /^(delete|remove)(All)?By/.test(method.name),
      ));
    if ((access === 'read' && isRead) || (access === 'write' && isWrite)) {
      entities.set(entity, [...(entities.get(entity) ?? []), {
        ...call.evidence,
        kind: access === 'read' ? 'database-read' : 'database-write',
      }]);
    }
  }
  return [...entities].map(([entity, evidence]) => ({ entity, evidence }));
}

function annotationsEvidence(
  annotations: readonly AstNode[],
  file: SourceFile,
  symbol: string,
): SourceEvidence[] {
  return annotations
    .filter((annotation) => annotationName(annotation, file.content) === 'Transactional')
    .map((annotation) => sourceEvidence(
      file,
      annotation.location.startOffset,
      annotation.location.endOffset + 1,
      'transaction',
      symbol,
    ));
}

function collectTransactionEvidence(
  handler: JavaMethodInfo | undefined,
  calls: readonly CallSite[],
  classes: readonly JavaClassInfo[],
): SourceEvidence[] {
  if (handler === undefined) return [];
  const evidence = [...handler.owner.transactionEvidence, ...handler.transactionEvidence];
  for (const call of calls) {
    if (call.resolution !== 'resolved' || call.targetClass === undefined || call.targetFile === undefined) continue;
    const targetClass = classes.find((candidate) =>
      candidate.name === call.targetClass && candidate.file.path === call.targetFile);
    if (targetClass === undefined) continue;
    evidence.push(...targetClass.transactionEvidence);
    const targetMethods = targetClass.methods.filter((method) => method.name === call.targetMethod);
    if (targetMethods.length === 1) evidence.push(...targetMethods[0]!.transactionEvidence);
  }
  const unique = new Map(evidence.map((item) => [`${item.file}:${item.startLine}:${item.symbol}`, item]));
  return [...unique.values()];
}

function knownReactiveType(type: string): 'Mono' | 'Flux' | undefined {
  return type === 'Mono' || type === 'Flux' ? type : undefined;
}

const MONO_OPERATORS = new Set([
  'cast', 'defer', 'deferContextual', 'defaultIfEmpty', 'delayElement', 'doFinally', 'doOnCancel', 'doOnEach', 'doOnError',
  'doOnNext', 'doOnSuccess', 'filter', 'flatMap', 'flatMapMany', 'handle', 'map', 'onErrorMap',
  'just', 'justOrEmpty', 'empty', 'error', 'fromCallable', 'fromSupplier', 'onErrorResume',
  'onErrorReturn', 'switchIfEmpty', 'then', 'thenEmpty', 'thenMany', 'thenReturn', 'timeout',
  'zipWhen', 'zipWith',
]);

const FLUX_OPERATORS = new Set([
  'cast', 'collectList', 'concatMap', 'defaultIfEmpty', 'defer', 'doFinally', 'doOnCancel', 'doOnEach', 'doOnError',
  'doOnNext', 'filter', 'flatMap', 'handle', 'map', 'next', 'onErrorMap', 'onErrorResume',
  'onErrorReturn', 'single', 'singleOrEmpty', 'switchIfEmpty', 'then', 'thenMany', 'zipWith',
]);

function isKnownReactiveOperator(type: string, name: string): boolean {
  return type === 'Mono' ? MONO_OPERATORS.has(name) : type === 'Flux' && FLUX_OPERATORS.has(name);
}

function chainedReactiveType(type: string | undefined, method: string): string | undefined {
  if (type === 'Mono') {
    if (['flatMapMany', 'flux', 'thenMany'].includes(method)) return 'Flux';
    if (MONO_OPERATORS.has(method)) return 'Mono';
  }
  if (type === 'Flux') {
    if (['collectList', 'next', 'single', 'singleOrEmpty', 'then'].includes(method)) return 'Mono';
    if (FLUX_OPERATORS.has(method)) return 'Flux';
  }
  return undefined;
}

function buildClassIndex(sources: readonly ParsedSource[]): JavaClassInfo[] {
  const classes: JavaClassInfo[] = [];
  for (const { file, unit } of sources) {
    const declarations = [
      ...descendants(unit, 'classDeclaration'),
      ...descendants(unit, 'interfaceDeclaration'),
    ];
    for (const declaration of declarations) {
      const classDeclaration = childNodes(declaration, 'normalClassDeclaration')[0];
      const interfaceDeclaration = childNodes(declaration, 'normalInterfaceDeclaration')[0];
      const declaredType = classDeclaration ?? interfaceDeclaration;
      if (declaredType === undefined) continue;
      const classBody = childNodes(declaredType, 'classBody')[0] ?? childNodes(declaredType, 'interfaceBody')[0];
      const name = classNameOf(declaredType);
      if (name === undefined || classBody === undefined) continue;

      const info: JavaClassInfo = {
        name,
        file,
        startOffset: declaration.location.startOffset,
        fields: new Map(),
        methods: [],
        repositoryEntity: repositoryEntityOf(declaredType),
        isInterface: interfaceDeclaration !== undefined,
        implementedInterfaces: childNodes(declaredType, 'classImplements')
          .flatMap((implementsNode) => descendants(implementsNode, 'interfaceType'))
          .map((type) => tokensIn(type)
            .filter((token) => token.tokenType.name === 'Identifier')
            .at(-1)?.image)
          .filter((name): name is string => name !== undefined),
        transactionEvidence: annotationsEvidence(
          childNodes(declaration, 'classModifier').flatMap((modifier) => childNodes(modifier, 'annotation')),
          file,
          'class',
        ),
      };
      for (const field of directFields(classBody)) {
        const type = childNodes(field, 'unannType')[0];
        const typeName = type === undefined
          ? undefined
          : tokensIn(type).find((token) => token.tokenType.name === 'Identifier')?.image;
        if (typeName === undefined) continue;
        const declarators = childNodes(field, 'variableDeclaratorList')
          .flatMap((list) => childNodes(list, 'variableDeclarator'));
        for (const declarator of declarators) {
          const id = childNodes(declarator, 'variableDeclaratorId')[0];
          const fieldName = childTokens(id, 'Identifier')[0]?.image;
          if (fieldName !== undefined) info.fields.set(fieldName, typeName.split('.').at(-1)!);
        }
      }
      const methods = [
        ...directMethods(classBody),
        ...directInterfaceMethods(classBody),
      ];
      for (const method of methods) {
        const methodName = methodNameOf(method);
        if (methodName === undefined) continue;
        const methodBody = childNodes(method, 'methodBody')[0];
        const body = methodBody !== undefined && childNodes(methodBody, 'block').length > 0
          ? methodBody
          : undefined;
        info.methods.push({
          name: methodName,
          argumentCount: argumentCount(method),
          returnType: methodReturnType(method),
          variables: methodVariables(method, body),
          transactionEvidence: annotationsEvidence(
            childNodes(method, 'methodModifier').flatMap((modifier) => childNodes(modifier, 'annotation')),
            file,
            methodName,
          ),
          body,
          calls: [],
          owner: info,
        });
      }
      classes.push(info);
    }
  }

  const classesByName = new Map<string, JavaClassInfo[]>();
  for (const info of classes) {
    classesByName.set(info.name, [...(classesByName.get(info.name) ?? []), info]);
  }
  for (const info of classes) {
    for (const method of info.methods) {
      if (method.body !== undefined) {
        method.calls = collectCallSites(
          info.file,
          method.body,
          `${info.name}.${method.name}`,
          info,
          method.variables,
          classesByName,
        );
      }
    }
  }
  return classes;
}

function directFields(classBody: AstNode): AstNode[] {
  return childNodes(classBody, 'classBodyDeclaration')
    .flatMap((declaration) => childNodes(declaration, 'classMemberDeclaration'))
    .flatMap((member) => childNodes(member, 'fieldDeclaration'));
}

function directInterfaceMethods(interfaceBody: AstNode): AstNode[] {
  return childNodes(interfaceBody, 'interfaceMemberDeclaration')
    .flatMap((member) => childNodes(member, 'interfaceMethodDeclaration'));
}

function classInfoForClass(
  classes: readonly JavaClassInfo[],
  classNode: AstNode,
  file: SourceFile,
): JavaClassInfo | undefined {
  const declaration = childNodes(classNode, 'normalClassDeclaration')[0];
  if (declaration === undefined) return undefined;
  const name = classNameOf(declaration);
  return classes.find((entry) => entry.name === name && entry.file.path === file.path &&
    entry.startOffset === classNode.location.startOffset);
}

function collectCallSites(
  file: SourceFile,
  methodBody: AstNode,
  caller: string,
  owner: JavaClassInfo,
  variables: ReadonlyMap<string, string>,
  classes: ReadonlyMap<string, JavaClassInfo[]>,
): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  for (const primary of descendants(methodBody, 'primary')) {
    const prefix = childNodes(primary, 'primaryPrefix')[0];
    const prefixIdentifiers = prefix === undefined ? [] : tokensIn(prefix)
      .filter((token) => token.tokenType.name === 'Identifier');
    const suffixes = childNodes(primary, 'primarySuffix');
    const firstSuffixIsInvocation = childNodes(suffixes[0], 'methodInvocationSuffix').length > 0;
    const rootName = firstSuffixIsInvocation && prefixIdentifiers.length > 1
      ? prefixIdentifiers.at(-2)?.image
      : prefixIdentifiers.at(-1)?.image;
    let receiverType = rootName === undefined
      ? undefined
      : variables.get(rootName) ?? owner.fields.get(rootName) ?? knownReactiveType(rootName);
    for (let index = 0; index < suffixes.length; index += 1) {
      const invocation = childNodes(suffixes[index]!, 'methodInvocationSuffix').length > 0;
      if (!invocation) continue;

      const previousSuffixIdentifiers = index === 0
        ? []
        : tokensIn(suffixes[index - 1]!).filter((token) => token.tokenType.name === 'Identifier');
      const callToken = previousSuffixIdentifiers.at(-1) ?? prefixIdentifiers.at(-1);
      if (callToken === undefined) continue;
      const receiver = previousSuffixIdentifiers.length === 0 && prefixIdentifiers.length > 1
        ? prefixIdentifiers.at(-2)?.image
        : undefined;
      const dispatch = index > 0 && previousSuffixIdentifiers.length > 0
        ? 'chain'
        : receiver === undefined ? 'implicit' : 'qualified';
      const suffix = suffixes[index]!;
      const invocationSuffix = childNodes(suffix, 'methodInvocationSuffix')[0];
      const argumentList = invocationSuffix === undefined
        ? undefined
        : childNodes(invocationSuffix, 'argumentList')[0];
      const callArgumentCount = argumentList === undefined
        ? 0
        : childNodes(argumentList, 'expression').length;
      const key = `${callToken.startOffset}:${callToken.image}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({
        name: callToken.image,
        receiver,
        receiverType,
        caller,
        argumentCount: callArgumentCount,
        dispatch,
        resolution: 'unresolved',
        evidence: sourceEvidence(file, callToken.startOffset, callToken.endOffset + 1, 'call', callToken.image),
      });
      receiverType = chainedReactiveType(receiverType, callToken.image) ??
        sourceMethodReturnType(receiverType, callToken.image, callArgumentCount, classes);
    }
  }
  return calls.sort((left, right) => left.evidence.startLine - right.evidence.startLine ||
    left.evidence.symbol.localeCompare(right.evidence.symbol));
}

function expandCallGraph(
  directCalls: readonly CallSite[],
  startMethod: JavaMethodInfo,
  classes: readonly JavaClassInfo[],
): CallSite[] {
  const classNames = new Map<string, JavaClassInfo[]>();
  for (const info of classes) {
    classNames.set(info.name, [...(classNames.get(info.name) ?? []), info]);
  }

  const queue: Array<{ call: CallSite; owner: JavaClassInfo }> = directCalls.map((call) => ({
    call,
    owner: startMethod.owner,
  }));
  const result: CallSite[] = [];
  const visited = new Set<string>();
  while (queue.length > 0 && result.length < 2000) {
    const current = queue.shift()!;
    const resolved = resolveCall(current.call, current.owner, classNames);
    result.push(resolved.call);
    if (resolved.target?.body === undefined) continue;

    const targetKey = `${resolved.target.owner.file.path}:${resolved.target.owner.name}:${resolved.target.name}:${resolved.target.argumentCount}`;
    if (visited.has(targetKey)) continue;
    visited.add(targetKey);
    queue.push(...resolved.target.calls.map((call) => ({ call, owner: resolved.target!.owner })));
  }
  return result;
}

function resolveCall(
  call: CallSite,
  owner: JavaClassInfo,
  classes: ReadonlyMap<string, JavaClassInfo[]>,
): { call: CallSite; target?: JavaMethodInfo } {
  let targetClassName: string | undefined;
  if (call.dispatch === 'implicit' || call.receiver === 'this') {
    targetClassName = owner.name;
  } else if (call.dispatch === 'qualified' && call.receiver !== undefined) {
    targetClassName = call.receiverType !== undefined && classes.has(call.receiverType)
      ? call.receiverType
      : owner.fields.get(call.receiver) ?? call.receiver.split('.').at(-1);
  }

  if (call.receiverType !== undefined && isKnownReactiveOperator(call.receiverType, call.name)) {
    return { call: { ...call, resolution: 'known-library' } };
  }

  if (targetClassName !== undefined) {
    const targetClass = (classes.get(targetClassName) ?? [])
      .find((candidate) => candidate.repositoryEntity !== undefined);
    const repositoryMethods = new Set([
      'findById', 'findAll', 'findAllById', 'existsById', 'count',
      'save', 'saveAll', 'deleteById', 'delete', 'deleteAll', 'deleteAllById',
    ]);
    if (targetClass !== undefined && repositoryMethods.has(call.name)) {
      return {
        call: { ...call, resolution: 'known-library', targetClass: targetClass.name },
      };
    }
  }

  if (call.dispatch === 'chain' && call.receiverType !== undefined && classes.has(call.receiverType)) {
    targetClassName = call.receiverType;
  }

  if (targetClassName === undefined || call.dispatch === 'chain') {
    return { call: { ...call, resolution: 'unresolved' } };
  }
  const targetClasses = classes.get(targetClassName) ?? [];
  const candidates = targetClasses.flatMap((targetClass) =>
    targetClass.methods.filter((method) =>
      method.name === call.name && method.argumentCount === call.argumentCount,
    ),
  );
  if (candidates.length !== 1) {
    return { call: { ...call, resolution: candidates.length > 1 ? 'ambiguous' : 'unresolved' } };
  }

  let target = candidates[0]!;
  if (target.owner.isInterface) {
    const implementations = [...classes.values()].flatMap((entries) => entries)
      .filter((entry) => !entry.isInterface && entry.implementedInterfaces.includes(target.owner.name))
      .flatMap((entry) => entry.methods.filter((method) =>
        method.name === target.name && method.argumentCount === target.argumentCount && method.body !== undefined,
      ));
    if (implementations.length > 1) {
      return { call: { ...call, resolution: 'ambiguous' } };
    }
    if (implementations.length === 1) target = implementations[0]!;
  }
  return {
    target,
    call: {
      ...call,
      resolution: 'resolved',
      targetClass: target.owner.name,
      targetFile: target.owner.file.path,
      targetMethod: target.name,
    },
  };
}

function sourceMethodReturnType(
  receiverType: string | undefined,
  name: string,
  argumentCount: number,
  classes: ReadonlyMap<string, JavaClassInfo[]>,
): string | undefined {
  if (receiverType === undefined) return undefined;
  const candidates = (classes.get(receiverType) ?? [])
    .flatMap((owner) => owner.methods)
    .filter((method) => method.name === name && method.argumentCount === argumentCount);
  return candidates.length === 1 ? candidates[0]?.returnType : undefined;
}

function annotationName(annotation: AstNode, source: string): string {
  const typeName = childNodes(annotation, 'typeName')[0];
  if (typeName === undefined) return '';
  return source.slice(typeName.location.startOffset, typeName.location.endOffset + 1).split('.').at(-1) ?? '';
}

function decodeJavaString(literal: string): string {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return literal.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
}

function descendants(root: AstNode, name: string): AstNode[] {
  const result: AstNode[] = [];
  const visit = (element: CstElement): void => {
    if (isCstNode(element)) {
      const node = element as unknown as AstNode;
      if (node.name === name) result.push(node);
      for (const children of Object.values(node.children)) {
        for (const child of children) visit(child);
      }
    }
  };
  visit(root as unknown as CstElement);
  return result;
}

function childNodes(root: AstNode | undefined, name: string): AstNode[] {
  const children = root?.children[name] ?? [];
  return children.filter(isCstNode).map((node) => node as unknown as AstNode);
}

function childTokens(root: AstNode | undefined, name: string): IToken[] {
  return (root?.children[name] ?? []).filter(isToken);
}

function tokensIn(root: AstNode): IToken[] {
  const result: IToken[] = [];
  const visit = (element: CstElement): void => {
    if (isToken(element)) {
      result.push(element);
    } else {
      for (const children of Object.values(element.children)) {
        for (const child of children) visit(child);
      }
    }
  };
  visit(root as unknown as CstElement);
  return result.sort((left, right) => left.startOffset - right.startOffset);
}

function isToken(element: CstElement): element is IToken {
  return 'image' in element;
}

function isCstNode(element: CstElement): boolean {
  return 'children' in element;
}

function sourceEvidence(
  file: SourceFile,
  start: number,
  end: number,
  kind: EvidenceKind,
  symbol: string,
): SourceEvidence {
  const excerpt = file.content.slice(start, end);
  return {
    file: file.path,
    symbol,
    kind,
    startLine: lineAt(file.content, start),
    endLine: lineAt(file.content, end),
    excerptHash: createHash('sha256').update(excerpt).digest('hex'),
  };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function joinPath(base: string, path: string): string {
  const joined = `/${[base, path].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

function deduplicate(endpoints: readonly EndpointFacts[]): EndpointFacts[] {
  const byOperation = new Map<string, EndpointFacts>();
  for (const endpoint of endpoints) {
    const existing = byOperation.get(endpoint.operationId);
    if (existing === undefined) {
      byOperation.set(endpoint.operationId, endpoint);
    } else {
      byOperation.set(endpoint.operationId, {
        ...existing,
        evidence: [...existing.evidence, ...endpoint.evidence],
        unresolved: [...existing.unresolved, 'Multiple controller methods map to the same HTTP method and path.'],
      });
    }
  }
  return [...byOperation.values()];
}
