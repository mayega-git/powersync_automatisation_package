import { childrenOfType, field, fields, firstOfType, javaParser, named, stringValue, type SyntaxNode } from './parser.js';

export interface SourceFile {
  path: string;
  content: string;
}

export interface JType {
  /** Fully-qualified name when resolved, primitive keyword, or the raw name. */
  name: string;
  args: JType[];
  array: number;
  /** True when the name is a type variable or could not be resolved. */
  unresolved?: boolean;
}

export interface Annotation {
  /** Simple name, e.g. `GetMapping`. */
  name: string;
  node: SyntaxNode;
  /** Element values; a single unnamed value is stored under `value`. */
  args: Map<string, SyntaxNode>;
}

export interface FieldDecl {
  name: string;
  type: JType;
  node: SyntaxNode;
  annotations: Annotation[];
  modifiers: Set<string>;
  initializer?: SyntaxNode;
  owner: TypeDecl;
}

export interface Param {
  name: string;
  type: JType;
  annotations: Annotation[];
  node: SyntaxNode;
}

export type Synthetic =
  | { kind: 'getter'; property: string }
  | { kind: 'setter'; property: string }
  | { kind: 'accessor'; property: string }
  | { kind: 'builder' }
  | { kind: 'toBuilder' }
  | { kind: 'all-args-ctor'; properties: string[] }
  | { kind: 'enum-name' }
  | { kind: 'enum-valueOf' };

export interface MethodDecl {
  name: string;
  params: Param[];
  returnType: JType;
  node: SyntaxNode;
  body?: SyntaxNode;
  annotations: Annotation[];
  modifiers: Set<string>;
  owner: TypeDecl;
  isConstructor: boolean;
  synthetic?: Synthetic;
  varargs: boolean;
}

export type TypeKind = 'class' | 'interface' | 'enum' | 'record' | 'annotation';

export interface TypeDecl {
  fqn: string;
  simple: string;
  kind: TypeKind;
  file: SourceFile;
  node: SyntaxNode;
  pkg: string;
  imports: Imports;
  annotations: Annotation[];
  modifiers: Set<string>;
  superclass?: JType;
  interfaces: JType[];
  fields: FieldDecl[];
  methods: MethodDecl[];
  constructors: MethodDecl[];
  recordComponents: Param[];
  enumConstants: string[];
  outer?: TypeDecl;
  nested: TypeDecl[];
  typeParams: string[];
}

interface Imports {
  single: Map<string, string>;
  onDemand: string[];
  staticSingle: Map<string, string>;
  staticOnDemand: string[];
}

const TYPE_KINDS: Readonly<Record<string, TypeKind>> = {
  class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum',
  record_declaration: 'record', annotation_type_declaration: 'annotation',
};

const PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'float', 'double', 'boolean', 'void']);

const JAVA_LANG = new Set([
  'String', 'Object', 'Integer', 'Long', 'Short', 'Byte', 'Character', 'Float', 'Double', 'Boolean', 'Number',
  'Math', 'StrictMath', 'System', 'Void', 'Enum', 'Record', 'Iterable', 'Comparable', 'CharSequence',
  'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'NullPointerException',
  'UnsupportedOperationException', 'ArithmeticException', 'IndexOutOfBoundsException', 'Throwable', 'Error',
  'SecurityException', 'Thread', 'StringBuilder', 'Class', 'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface',
]);

/** Well-known types resolved without an import line (java.lang) or commonly star-imported. */
const KNOWN_PACKAGES: Readonly<Record<string, string>> = {
  UUID: 'java.util.UUID', List: 'java.util.List', Map: 'java.util.Map', Set: 'java.util.Set', Optional: 'java.util.Optional',
  Objects: 'java.util.Objects', Collection: 'java.util.Collection', Collections: 'java.util.Collections',
  BigDecimal: 'java.math.BigDecimal', BigInteger: 'java.math.BigInteger',
  LocalDateTime: 'java.time.LocalDateTime', LocalDate: 'java.time.LocalDate', LocalTime: 'java.time.LocalTime',
  Instant: 'java.time.Instant', OffsetDateTime: 'java.time.OffsetDateTime', ZonedDateTime: 'java.time.ZonedDateTime',
  Mono: 'reactor.core.publisher.Mono', Flux: 'reactor.core.publisher.Flux',
};

export function typeName(type: JType): string {
  return type.name.includes('.') ? type.name.slice(type.name.lastIndexOf('.') + 1) : type.name;
}

export function isPrimitive(type: JType): boolean {
  return type.array === 0 && PRIMITIVES.has(type.name);
}

const parsedTypes = new WeakMap<SyntaxNode, JType>();

/**
 * Index of a Java code base: types, members, imports and inheritance, with
 * the members Lombok and records generate. Everything the evaluator needs to
 * resolve a call statically, without guessing.
 */
export class JavaProject {
  readonly types = new Map<string, TypeDecl>();
  readonly bySimple = new Map<string, TypeDecl[]>();
  readonly diagnostics: string[] = [];
  private implementationsCache = new Map<string, TypeDecl[]>();
  private assignableCache = new Map<string, Set<string>>();

  private constructor(readonly activeProfiles: ReadonlySet<string>) {}

  static async load(files: readonly SourceFile[], activeProfiles: readonly string[] = []): Promise<JavaProject> {
    const project = new JavaProject(new Set(activeProfiles));
    const parser = await javaParser();
    // Phase 1: declare every type, so that member types resolve regardless of file order.
    for (const file of files) {
      if (!file.path.endsWith('.java')) continue;
      const tree = parser.parse(file.content);
      if (tree === null) {
        project.diagnostics.push(`${file.path}: could not be parsed.`);
        continue;
      }
      if (tree.rootNode.hasError) project.diagnostics.push(`${file.path}: contains syntax errors; affected members are skipped.`);
      project.indexFile(file, tree.rootNode);
    }
    // Phase 2: resolve supertypes and members.
    for (const type of [...project.types.values()]) project.populate(type);
    for (const type of project.types.values()) project.synthesize(type);
    return project;
  }

  private anonymous = new Map<SyntaxNode, TypeDecl>();

  /** A TypeDecl for an anonymous class body (`new I() { ... }`), indexed on demand. */
  anonymousType(node: SyntaxNode, base: JType, context: TypeDecl): TypeDecl {
    const cached = this.anonymous.get(node);
    if (cached !== undefined) return cached;
    const type: TypeDecl = {
      fqn: `${context.fqn}$anonymous@${node.startPosition.row + 1}`,
      simple: `${typeName(base)}$anonymous`,
      kind: 'class',
      file: context.file,
      node,
      pkg: context.pkg,
      imports: context.imports,
      annotations: [],
      modifiers: new Set(),
      interfaces: this.types.get(base.name)?.kind === 'interface' ? [base] : [],
      ...(this.types.get(base.name)?.kind === 'interface' ? {} : { superclass: base }),
      fields: [],
      methods: [],
      constructors: [],
      recordComponents: [],
      enumConstants: [],
      outer: context,
      nested: [],
      typeParams: [],
    };
    this.populateBody(type, node);
    this.anonymous.set(node, type);
    return type;
  }

  private indexFile(file: SourceFile, root: SyntaxNode): void {
    const pkgNode = firstOfType(root, 'package_declaration');
    const pkg = pkgNode === undefined ? '' : named(pkgNode).filter((node) => node.type !== 'annotation' && node.type !== 'marker_annotation').map((node) => node.text).join('');
    const imports: Imports = { single: new Map(), onDemand: [], staticSingle: new Map(), staticOnDemand: [] };
    for (const decl of childrenOfType(root, 'import_declaration')) {
      const isStatic = decl.children.some((child) => child?.type === 'static');
      const onDemand = decl.children.some((child) => child?.type === 'asterisk');
      const name = named(decl).find((node) => node.type === 'scoped_identifier' || node.type === 'identifier')?.text;
      if (name === undefined) continue;
      if (isStatic) {
        if (onDemand) imports.staticOnDemand.push(name);
        else imports.staticSingle.set(name.slice(name.lastIndexOf('.') + 1), name);
      } else if (onDemand) imports.onDemand.push(name);
      else imports.single.set(name.slice(name.lastIndexOf('.') + 1), name);
    }
    for (const node of named(root)) this.indexType(node, file, pkg, imports, undefined);
  }

  private indexType(node: SyntaxNode, file: SourceFile, pkg: string, imports: Imports, outer: TypeDecl | undefined): void {
    const kind: TypeKind | undefined = TYPE_KINDS[node.type];
    if (kind === undefined) return;
    const simple = field(node, 'name')?.text;
    if (simple === undefined) return;
    const fqn = outer === undefined ? (pkg ? `${pkg}.${simple}` : simple) : `${outer.fqn}.${simple}`;
    const modifiersNode = firstOfType(node, 'modifiers');
    const type: TypeDecl = {
      fqn,
      simple,
      kind,
      file,
      node,
      pkg,
      imports,
      annotations: annotationsOf(modifiersNode),
      modifiers: modifierSet(modifiersNode),
      interfaces: [],
      fields: [],
      methods: [],
      constructors: [],
      recordComponents: [],
      enumConstants: [],
      outer,
      nested: [],
      typeParams: named(field(node, 'type_parameters')).map((param) => named(param)[0]?.text ?? param.text),
    };
    if (outer !== undefined) outer.nested.push(type);
    if (this.types.has(fqn)) {
      this.diagnostics.push(`${file.path}: duplicate type ${fqn} ignored.`);
      return;
    }
    this.types.set(fqn, type);
    const list = this.bySimple.get(simple) ?? [];
    list.push(type);
    this.bySimple.set(simple, list);

    const body = field(node, 'body');
    // Nested types are declared now; members are resolved in phase 2.
    for (const member of this.bodyMembers(body)) this.indexType(member, file, pkg, imports, type);
  }

  /** Phase 2: supertypes, record components, enum constants, fields and methods. */
  populate(type: TypeDecl): void {
    const node = type.node;
    const superclass = field(node, 'superclass');
    if (superclass !== undefined) type.superclass = this.parseType(named(superclass)[0]!, type);
    const interfaceList = field(node, 'interfaces') ?? firstOfType(node, 'super_interfaces', 'extends_interfaces');
    for (const typeList of [interfaceList, ...childrenOfType(node, 'extends_interfaces')].filter((entry): entry is SyntaxNode => entry !== undefined)) {
      for (const item of named(firstOfType(typeList, 'type_list') ?? typeList)) {
        if (item.type !== 'type_list') type.interfaces.push(this.parseType(item, type));
      }
    }
    type.interfaces = type.interfaces.filter((iface, index, all) => all.findIndex((other) => other.name === iface.name) === index);
    if (type.kind === 'record') {
      for (const param of childrenOfType(field(node, 'parameters'), 'formal_parameter')) {
        type.recordComponents.push(this.parseParam(param, type));
      }
    }
    const body = field(node, 'body');
    if (type.kind === 'enum') {
      for (const constant of childrenOfType(body, 'enum_constant')) {
        const name = field(constant, 'name')?.text;
        if (name !== undefined) type.enumConstants.push(name);
      }
    }
    this.populateBody(type, body);
  }

  private populateBody(type: TypeDecl, body: SyntaxNode | undefined): void {
    for (const member of this.bodyMembers(body)) {
      if (member.type === 'field_declaration' || member.type === 'constant_declaration') {
        const modifiers = firstOfType(member, 'modifiers');
        const fieldType = this.parseType(field(member, 'type')!, type);
        for (const declarator of fields(member, 'declarator')) {
          const name = field(declarator, 'name')?.text;
          if (name === undefined) continue;
          const dims = childrenOfType(declarator, 'dimensions').length;
          type.fields.push({
            name,
            type: dims > 0 ? { ...fieldType, array: fieldType.array + dims } : fieldType,
            node: member,
            annotations: annotationsOf(modifiers),
            modifiers: modifierSet(modifiers),
            initializer: field(declarator, 'value'),
            owner: type,
          });
        }
      } else if (member.type === 'method_declaration') {
        type.methods.push(this.parseMethod(member, type, false));
      } else if (member.type === 'constructor_declaration' || member.type === 'compact_constructor_declaration') {
        type.constructors.push(this.parseMethod(member, type, true));
      }
    }
    if (type.kind === 'interface' || type.kind === 'annotation') {
      // Interface fields are implicitly static final.
      for (const decl of type.fields) decl.modifiers.add('static').add('final');
    }
  }

  private bodyMembers(body: SyntaxNode | undefined): SyntaxNode[] {
    if (body === undefined) return [];
    const members = named(body);
    const declarations = childrenOfType(body, 'enum_body_declarations');
    return [...members.filter((member) => member.type !== 'enum_body_declarations'), ...declarations.flatMap((decl) => named(decl))];
  }

  private parseMethod(node: SyntaxNode, owner: TypeDecl, isConstructor: boolean): MethodDecl {
    const modifiers = firstOfType(node, 'modifiers');
    const paramsNode = field(node, 'parameters');
    const params = named(paramsNode)
      .filter((param) => param.type === 'formal_parameter' || param.type === 'spread_parameter')
      .map((param) => this.parseParam(param, owner));
    const body = field(node, 'body');
    return {
      name: isConstructor ? '<init>' : field(node, 'name')!.text,
      params: node.type === 'compact_constructor_declaration' ? [...owner.recordComponents] : params,
      returnType: isConstructor ? { name: owner.fqn, args: [], array: 0 } : this.parseType(field(node, 'type')!, owner),
      node,
      ...(body === undefined ? {} : { body }),
      annotations: annotationsOf(modifiers),
      modifiers: modifierSet(modifiers),
      owner,
      isConstructor,
      varargs: named(paramsNode).some((param) => param.type === 'spread_parameter'),
    };
  }

  private parseParam(node: SyntaxNode, owner: TypeDecl): Param {
    const modifiers = firstOfType(node, 'modifiers');
    const typeNode = field(node, 'type') ?? named(node).find((child) => child.type !== 'modifiers' && child.type !== 'variable_declarator' && child.type !== 'identifier');
    const nameNode = field(node, 'name') ?? field(firstOfType(node, 'variable_declarator'), 'name') ?? named(node).filter((child) => child.type === 'identifier').at(-1);
    const type = typeNode === undefined ? { name: 'java.lang.Object', args: [], array: 0 } : this.parseType(typeNode, owner);
    return {
      name: nameNode?.text ?? '_',
      type: node.type === 'spread_parameter' ? { ...type, array: type.array + 1 } : type,
      annotations: annotationsOf(modifiers),
      node,
    };
  }

  /** Parses a type node in the scope of `context`. */
  parseType(node: SyntaxNode, context: TypeDecl): JType {
    const cached = parsedTypes.get(node);
    if (cached !== undefined) return cached;
    let result: JType;
    switch (node.type) {
      case 'integral_type':
      case 'floating_point_type':
      case 'boolean_type':
      case 'void_type':
        result = { name: node.text, args: [], array: 0 };
        break;
      case 'array_type': {
        const element = this.parseType(field(node, 'element')!, context);
        result = { ...element, array: element.array + childrenOfType(node, 'dimensions').reduce((sum, dims) => sum + (dims.text.match(/\[/g)?.length ?? 1), 0) };
        break;
      }
      case 'generic_type': {
        const [base, argsNode] = named(node);
        const raw = this.parseType(base!, context);
        const args = named(argsNode).filter((arg) => arg.type !== 'annotation' && arg.type !== 'marker_annotation').map((arg) => (
          arg.type === 'wildcard' ? (named(arg).at(-1) ? this.parseType(named(arg).at(-1)!, context) : { name: 'java.lang.Object', args: [], array: 0 }) : this.parseType(arg, context)
        ));
        result = { ...raw, args };
        break;
      }
      case 'type_identifier':
      case 'scoped_type_identifier':
      case 'identifier':
      case 'scoped_identifier': {
        const text = node.text.replace(/\s+/g, '').replace(/@\w+(\([^)]*\))?/g, '');
        const resolved = this.resolveTypeName(text, context);
        result = resolved === undefined
          ? { name: text, args: [], array: 0, unresolved: true }
          : { name: resolved, args: [], array: 0 };
        break;
      }
      case 'annotated_type': {
        const inner = named(node).find((child) => child.type !== 'annotation' && child.type !== 'marker_annotation');
        result = inner === undefined ? { name: 'java.lang.Object', args: [], array: 0, unresolved: true } : this.parseType(inner, context);
        break;
      }
      default:
        result = { name: node.text, args: [], array: 0, unresolved: true };
    }
    parsedTypes.set(node, result);
    return result;
  }

  /** Resolves a (possibly qualified) type name as javac would from `context`. */
  resolveTypeName(name: string, context: TypeDecl): string | undefined {
    if (PRIMITIVES.has(name)) return name;
    const [head, ...rest] = name.split('.');
    if (head === undefined) return undefined;
    // Type variables of the enclosing declarations.
    for (let scope: TypeDecl | undefined = context; scope !== undefined; scope = scope.outer) {
      if (scope.typeParams.includes(head)) return undefined;
    }
    const resolvedHead = this.resolveSimple(head, context);
    if (resolvedHead !== undefined) return rest.length === 0 ? resolvedHead : `${resolvedHead}.${rest.join('.')}`;
    if (rest.length > 0) return name; // Already qualified (package.Type).
    return undefined;
  }

  private resolveSimple(simple: string, context: TypeDecl): string | undefined {
    // Member types of the type itself, its enclosing types and their supertypes.
    for (let scope: TypeDecl | undefined = context; scope !== undefined; scope = scope.outer) {
      const member = this.memberType(scope, simple, new Set());
      if (member !== undefined) return member;
    }
    const single = context.imports.single.get(simple);
    if (single !== undefined) return single;
    const samePackage = context.pkg ? `${context.pkg}.${simple}` : simple;
    if (this.types.has(samePackage)) return samePackage;
    for (const pkg of context.imports.onDemand) {
      if (this.types.has(`${pkg}.${simple}`)) return `${pkg}.${simple}`;
    }
    if (JAVA_LANG.has(simple)) return `java.lang.${simple}`;
    for (const pkg of context.imports.onDemand) {
      const known = KNOWN_PACKAGES[simple];
      if (known !== undefined && known === `${pkg}.${simple}`) return known;
    }
    return undefined;
  }

  private memberType(scope: TypeDecl, simple: string, seen: Set<string>): string | undefined {
    if (seen.has(scope.fqn)) return undefined;
    seen.add(scope.fqn);
    if (scope.simple === simple && scope.outer === undefined) return undefined;
    const nested = scope.nested.find((type) => type.simple === simple);
    if (nested !== undefined) return nested.fqn;
    for (const parent of this.directSupertypes(scope)) {
      const found = this.memberType(parent, simple, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  type(fqn: string): TypeDecl | undefined {
    return this.types.get(fqn);
  }

  directSupertypes(type: TypeDecl): TypeDecl[] {
    const out: TypeDecl[] = [];
    if (type.superclass !== undefined) {
      const parent = this.types.get(type.superclass.name);
      if (parent !== undefined) out.push(parent);
    }
    for (const iface of type.interfaces) {
      const parent = this.types.get(iface.name);
      if (parent !== undefined) out.push(parent);
    }
    return out;
  }

  /** Every supertype name (resolved or external), transitively, including the type itself. */
  supertypeNames(type: TypeDecl): Set<string> {
    const cached = this.assignableCache.get(type.fqn);
    if (cached !== undefined) return cached;
    const out = new Set<string>([type.fqn]);
    this.assignableCache.set(type.fqn, out);
    for (const ref of [...(type.superclass ? [type.superclass] : []), ...type.interfaces]) {
      out.add(ref.name);
      const parent = this.types.get(ref.name);
      if (parent !== undefined) for (const name of this.supertypeNames(parent)) out.add(name);
    }
    return out;
  }

  /** Generic arguments a type gives to one of its supertypes (e.g. ReactiveCrudRepository<E, ID>). */
  supertypeArguments(type: TypeDecl, target: string, seen = new Set<string>()): JType[] | undefined {
    if (seen.has(type.fqn)) return undefined;
    seen.add(type.fqn);
    for (const ref of [...(type.superclass ? [type.superclass] : []), ...type.interfaces]) {
      if (ref.name === target || typeName(ref) === target) return ref.args;
      const parent = this.types.get(ref.name);
      if (parent !== undefined) {
        const found = this.supertypeArguments(parent, target, seen);
        if (found !== undefined) {
          // Substitute the parent's type variables with the arguments given here.
          return found.map((arg) => {
            const index = parent.typeParams.indexOf(arg.name);
            return index >= 0 && ref.args[index] !== undefined ? ref.args[index]! : arg;
          });
        }
      }
    }
    return undefined;
  }

  /** Concrete, active classes assignable to `fqn`. */
  implementations(fqn: string): TypeDecl[] {
    const cached = this.implementationsCache.get(fqn);
    if (cached !== undefined) return cached;
    const out: TypeDecl[] = [];
    for (const type of this.types.values()) {
      if (type.kind !== 'class' || type.modifiers.has('abstract')) continue;
      if (!this.supertypeNames(type).has(fqn)) continue;
      out.push(type);
    }
    this.implementationsCache.set(fqn, out);
    return out;
  }

  /** Whether a Spring component is active under the configured profiles. */
  profileActive(type: TypeDecl): boolean {
    const profile = type.annotations.find((annotation) => annotation.name === 'Profile');
    if (profile === undefined) return true;
    const value = profile.args.get('value');
    if (value === undefined) return true;
    const expressions = value.type === 'element_value_array_initializer'
      ? named(value).map((item) => stringValue(item)).filter((item): item is string => item !== undefined)
      : [stringValue(value)].filter((item): item is string => item !== undefined);
    return expressions.some((expression) => evaluateProfile(expression, this.activeProfiles));
  }

  /** Methods named `name` visible on `type` (own, synthetic, inherited, interface defaults). */
  methodsOf(type: TypeDecl, name: string, seen = new Set<string>()): MethodDecl[] {
    if (seen.has(type.fqn)) return [];
    seen.add(type.fqn);
    const own = type.methods.filter((method) => method.name === name);
    const inherited = this.directSupertypes(type).flatMap((parent) => this.methodsOf(parent, name, seen));
    // An own method overrides an inherited one with the same arity.
    return [...own, ...inherited.filter((method) => !own.some((candidate) => candidate.params.length === method.params.length))];
  }

  /** Instance fields including inherited ones, superclass first. */
  instanceFields(type: TypeDecl, seen = new Set<string>()): FieldDecl[] {
    if (seen.has(type.fqn)) return [];
    seen.add(type.fqn);
    const parent = type.superclass === undefined ? undefined : this.types.get(type.superclass.name);
    return [
      ...(parent === undefined ? [] : this.instanceFields(parent, seen)),
      ...type.fields.filter((decl) => !decl.modifiers.has('static')),
    ];
  }

  staticField(type: TypeDecl, name: string, seen = new Set<string>()): FieldDecl | undefined {
    if (seen.has(type.fqn)) return undefined;
    seen.add(type.fqn);
    const own = type.fields.find((decl) => decl.name === name && decl.modifiers.has('static'));
    if (own !== undefined) return own;
    for (const parent of this.directSupertypes(type)) {
      const found = this.staticField(parent, name, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Lombok and records
  // -------------------------------------------------------------------------

  private synthesize(type: TypeDecl): void {
    const has = (name: string) => type.annotations.some((annotation) => annotation.name === name);
    const fieldHas = (decl: FieldDecl, name: string) => decl.annotations.some((annotation) => annotation.name === name);
    const instanceFields = type.fields.filter((decl) => !decl.modifiers.has('static'));
    const addMethod = (method: Omit<MethodDecl, 'owner' | 'node' | 'annotations' | 'modifiers' | 'isConstructor' | 'varargs'>) => {
      if (type.methods.some((existing) => existing.name === method.name && existing.params.length === method.params.length)) return;
      type.methods.push({ ...method, owner: type, node: type.node, annotations: [], modifiers: new Set(['public']), isConstructor: false, varargs: false });
    };

    if (type.kind === 'record') {
      for (const component of type.recordComponents) {
        addMethod({ name: component.name, params: [], returnType: component.type, synthetic: { kind: 'accessor', property: component.name } });
      }
      const canonical = type.constructors.find((ctor) => ctor.params.length === type.recordComponents.length && ctor.node.type !== 'compact_constructor_declaration');
      if (canonical === undefined && !type.constructors.some((ctor) => ctor.node.type === 'compact_constructor_declaration')) {
        type.constructors.push(syntheticCtor(type, type.recordComponents));
      }
    }

    if (type.kind === 'enum') {
      addMethod({ name: 'name', params: [], returnType: { name: 'java.lang.String', args: [], array: 0 }, synthetic: { kind: 'enum-name' } });
      addMethod({ name: 'toString', params: [], returnType: { name: 'java.lang.String', args: [], array: 0 }, synthetic: { kind: 'enum-name' } });
    }

    const data = has('Data');
    const value = has('Value');
    const classGetter = data || value || has('Getter');
    const classSetter = data || has('Setter');
    for (const decl of instanceFields) {
      const capital = decl.name.charAt(0).toUpperCase() + decl.name.slice(1);
      const booleanPrimitive = decl.type.name === 'boolean' && decl.type.array === 0;
      if (classGetter || fieldHas(decl, 'Getter')) {
        const getter = booleanPrimitive
          ? (decl.name.startsWith('is') && /^is[A-Z]/.test(decl.name) ? decl.name : `is${capital}`)
          : `get${capital}`;
        addMethod({ name: getter, params: [], returnType: decl.type, synthetic: { kind: 'getter', property: decl.name } });
      }
      if ((classSetter || fieldHas(decl, 'Setter')) && !decl.modifiers.has('final') && !value) {
        const setterName = booleanPrimitive && /^is[A-Z]/.test(decl.name) ? `set${decl.name.slice(2)}` : `set${capital}`;
        addMethod({
          name: setterName,
          params: [{ name: decl.name, type: decl.type, annotations: [], node: decl.node }],
          returnType: { name: 'void', args: [], array: 0 },
          synthetic: { kind: 'setter', property: decl.name },
        });
      }
    }

    const ctorParams = (decls: FieldDecl[]): Param[] => decls.map((decl) => ({ name: decl.name, type: decl.type, annotations: decl.annotations, node: decl.node }));
    const explicitCtors = type.constructors.length > 0;
    if (has('AllArgsConstructor') || value || (has('Builder') && !explicitCtors && !has('NoArgsConstructor') && !has('RequiredArgsConstructor'))) {
      const params = ctorParams(instanceFields.filter((decl) => !(decl.modifiers.has('final') && decl.initializer !== undefined)));
      if (!type.constructors.some((ctor) => ctor.params.length === params.length)) type.constructors.push(syntheticCtor(type, params));
    }
    if (has('RequiredArgsConstructor') || (data && !explicitCtors && !has('AllArgsConstructor') && !has('NoArgsConstructor'))) {
      const required = instanceFields.filter((decl) => (decl.modifiers.has('final') && decl.initializer === undefined) || fieldHas(decl, 'NonNull'));
      const params = ctorParams(required);
      if (!type.constructors.some((ctor) => ctor.params.length === params.length)) type.constructors.push(syntheticCtor(type, params));
    }
    if (has('NoArgsConstructor') && !type.constructors.some((ctor) => ctor.params.length === 0)) {
      type.constructors.push(syntheticCtor(type, []));
    }
    if (type.kind === 'class' && !explicitCtors && type.constructors.length === 0) {
      type.constructors.push(syntheticCtor(type, []));
    }
    if (has('Builder')) {
      addMethod({
        name: 'builder',
        params: [],
        returnType: { name: `${type.fqn}.${type.simple}Builder`, args: [], array: 0 },
        synthetic: { kind: 'builder' },
      });
      const builderAnnotation = type.annotations.find((annotation) => annotation.name === 'Builder');
      if (builderAnnotation?.args.get('toBuilder')?.text === 'true') {
        addMethod({
          name: 'toBuilder',
          params: [],
          returnType: { name: `${type.fqn}.${type.simple}Builder`, args: [], array: 0 },
          synthetic: { kind: 'toBuilder' },
        });
      }
    }
  }
}

function syntheticCtor(type: TypeDecl, params: Param[]): MethodDecl {
  return {
    name: '<init>',
    params,
    returnType: { name: type.fqn, args: [], array: 0 },
    node: type.node,
    annotations: [],
    modifiers: new Set(['public']),
    owner: type,
    isConstructor: true,
    synthetic: { kind: 'all-args-ctor', properties: params.map((param) => param.name) },
    varargs: false,
  };
}

export function annotationsOf(modifiers: SyntaxNode | undefined): Annotation[] {
  return named(modifiers)
    .filter((node) => node.type === 'annotation' || node.type === 'marker_annotation')
    .map((node) => {
      const nameNode = field(node, 'name');
      const fullName = nameNode?.text ?? '';
      const args = new Map<string, SyntaxNode>();
      const list = field(node, 'arguments');
      for (const arg of named(list)) {
        if (arg.type === 'element_value_pair') {
          const key = field(arg, 'key')?.text;
          const value = field(arg, 'value');
          if (key !== undefined && value !== undefined) args.set(key, value);
        } else {
          args.set('value', arg);
        }
      }
      return { name: fullName.slice(fullName.lastIndexOf('.') + 1), node, args };
    });
}

function modifierSet(modifiers: SyntaxNode | undefined): Set<string> {
  const out = new Set<string>();
  if (modifiers === undefined) return out;
  for (const child of modifiers.children) {
    if (child !== null && child.type !== 'annotation' && child.type !== 'marker_annotation') out.add(child.text);
  }
  return out;
}

/** Spring profile expressions: `a`, `!a`, `a & b`, `a | b`, parentheses. */
export function evaluateProfile(expression: string, active: ReadonlySet<string>): boolean {
  const tokens = expression.match(/[()!&|]|[^\s()!&|]+/g) ?? [];
  let index = 0;
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (tokens[index] === '|') {
      index += 1;
      value = parseAnd() || value;
    }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parseUnary();
    while (tokens[index] === '&') {
      index += 1;
      value = parseUnary() && value;
    }
    return value;
  };
  const parseUnary = (): boolean => {
    const token = tokens[index++];
    if (token === '!') return !parseUnary();
    if (token === '(') {
      const value = parseOr();
      index += 1;
      return value;
    }
    return token !== undefined && active.has(token);
  };
  return parseOr();
}
