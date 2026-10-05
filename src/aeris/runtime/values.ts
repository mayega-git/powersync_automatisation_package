import type { FieldType, JsonValue, ScalarType } from '../ir/types.js';

/**
 * Value semantics shared by the executor, the stores and the gateway. They
 * mirror what the backend does with the same values: UUIDs compare
 * case-insensitively, decimals are exact (BigDecimal), temporal values
 * compare by instant rather than by string.
 */

export class AerisValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AerisValueError';
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?(\d+)(\.\d+)?([eE][-+]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Converts a wire value to the declared type, or throws AerisValueError.
 * Used for path variables, query parameters and request bodies, where the
 * backend answers 400 on a conversion failure.
 */
export function castValue(value: JsonValue | undefined, to: ScalarType, values?: readonly string[]): JsonValue {
  if (value === undefined || value === null) return null;
  switch (to) {
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      break;
    case 'uuid':
      if (isUuid(value)) return value.toLowerCase();
      break;
    case 'integer':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      if (typeof value === 'string' && INTEGER_RE.test(value.trim())) {
        const parsed = Number(value.trim());
        if (Number.isSafeInteger(parsed)) return parsed;
      }
      break;
    case 'decimal':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) return Number(value.trim());
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      break;
    case 'date':
      if (typeof value === 'string' && DATE_RE.test(value) && isValidDate(value)) return value;
      break;
    case 'time':
      if (typeof value === 'string' && TIME_RE.test(value)) return value;
      break;
    case 'datetime-local':
      if (typeof value === 'string' && LOCAL_DATETIME_RE.test(value) && isValidDate(value.slice(0, 10))) return value;
      break;
    case 'datetime':
      if (typeof value === 'string' && DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value))) return value;
      break;
    case 'enum':
      if (typeof value === 'string' && (values === undefined || values.includes(value))) return value;
      break;
    case 'json':
      return value;
  }
  throw new AerisValueError(`Cannot convert ${JSON.stringify(value)} to ${to}.`);
}

/** Converts a value read from a projection to the wire form of its column. */
export function normalizeStored(value: JsonValue | undefined, type: FieldType): JsonValue {
  if (value === undefined || value === null) return null;
  if (type.list === true || type.type === 'json') return value;
  if (type.type === 'uuid' && typeof value === 'string') return value.toLowerCase();
  if (type.type === 'boolean' && typeof value === 'number') return value !== 0;
  if ((type.type === 'decimal' || type.type === 'integer') && typeof value === 'string' && DECIMAL_RE.test(value)) {
    return Number(value);
  }
  return value;
}

function isValidDate(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Equality with backend semantics. Strings that are both UUIDs compare
 * case-insensitively; numbers compare by value; temporal strings compare by
 * instant when both sides parse as the same temporal kind.
 */
export function valuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left === 'string' && typeof right === 'string') {
    if (left === right) return true;
    if (isUuid(left) && isUuid(right)) return left.toLowerCase() === right.toLowerCase();
    const temporal = compareTemporal(left, right);
    return temporal === 0;
  }
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
  if (typeof left === 'object' && typeof right === 'object') return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
  return false;
}

/** Total order used by range filters and ORDER BY; null when incomparable. */
export function compareValues(left: JsonValue, right: JsonValue): number | null {
  if (left === null || right === null) return null;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (typeof left === 'string' && typeof right === 'string') {
    const temporal = compareTemporal(left, right);
    if (temporal !== undefined) return temporal;
    if (isUuid(left) && isUuid(right)) return compareStrings(left.toLowerCase(), right.toLowerCase());
    return compareStrings(left, right);
  }
  return null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares two temporal strings of the same kind; undefined when they are not temporal. */
function compareTemporal(left: string, right: string): number | undefined {
  const a = temporalKey(left);
  const b = temporalKey(right);
  if (a === undefined || b === undefined || a.kind !== b.kind) return undefined;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function temporalKey(text: string): { kind: string; key: string } | undefined {
  if (DATE_RE.test(text)) return { kind: 'date', key: text };
  if (LOCAL_DATETIME_RE.test(text)) return { kind: 'local', key: padLocal(text) };
  if (DATETIME_RE.test(text)) {
    const epoch = Date.parse(text);
    if (Number.isNaN(epoch)) return undefined;
    const fraction = /\.(\d{1,9})/.exec(text)?.[1] ?? '';
    const subMillis = fraction.padEnd(9, '0').slice(3);
    const millis = Math.floor(epoch / 1000) * 1000;
    const msPart = String(epoch - millis).padStart(3, '0');
    return { kind: 'instant', key: `${String(millis / 1000).padStart(14, '0')}.${msPart}${subMillis}` };
  }
  return undefined;
}

function padLocal(text: string): string {
  const [date, time] = text.split('T') as [string, string];
  const [clock, fraction = ''] = time.split('.') as [string, string?];
  const full = clock.length === 5 ? `${clock}:00` : clock;
  return `${date}T${full}.${fraction.padEnd(9, '0')}`;
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, JsonValue>)[key]!);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic (BigDecimal add/subtract/multiply)
// ---------------------------------------------------------------------------

interface Scaled {
  units: bigint;
  scale: number;
}

function toScaled(value: number): Scaled {
  // Shortest round-trip decimal representation, as BigDecimal.valueOf(double) would read it.
  const text = numberToPlainString(value);
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = digits.split('.') as [string, string?];
  const units = BigInt(`${whole}${fraction}` || '0');
  return { units: negative ? -units : units, scale: fraction.length };
}

function numberToPlainString(value: number): string {
  const text = String(value);
  if (!/e/i.test(text)) return text;
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (match === null) throw new AerisValueError(`Unsupported number ${text}`);
  const [, sign, lead, rest = '', exponentText] = match as unknown as [string, string, string, string, string];
  const exponent = Number(exponentText);
  const digits = `${lead}${rest}`;
  if (exponent >= 0) {
    const padded = digits.padEnd(exponent + 1, '0');
    const whole = padded.slice(0, exponent + 1);
    const fraction = padded.slice(exponent + 1);
    return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
  }
  return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
}

function fromScaled({ units, scale }: Scaled): number {
  const negative = units < 0n;
  let digits = (negative ? -units : units).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return Number(`${negative ? '-' : ''}${digits}`);
}

function align(left: Scaled, right: Scaled): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.units * 10n ** BigInt(scale - left.scale),
    right.units * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

export function decimalAdd(left: number, right: number): number {
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right) && Number.isSafeInteger(left + right)) return left + right;
  const [a, b, scale] = align(toScaled(left), toScaled(right));
  return fromScaled({ units: a + b, scale });
}

export function decimalSub(left: number, right: number): number {
  return decimalAdd(left, -right);
}

export function decimalMul(left: number, right: number): number {
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right) && Number.isSafeInteger(left * right)) return left * right;
  const a = toScaled(left);
  const b = toScaled(right);
  return fromScaled({ units: a.units * b.units, scale: a.scale + b.scale });
}

export type RoundingMode = 'UP' | 'DOWN' | 'CEILING' | 'FLOOR' | 'HALF_UP' | 'HALF_DOWN' | 'HALF_EVEN' | 'UNNECESSARY';

/** Divides scaled integers and rounds the quotient to an integer like java.math.RoundingMode. */
function roundQuotient(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new AerisValueError('Division by zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // truncated toward zero
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const sign = numerator < 0n ? -1n : 1n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const awayFromZero = quotient + sign;
  switch (mode) {
    case 'UNNECESSARY': throw new AerisValueError('Rounding necessary');
    case 'DOWN': return quotient;
    case 'UP': return awayFromZero;
    case 'CEILING': return sign > 0n ? awayFromZero : quotient;
    case 'FLOOR': return sign < 0n ? awayFromZero : quotient;
    case 'HALF_UP': return twice >= denominator ? awayFromZero : quotient;
    case 'HALF_DOWN': return twice > denominator ? awayFromZero : quotient;
    case 'HALF_EVEN':
      if (twice > denominator) return awayFromZero;
      if (twice < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
  }
}

/** BigDecimal.setScale(scale, mode). */
export function decimalSetScale(value: number, scale: number, mode: RoundingMode): number {
  const scaled = toScaled(value);
  if (scale >= scaled.scale) return value;
  const divisor = 10n ** BigInt(scaled.scale - scale);
  return fromScaled({ units: roundQuotient(scaled.units, divisor, mode), scale });
}

/** BigDecimal.divide(divisor, scale, mode). */
export function decimalDivide(dividend: number, divisor: number, scale: number, mode: RoundingMode): number {
  const a = toScaled(dividend);
  const b = toScaled(divisor);
  // a.units/10^a.scale / (b.units/10^b.scale) * 10^scale
  const numerator = a.units * 10n ** BigInt(b.scale + scale);
  const denominator = b.units * 10n ** BigInt(a.scale);
  return fromScaled({ units: roundQuotient(numerator, denominator, mode), scale });
}

/** Character.isWhitespace: Unicode separators except non-breaking spaces, plus ASCII controls. */
export function javaStrip(text: string): string {
  const isWhitespace = (char: string) => /[\t\n\u000B\f\r\u001C-\u001F]/.test(char) ||
    (/[\p{Zs}\p{Zl}\p{Zp}]/u.test(char) && !/[\u00A0\u2007\u202F]/.test(char));
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && isWhitespace(chars[start]!)) start += 1;
  while (end > start && isWhitespace(chars[end - 1]!)) end -= 1;
  return chars.slice(start, end).join('');
}

// ---------------------------------------------------------------------------
// Captured clock
// ---------------------------------------------------------------------------

/** Formats a captured instant the way Jackson writes java.time values (ISO, trailing zeros trimmed). */
export function formatNow(epochMillis: number, type: 'datetime' | 'datetime-local' | 'date', timeZone: string): string {
  if (type === 'datetime') {
    // Instant.toString(): the fraction is printed in groups of three digits, omitted when zero.
    const iso = new Date(epochMillis).toISOString();
    return iso.endsWith('.000Z') ? `${iso.slice(0, 19)}Z` : iso;
  }
  const parts = wallClock(epochMillis, timeZone);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (type === 'date') return date;
  const millis = String(epochMillis % 1000 < 0 ? epochMillis % 1000 + 1000 : epochMillis % 1000).padStart(3, '0');
  return trimFraction(`${date}T${parts.hour}:${parts.minute}:${parts.second}.${millis}`);
}

function trimFraction(text: string): string {
  const match = /^(.*?)(?:\.(\d+))?$/.exec(text);
  if (match === null) return text;
  const [, head, fraction] = match as unknown as [string, string, string | undefined];
  if (fraction === undefined) return head;
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length === 0 ? head : `${head}.${trimmed}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(epochMillis: number, timeZone: string): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string> {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMillis))) out[part.type] = part.value;
  return out as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

/** RFC 4122 version 4 identifier from a cryptographic source. */
export function randomUuid(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.randomUUID !== undefined) return crypto.randomUUID();
  if (crypto?.getRandomValues === undefined) throw new Error('No cryptographic random source available.');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
