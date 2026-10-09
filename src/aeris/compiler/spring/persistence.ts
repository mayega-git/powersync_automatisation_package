import type { FieldType, FilterCmp, OrderBy } from '../../ir/types.js';
import { stringValue, type SyntaxNode } from '../java/parser.js';
import { isPrimitive, typeName, type Annotation, type JavaProject, type JType, type MethodDecl, type TypeDecl } from '../java/model.js';
import { Unsupported } from './sv.js';

export interface PropertyModel {
  name: string;
  column: string;
  jt: JType;
  type: FieldType;
  isId: boolean;
}

export interface EntityModel {
  fqn: string;
  decl: TypeDecl;
  schema?: string;
  table: string;
  key: string;
  properties: Map<string, PropertyModel>;
  /** Transient fields (part of the Java object, never stored). */
  transients: Set<string>;
  persistable: boolean;
  version?: string;
  /** AfterConvertCallback beans for this entity, applied on every load. */
  afterConvert: MethodDecl[];
  auditing: { created: string[]; modified: string[] };
}

export interface RepositoryModel {
  fqn: string;
  decl: TypeDecl;
  entity: EntityModel;
  idType: JType;
  /**
   * Reactive (R2DBC: every method answers a Mono or a Flux) or blocking (JPA
   * and plain Spring Data: every method answers the value itself). The query
   * semantics are identical; only the wrapper differs, so the compiler proves
   * the query once and unwraps at the call site.
   */
  reactive: boolean;
}

export type QueryResult = 'one' | 'many' | 'count' | 'exists' | 'delete';

export interface DerivedCriterion {
  property: string;
  cmp: FilterCmp | 'between' | 'true' | 'false';
  /** Number of method arguments consumed. */
  arity: number;
}

export interface QueryShape {
  mode: QueryResult;
  criteria: DerivedCriterion[];
  orderBy: OrderBy[];
  limit?: number;
  /** For @Query: method parameter feeding each criterion, by name or position. */
  bindings?: (string | number)[];
}

const REPOSITORY_BASES = [
  'org.springframework.data.repository.reactive.ReactiveCrudRepository',
  'org.springframework.data.repository.reactive.ReactiveSortingRepository',
  'org.springframework.data.r2dbc.repository.R2dbcRepository',
  'org.springframework.data.repository.CrudRepository',
  'org.springframework.data.repository.ListCrudRepository',
  'org.springframework.data.repository.PagingAndSortingRepository',
  'org.springframework.data.jpa.repository.JpaRepository',
  'org.springframework.data.repository.Repository',
  'ReactiveCrudRepository', 'ReactiveSortingRepository', 'R2dbcRepository', 'CrudRepository', 'ListCrudRepository',
  'PagingAndSortingRepository', 'JpaRepository',
];

const TEMPORAL: Readonly<Record<string, FieldType['type']>> = {
  'java.time.LocalDateTime': 'datetime-local',
  'java.time.Instant': 'datetime',
  'java.time.OffsetDateTime': 'datetime',
  'java.time.ZonedDateTime': 'datetime',
  'java.time.LocalDate': 'date',
  'java.time.LocalTime': 'time',
};

/** Maps a Java type to its wire/storage type, or undefined when it has no scalar form. */
export function fieldTypeOf(project: JavaProject, jt: JType): FieldType | undefined {
  if (jt.array === 1) {
    const element = fieldTypeOf(project, { ...jt, array: 0 });
    return element === undefined || element.list ? undefined : { ...element, list: true, nullable: true };
  }
  if (jt.array > 1) return undefined;
  if (['java.util.List', 'java.util.Set', 'java.util.Collection'].includes(jt.name) && jt.args[0] !== undefined) {
    const element = fieldTypeOf(project, jt.args[0]);
    return element === undefined || element.list ? undefined : { ...element, list: true, nullable: true };
  }
  if (jt.name === 'io.r2dbc.postgresql.codec.Json' || jt.name === 'com.fasterxml.jackson.databind.JsonNode') return { type: 'json', nullable: true };
  const nullable = !isPrimitive(jt);
  switch (jt.name) {
    case 'java.util.UUID': return { type: 'uuid', nullable };
    case 'java.lang.String': case 'char': case 'java.lang.Character': return { type: 'string', nullable };
    case 'int': case 'long': case 'short': case 'byte':
    case 'java.lang.Integer': case 'java.lang.Long': case 'java.lang.Short': case 'java.lang.Byte': case 'java.math.BigInteger':
      return { type: 'integer', nullable };
    case 'double': case 'float': case 'java.lang.Double': case 'java.lang.Float': case 'java.math.BigDecimal':
      return { type: 'decimal', nullable };
    case 'boolean': case 'java.lang.Boolean': return { type: 'boolean', nullable };
  }
  const temporal = TEMPORAL[jt.name];
  if (temporal !== undefined) return { type: temporal, nullable };
  const decl = project.type(jt.name);
  if (decl?.kind === 'enum') return { type: 'enum', nullable, values: decl.enumConstants };
  return undefined;
}

/** Spring Data's default naming: camelCase -> snake_case. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function annotation(list: readonly Annotation[], ...names: string[]): Annotation | undefined {
  return list.find((candidate) => names.includes(candidate.name));
}

export function annotationString(item: Annotation | undefined, key: string): string | undefined {
  const node = item?.args.get(key);
  return node === undefined ? undefined : stringValue(node);
}

/**
 * Entities and repositories of the code base, in the R2DBC/JDBC mapping
 * conventions Spring Data applies by default.
 */
export class PersistenceModel {
  readonly entities = new Map<string, EntityModel>();
  readonly repositories = new Map<string, RepositoryModel>();
  readonly problems = new Map<string, string>();

  constructor(private readonly project: JavaProject) {
    for (const decl of project.types.values()) {
      if (decl.kind !== 'interface') continue;
      let args: JType[] | undefined;
      let reactive = false;
      for (const base of REPOSITORY_BASES) {
        args = project.supertypeArguments(decl, base);
        if (args !== undefined) {
          reactive = /Reactive|R2dbc/.test(base);
          break;
        }
      }
      if (args === undefined || args.length < 2) continue;
      const entityDecl = project.type(args[0]!.name);
      if (entityDecl === undefined) continue;
      try {
        const entity = this.entity(entityDecl);
        this.repositories.set(decl.fqn, { fqn: decl.fqn, decl, entity, idType: args[1]!, reactive });
      } catch (error) {
        this.problems.set(decl.fqn, (error as Error).message);
      }
    }
  }

  repository(fqn: string): RepositoryModel | undefined {
    return this.repositories.get(fqn);
  }

  isEntity(fqn: string): boolean {
    return this.entities.has(fqn) || [...this.repositories.values()].some((repo) => repo.entity.fqn === fqn);
  }

  entity(decl: TypeDecl): EntityModel {
    const cached = this.entities.get(decl.fqn);
    if (cached !== undefined) return cached;
    const table = annotation(decl.annotations, 'Table', 'Entity');
    const tableName = annotationString(table, 'value') ?? annotationString(table, 'name') ?? snakeCase(decl.simple);
    const schema = annotationString(table, 'schema');
    const properties = new Map<string, PropertyModel>();
    const transients = new Set<string>();
    let key: string | undefined;
    let version: string | undefined;
    const auditing = { created: [] as string[], modified: [] as string[] };
    const members = decl.kind === 'record'
      ? decl.recordComponents.map((component) => ({ name: component.name, type: component.type, annotations: component.annotations, modifiers: new Set<string>() }))
      : this.project.instanceFields(decl);
    for (const decl2 of members) {
      if (decl2.modifiers.has('transient') || annotation(decl2.annotations, 'Transient') !== undefined) {
        transients.add(decl2.name);
        continue;
      }
      const type = fieldTypeOf(this.project, decl2.type);
      if (type === undefined) {
        throw new Unsupported(`Entity ${decl.simple}.${decl2.name} has type ${decl2.type.name}, which has no portable scalar mapping.`);
      }
      const column = annotation(decl2.annotations, 'Column');
      const isId = annotation(decl2.annotations, 'Id') !== undefined;
      if (isId) key = decl2.name;
      if (annotation(decl2.annotations, 'Version') !== undefined) version = decl2.name;
      if (annotation(decl2.annotations, 'CreatedDate') !== undefined) auditing.created.push(decl2.name);
      if (annotation(decl2.annotations, 'LastModifiedDate') !== undefined) auditing.modified.push(decl2.name);
      properties.set(decl2.name, {
        name: decl2.name,
        column: annotationString(column, 'value') ?? annotationString(column, 'name') ?? snakeCase(decl2.name),
        jt: decl2.type,
        type: isId ? { ...type, nullable: false } : type,
        isId,
      });
    }
    if (key === undefined) {
      if (properties.has('id')) key = 'id';
      else throw new Unsupported(`Entity ${decl.simple} has no @Id property.`);
    }
    const supertypes = this.project.supertypeNames(decl);
    const model: EntityModel = {
      fqn: decl.fqn,
      decl,
      ...(schema === undefined ? {} : { schema }),
      table: tableName,
      key,
      properties,
      transients,
      persistable: supertypes.has('org.springframework.data.domain.Persistable') || [...supertypes].some((name) => name.endsWith('.Persistable') || name === 'Persistable'),
      ...(version === undefined ? {} : { version }),
      afterConvert: this.callbacks(decl, 'AfterConvertCallback', 'onAfterConvert'),
      auditing,
    };
    for (const name of ['BeforeConvertCallback', 'BeforeSaveCallback', 'AfterSaveCallback']) {
      if (this.callbacks(decl, name, '').length > 0) {
        throw new Unsupported(`Entity ${decl.simple} has a ${name}, whose effects are not modeled.`);
      }
    }
    this.entities.set(decl.fqn, model);
    return model;
  }

  private callbacks(entity: TypeDecl, iface: string, method: string): MethodDecl[] {
    const out: MethodDecl[] = [];
    for (const decl of this.project.types.values()) {
      if (decl.kind !== 'class' || !this.project.profileActive(decl)) continue;
      const args = this.project.supertypeArguments(decl, `org.springframework.data.r2dbc.mapping.event.${iface}`)
        ?? this.project.supertypeArguments(decl, iface);
      if (args === undefined || args[0]?.name !== entity.fqn) continue;
      if (method === '') {
        out.push(decl.methods[0]!);
        continue;
      }
      const found = decl.methods.find((candidate) => candidate.name === method);
      if (found !== undefined) out.push(found);
    }
    return out;
  }

  /** Derived-query or @Query shape of a repository method, or undefined for CRUD built-ins. */
  queryShape(repo: RepositoryModel, method: MethodDecl): QueryShape | undefined {
    const query = annotation(method.annotations, 'Query');
    if (query !== undefined) return this.sqlShape(repo, method, query);
    if (CRUD_METHODS.has(`${method.name}/${method.params.length}`)) return undefined;
    if (method.owner.fqn !== repo.decl.fqn && !repo.decl.fqn.endsWith(method.owner.simple) && this.isFrameworkType(method.owner)) return undefined;
    return parseDerivedQuery(method.name, repo.entity, returnKind(method.returnType));
  }

  private isFrameworkType(decl: TypeDecl): boolean {
    return decl.fqn.startsWith('org.springframework.');
  }

  private sqlShape(repo: RepositoryModel, method: MethodDecl, query: Annotation): QueryShape {
    if (annotation(method.annotations, 'Modifying') !== undefined) {
      throw new Unsupported(`@Modifying query ${method.name} is not modeled.`);
    }
    const sql = annotationString(query, 'value');
    if (sql === undefined) throw new Unsupported(`@Query on ${method.name} has a non-constant SQL string.`);
    return parseSimpleSql(sql, repo.entity, method, returnKind(method.returnType));
  }
}

/** Spring Data CRUD methods, possibly redeclared in a repository interface. */
export const CRUD_METHODS = new Set(['findById/1', 'existsById/1', 'findAll/0', 'count/0', 'save/1', 'deleteById/1', 'delete/1']);

function returnKind(type: JType): 'mono' | 'flux' | 'other' {
  const name = typeName(type);
  if (name === 'Mono') return 'mono';
  if (name === 'Flux' || name === 'List' || name === 'Iterable' || name === 'Collection') return 'flux';
  return 'other';
}

const OPERATORS: readonly [RegExp, DerivedCriterion['cmp'], number][] = [
  [/(IsNotNull|NotNull)$/, 'notNull', 0],
  [/(IsNull|Null)$/, 'isNull', 0],
  [/(IsLessThanEqual|LessThanEqual)$/, 'le', 1],
  [/(IsLessThan|LessThan|IsBefore|Before)$/, 'lt', 1],
  [/(IsGreaterThanEqual|GreaterThanEqual)$/, 'ge', 1],
  [/(IsGreaterThan|GreaterThan|IsAfter|After)$/, 'gt', 1],
  [/(IsBetween|Between)$/, 'between', 2],
  [/(IsNotIn|NotIn)$/, 'unsupported' as never, 1],
  [/(IsIn|In)$/, 'in', 1],
  [/(IsTrue|True)$/, 'true', 0],
  [/(IsFalse|False)$/, 'false', 0],
  [/(IsStartingWith|StartingWith|StartsWith|IsEndingWith|EndingWith|EndsWith|IsContaining|Containing|Contains|IsNotLike|NotLike|IsLike|Like|IsEmpty|Empty|IsNotEmpty|NotEmpty|Regex|Matches|Exists|Near|Within)$/, 'unsupported' as never, 1],
  [/(IsNot|Not)$/, 'ne', 1],
  [/(Is|Equals)$/, 'eq', 1],
];

/** Spring Data PartTree subset; anything outside it is refused. */
export function parseDerivedQuery(name: string, entity: EntityModel, kind: 'mono' | 'flux' | 'other'): QueryShape {
  const match = /^(find|read|get|query|search|stream|count|exists|delete|remove)(.*?)By(.*)$/.exec(name);
  if (match === null) throw new Unsupported(`Repository method ${name} is not a derived query.`);
  const [, verb, subject, predicateText] = match as unknown as [string, string, string, string];
  const deleting = verb === 'delete' || verb === 'remove';
  if (/Distinct/.test(subject)) throw new Unsupported(`Distinct query ${name} is not modeled.`);
  const top = /(?:First|Top)(\d*)/.exec(subject);
  let predicate = predicateText;
  let orderText = '';
  const orderIndex = predicate.indexOf('OrderBy');
  if (orderIndex >= 0) {
    orderText = predicate.slice(orderIndex + 'OrderBy'.length);
    predicate = predicate.slice(0, orderIndex);
  }
  if (/IgnoreCase|IgnoringCase/.test(predicate)) throw new Unsupported(`Case-insensitive query ${name} depends on database collation.`);
  if (predicate.split(/Or(?=[A-Z])/).length > 1) throw new Unsupported(`OR query ${name} is not modeled.`);
  const criteria: DerivedCriterion[] = [];
  for (const part of predicate.split(/And(?=[A-Z])/).filter(Boolean)) {
    let propertyText = part;
    let cmp: DerivedCriterion['cmp'] = 'eq';
    let arity = 1;
    for (const [pattern, candidate, consumed] of OPERATORS) {
      const found = pattern.exec(part);
      if (found !== null && part.length > found[0].length) {
        if ((candidate as string) === 'unsupported') throw new Unsupported(`Query keyword in ${name} (${found[0]}) is not modeled.`);
        propertyText = part.slice(0, part.length - found[0].length);
        cmp = candidate;
        arity = consumed;
        break;
      }
    }
    const property = propertyText.charAt(0).toLowerCase() + propertyText.slice(1);
    if (!entity.properties.has(property)) throw new Unsupported(`Query ${name} refers to ${property}, not a stored property of ${entity.decl.simple}.`);
    criteria.push({ property, cmp, arity });
  }
  const orderBy: OrderBy[] = [];
  for (const piece of orderText.match(/[A-Z][A-Za-z0-9]*?(?:Asc|Desc)(?=[A-Z]|$)|[A-Z][A-Za-z0-9]*$/g) ?? []) {
    const dir = piece.endsWith('Desc') ? 'desc' : 'asc';
    const raw = piece.replace(/(Asc|Desc)$/, '');
    const property = raw.charAt(0).toLowerCase() + raw.slice(1);
    if (!entity.properties.has(property)) throw new Unsupported(`Query ${name} orders by unknown property ${property}.`);
    orderBy.push({ field: property, dir });
  }
  let mode: QueryResult;
  if (deleting) {
    if (!criteria.some((criterion) => criterion.property === entity.key && criterion.cmp === 'eq')) {
      throw new Unsupported(`Derived delete ${name} is not bounded by the primary key.`);
    }
    return { mode: 'delete', criteria, orderBy };
  }
  if (verb === 'count') mode = 'count';
  else if (verb === 'exists') mode = 'exists';
  else if (kind === 'mono') mode = 'one';
  else if (kind === 'flux') mode = 'many';
  else throw new Unsupported(`Query ${name} has a non-reactive return type.`);
  const limit = top === null ? undefined : top[1] ? Number(top[1]) : 1;
  return { mode, criteria, orderBy, ...(limit === undefined ? {} : { limit }) };
}

/** `SELECT * FROM t WHERE a = :x AND b IS NULL ORDER BY c DESC LIMIT n` and COUNT(*). */
export function parseSimpleSql(sql: string, entity: EntityModel, method: MethodDecl, kind: 'mono' | 'flux' | 'other'): QueryShape {
  const text = sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const match = /^SELECT (\*|COUNT\(\*\)|[A-Za-z_][A-Za-z0-9_]*\.\*) FROM ([A-Za-z_][A-Za-z0-9_.]*)(?: [A-Za-z_][A-Za-z0-9_]*)?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?$/i.exec(text);
  if (match === null) throw new Unsupported(`@Query "${sql}" on ${method.name} is outside the supported SQL subset.`);
  const [, projection, table, where, order, limit] = match as unknown as [string, string, string, string | undefined, string | undefined, string | undefined];
  const tableName = table.includes('.') ? table.slice(table.lastIndexOf('.') + 1) : table;
  if (tableName.toLowerCase() !== entity.table.toLowerCase()) {
    throw new Unsupported(`@Query on ${method.name} reads ${table}, not the repository table ${entity.table}.`);
  }
  const byColumn = new Map([...entity.properties.values()].map((property) => [property.column.toLowerCase(), property.name]));
  const criteria: DerivedCriterion[] = [];
  const bindings: (string | number)[] = [];
  for (const condition of (where ?? '').split(/ AND /i).filter(Boolean)) {
    const eq = /^([A-Za-z_][A-Za-z0-9_.]*) = (?::([A-Za-z_][A-Za-z0-9_]*)|\$(\d+))$/i.exec(condition.trim());
    const isNull = /^([A-Za-z_][A-Za-z0-9_.]*) IS (NOT )?NULL$/i.exec(condition.trim());
    if (eq !== null) {
      const property = byColumn.get(eq[1]!.replace(/^.*\./, '').toLowerCase());
      if (property === undefined) throw new Unsupported(`@Query condition "${condition}" uses an unknown column.`);
      criteria.push({ property, cmp: 'eq', arity: 1 });
      bindings.push(eq[2] ?? Number(eq[3]) - 1);
    } else if (isNull !== null) {
      const property = byColumn.get(isNull[1]!.replace(/^.*\./, '').toLowerCase());
      if (property === undefined) throw new Unsupported(`@Query condition "${condition}" uses an unknown column.`);
      criteria.push({ property, cmp: isNull[2] ? 'notNull' : 'isNull', arity: 0 });
    } else {
      throw new Unsupported(`@Query condition "${condition}" is outside the supported SQL subset.`);
    }
  }
  const orderBy: OrderBy[] = [];
  for (const part of (order ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [column, direction] = part.split(' ');
    const property = byColumn.get(column!.replace(/^.*\./, '').toLowerCase());
    if (property === undefined || (direction !== undefined && !/^(ASC|DESC)$/i.test(direction))) {
      throw new Unsupported(`@Query ORDER BY "${part}" is not supported.`);
    }
    orderBy.push({ field: property, dir: direction?.toLowerCase() === 'desc' ? 'desc' : 'asc' });
  }
  const mode: QueryResult = /COUNT/i.test(projection) ? 'count' : kind === 'mono' ? 'one' : kind === 'flux' ? 'many' : (() => {
    throw new Unsupported(`@Query method ${method.name} has a non-reactive return type.`);
  })();
  return { mode, criteria, orderBy, ...(limit === undefined ? {} : { limit: Number(limit) }), bindings };
}

export function isRepositoryNode(node: SyntaxNode | undefined): boolean {
  return node !== undefined;
}
