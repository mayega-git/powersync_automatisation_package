import type { Expr } from '../../ir/types.js';
import { typeName, type JType, type MethodDecl, type TypeDecl } from '../java/model.js';
import { stringValue, type SyntaxNode } from '../java/parser.js';
import type { Evaluator, Scope } from './evaluator.js';
import { cond, NULL, obj, op, Unsupported, vr, type SV } from './sv.js';

const UNSUPPORTED_JSON = new Set(['JsonFormat', 'JsonSerialize', 'JsonValue', 'JsonUnwrapped', 'JsonAnyGetter', 'JsonView', 'JsonTypeInfo', 'JsonRawValue', 'JsonGetter', 'JsonIdentityInfo', 'JsonNaming']);

interface JsonProperty {
  json: string;
  /** Getter to call, or field to read. */
  getter?: MethodDecl;
  field?: string;
  jt: JType;
}

/**
 * Serializes a value the way Spring's default Jackson ObjectMapper would:
 * getter-based properties, @JsonProperty / @JsonIgnore honored, java.time
 * values as ISO strings, enums by name.
 */
export class JacksonModel {
  private readonly cache = new Map<string, JsonProperty[]>();

  constructor(private readonly ev: Evaluator) {}

  serialize(value: SV, node: SyntaxNode, scope: Scope, depth = 0): Expr {
    if (depth > 12) throw new Unsupported('Response object graph is too deep', node);
    switch (value.t) {
      case 'void':
        return NULL;
      case 'pure':
        return this.serializePure(value.e, value.jt, node, scope, depth);
      case 'obj':
        return this.serializeObject(value, node, scope, depth);
      case 'list': {
        const as = scope.block.fresh('json');
        return { k: 'map', of: value.e, as, body: this.serialize(value.element(vr(as)), node, scope, depth + 1) };
      }
      case 'optional':
        return cond(value.present, this.serialize(value.value, node, scope, depth + 1), NULL);
      default:
        throw new Unsupported(`Cannot serialize ${value.t} as JSON`, node);
    }
  }

  private serializePure(e: Expr, jt: JType, node: SyntaxNode, scope: Scope, depth: number): Expr {
    const decl = this.ev.project.type(jt.name);
    if (decl !== undefined && (decl.kind === 'class' || decl.kind === 'record')) {
      const view = obj(decl.fqn, new Map(), e);
      return cond(op('isNull', e), NULL, this.serializeObject(view, node, scope, depth));
    }
    if (['java.util.List', 'java.util.Collection', 'java.lang.Iterable', 'java.util.Set'].includes(jt.name)) {
      const elem = jt.args[0];
      if (elem === undefined) return e;
      const as = scope.block.fresh('json');
      return cond(op('isNull', e), NULL, { k: 'map', of: e, as, body: this.serializePure(vr(as), elem, node, scope, depth + 1) });
    }
    if (jt.name === 'java.util.Map' || jt.name === 'com.fasterxml.jackson.databind.JsonNode') {
      throw new Unsupported(`Serializing ${typeName(jt)} is not modeled`, node);
    }
    return e;
  }

  private serializeObject(value: SV & { t: 'obj' }, node: SyntaxNode, scope: Scope, depth: number): Expr {
    if (value.cls === 'aeris.MutableList' || value.cls === 'aeris.MutableSet') return this.serialize(this.ev.asList(value, node, scope), node, scope, depth + 1);
    if (value.cls === 'aeris.MutableMap') {
      const entries: Record<string, Expr> = {};
      for (const [key, item] of value.fields) entries[key] = this.serialize(item, node, scope, depth + 1);
      return { k: 'object', fields: entries };
    }
    const fields: Record<string, Expr> = {};
    for (const property of this.properties(value.cls, node)) {
      const raw = property.getter !== undefined
        ? this.ev.inline(property.getter, value, [], node, scope)
        : this.ev.readField(value, property.field!);
      fields[property.json] = this.serialize(raw.t === 'pure' ? { ...raw, jt: property.jt } : raw, node, scope, depth + 1);
    }
    return { k: 'object', fields };
  }

  /** Jackson's view of a class: its serializable properties. */
  properties(cls: string, node: SyntaxNode): JsonProperty[] {
    const cached = this.cache.get(cls);
    if (cached !== undefined) return cached;
    const decl = this.ev.project.type(cls);
    if (decl === undefined) throw new Unsupported(`Cannot serialize ${cls}: not in the analyzed sources`, node);
    for (const annotation of decl.annotations) {
      if (UNSUPPORTED_JSON.has(annotation.name)) throw new Unsupported(`@${annotation.name} on ${decl.simple} changes JSON output`, node);
    }
    const ignored = new Set<string>();
    const ignoreAnnotation = decl.annotations.find((annotation) => annotation.name === 'JsonIgnoreProperties');
    const ignoredValue = ignoreAnnotation?.args.get('value');
    if (ignoredValue !== undefined) {
      for (const text of ignoredValue.type === 'element_value_array_initializer' ? ignoredValue.namedChildren : [ignoredValue]) {
        const name = text === null ? undefined : stringValue(text);
        if (name !== undefined) ignored.add(name);
      }
    }
    const fieldsByName = new Map(this.ev.project.instanceFields(decl).map((field) => [field.name, field]));
    const out: JsonProperty[] = [];
    const seen = new Set<string>();
    const add = (logical: string, property: Omit<JsonProperty, 'json'>, annotations: readonly { name: string; args: Map<string, SyntaxNode> }[]) => {
      if (seen.has(logical)) return;
      seen.add(logical);
      const fieldDecl = fieldsByName.get(logical);
      const all = [...annotations, ...(fieldDecl?.annotations ?? [])];
      for (const annotation of all) {
        if (UNSUPPORTED_JSON.has(annotation.name)) throw new Unsupported(`@${annotation.name} on ${decl.simple}.${logical} changes JSON output`, node);
      }
      if (all.some((annotation) => annotation.name === 'JsonIgnore') || ignored.has(logical)) return;
      const renamed = all.find((annotation) => annotation.name === 'JsonProperty');
      const explicit = renamed?.args.get('value') ?? renamed?.args.get('name');
      out.push({ json: explicit === undefined ? logical : stringValue(explicit) ?? logical, ...property });
    };

    if (decl.kind === 'record') {
      for (const component of decl.recordComponents) {
        const accessor = decl.methods.find((method) => method.name === component.name && method.params.length === 0)!;
        add(component.name, { getter: accessor, jt: component.type }, component.annotations);
      }
    } else {
      for (const getter of this.getters(decl)) add(getter.logical, { getter: getter.method, jt: getter.method.returnType }, getter.method.annotations);
      for (const field of this.ev.project.instanceFields(decl)) {
        if (field.modifiers.has('public')) add(field.name, { field: field.name, jt: field.type }, field.annotations);
      }
    }
    this.cache.set(cls, out);
    return out;
  }

  private getters(decl: TypeDecl): { logical: string; method: MethodDecl }[] {
    const out: { logical: string; method: MethodDecl }[] = [];
    const visit = (type: TypeDecl, seenTypes: Set<string>) => {
      if (seenTypes.has(type.fqn)) return;
      seenTypes.add(type.fqn);
      for (const method of type.methods) {
        if (method.params.length !== 0 || method.modifiers.has('static')) continue;
        if (!method.modifiers.has('public') && method.synthetic === undefined && type.kind !== 'interface') continue;
        if (method.returnType.name === 'void' || method.name === 'getClass') continue;
        let logical: string | undefined;
        if (/^get[A-Z0-9_]/.test(method.name)) logical = legacyName(method.name.slice(3));
        else if (/^is[A-Z0-9_]/.test(method.name) && method.returnType.name === 'boolean') logical = legacyName(method.name.slice(2));
        if (logical === undefined || out.some((entry) => entry.logical === logical)) continue;
        out.push({ logical, method });
      }
      for (const parent of this.ev.project.directSupertypes(type)) visit(parent, seenTypes);
    };
    visit(decl, new Set());
    return out;
  }
}

/** Jackson's legacy bean naming: lowercase the leading run of capitals ("URLPath" -> "urlpath"). */
export function legacyName(suffix: string): string {
  let index = 0;
  while (index < suffix.length && suffix[index] === suffix[index]!.toUpperCase() && suffix[index] !== suffix[index]!.toLowerCase()) index += 1;
  if (index === 0) return suffix;
  return suffix.slice(0, index).toLowerCase() + suffix.slice(index);
}
