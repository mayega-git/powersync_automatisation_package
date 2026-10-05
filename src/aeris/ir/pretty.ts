import type { EndpointPlan, Expr, Filter, Instr } from './types.js';

const BINARY: Readonly<Record<string, string>> = {
  eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=', and: '&&', or: '||', add: '+', sub: '-', mul: '*', div: '/', mod: '%',
};

/** Human-readable form of an expression, for reports and `aeris explain`. */
export function prettyExpr(expr: Expr): string {
  switch (expr.k) {
    case 'lit': return JSON.stringify(expr.v);
    case 'input': return expr.path.length === 0 ? 'body' : `body.${expr.path.join('.')}`;
    case 'param': return `path.${expr.name}`;
    case 'query': return `query.${expr.name}`;
    case 'ctx': return `session.${expr.name}`;
    case 'var': return expr.name;
    case 'get': return `${prettyExpr(expr.of)}.${expr.field}`;
    case 'now': return `now<${expr.type}>`;
    case 'uuid': return `newId#${expr.slot}`;
    case 'cond': return `(${prettyExpr(expr.test)} ? ${prettyExpr(expr.then)} : ${prettyExpr(expr.else)})`;
    case 'op': {
      const symbol = BINARY[expr.op];
      if (symbol !== undefined && expr.args.length >= 2) return `(${expr.args.map(prettyExpr).join(` ${symbol} `)})`;
      if (expr.op === 'not') return `!${prettyExpr(expr.args[0]!)}`;
      return `${expr.op}(${expr.args.map(prettyExpr).join(', ')})`;
    }
    case 'object': return `{ ${Object.entries(expr.fields).map(([name, value]) => `${name}: ${prettyExpr(value)}`).join(', ')} }`;
    case 'list': return `[${expr.items.map(prettyExpr).join(', ')}]`;
    case 'map': return `${prettyExpr(expr.of)}.map(${expr.as} => ${prettyExpr(expr.body)})`;
    case 'filter': return `${prettyExpr(expr.of)}.filter(${expr.as} => ${prettyExpr(expr.body)})`;
    case 'sort': return `${prettyExpr(expr.of)}.sortBy(${expr.as} => ${expr.keys.map((key) => `${prettyExpr(key.key)}${key.desc ? ' desc' : ''}`).join(', ')})`;
    case 'fold': return `${prettyExpr(expr.of)}.fold(${prettyExpr(expr.init)}, (${expr.acc}, ${expr.as}) => ${prettyExpr(expr.body)})`;
    case 'try': return `try(${prettyExpr(expr.body)}) catch ${expr.catches} (${prettyExpr(expr.fallback)})`;
    case 'cast': return `${expr.to}(${prettyExpr(expr.of)})`;
  }
}

function prettyFilter(filter: Filter): string {
  if (filter.cmp === 'isNull' || filter.cmp === 'notNull') return `${filter.field} ${filter.cmp === 'isNull' ? 'IS NULL' : 'IS NOT NULL'}`;
  return `${filter.field} ${BINARY[filter.cmp] ?? filter.cmp} ${prettyExpr(filter.value!)}`;
}

export function prettyProgram(program: readonly Instr[], indent = ''): string {
  const lines: string[] = [];
  for (const instr of program) {
    switch (instr.op) {
      case 'QUERY': {
        const where = instr.where.length === 0 ? '' : ` WHERE ${instr.where.map(prettyFilter).join(' AND ')}`;
        const order = instr.orderBy === undefined ? '' : ` ORDER BY ${instr.orderBy.map((o) => `${o.field} ${o.dir}`).join(', ')}`;
        lines.push(`${indent}${instr.out} := ${instr.mode.toUpperCase()} ${shortName(instr.entity)}${where}${order}${instr.limit ? ` LIMIT ${instr.limit}` : ''}`);
        break;
      }
      case 'LET': lines.push(`${indent}${instr.out} := ${prettyExpr(instr.expr)}`); break;
      case 'ASSERT': lines.push(`${indent}ASSERT ${prettyExpr(instr.test)} ELSE ${instr.error.status} ${instr.error.code}`); break;
      case 'IF':
        lines.push(`${indent}IF ${prettyExpr(instr.test)}`);
        lines.push(prettyProgram(instr.then, `${indent}  `));
        if (instr.else.length > 0) {
          lines.push(`${indent}ELSE`);
          lines.push(prettyProgram(instr.else, `${indent}  `));
        }
        break;
      case 'INSERT': lines.push(`${indent}INSERT ${shortName(instr.entity)} ${prettyExpr({ k: 'object', fields: instr.values })}${instr.out ? ` -> ${instr.out}` : ''}`); break;
      case 'UPDATE': lines.push(`${indent}UPDATE ${shortName(instr.entity)}[${prettyExpr(instr.key)}] SET ${prettyExpr({ k: 'object', fields: instr.values })}`); break;
      case 'DELETE': lines.push(`${indent}DELETE ${shortName(instr.entity)}[${prettyExpr(instr.key)}]`); break;
      case 'EMIT_LOCAL_EVENT': lines.push(`${indent}EMIT ${instr.name} ${prettyExpr(instr.payload)}`); break;
      case 'QUEUE_INTENT': lines.push(`${indent}QUEUE_INTENT`); break;
      case 'RETURN': lines.push(`${indent}RETURN ${instr.status}${instr.body === null ? '' : ` ${prettyExpr(instr.body)}`}`); break;
    }
  }
  return lines.join('\n');
}

export function explainPlan(plan: EndpointPlan): string {
  const lines = [
    `${plan.id}  [${plan.offlineClass}]`,
    `handler: ${plan.handler.symbol} (${plan.handler.file})`,
    ...plan.reasons.map((reason) => `reason: ${reason}`),
    `auth: ${plan.auth.authenticated ? 'authenticated' : 'public'}; session claims: ${plan.auth.context.join(', ') || 'none'}${plan.auth.policies?.length ? `; policies: ${plan.auth.policies.join(' | ')}` : ''}`,
    `reads: ${plan.reads.map(shortName).join(', ') || 'none'}; writes: ${plan.writes.map(shortName).join(', ') || 'none'}`,
  ];
  if (plan.sync !== undefined) {
    lines.push(`sync: idempotency=${plan.sync.idempotency} (${plan.sync.idempotencyHeader}), conflict=${plan.sync.conflict}${plan.sync.idMap.length > 0 ? `, id remap: ${plan.sync.idMap.map((m) => `newId#${m.slot} -> response.${m.responsePath.join('.')}`).join(', ')}` : ''}`);
  }
  if (plan.freshness.maxAgeSeconds > 0) lines.push(`freshness: local data must be younger than ${plan.freshness.maxAgeSeconds}s`);
  lines.push(`evidence: ${plan.evidence.length} source locations`);
  if (plan.program !== undefined) lines.push('', prettyProgram(plan.program));
  return lines.join('\n');
}

function shortName(entity: string): string {
  return entity.slice(entity.lastIndexOf('.') + 1);
}
