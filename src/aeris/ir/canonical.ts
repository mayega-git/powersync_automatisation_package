import type { JsonValue } from './types.js';

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
 * numbers in their shortest round-trip form. Two semantically equal
 * documents always encode to the same bytes, whatever their key order, so a
 * digest or a signature survives a re-serialization by any JSON library.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

function encode(value: unknown, stack: Set<unknown>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot encode a non-finite number.');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (stack.has(value)) throw new TypeError('Canonical JSON cannot encode a cyclic structure.');
      stack.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => encode(item === undefined ? null : item, stack)).join(',')}]`;
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], stack)}`).join(',')}}`;
      } finally {
        stack.delete(value);
      }
    }
    default:
      throw new TypeError(`Canonical JSON cannot encode a value of type ${typeof value}.`);
  }
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.subtle === undefined) {
    throw new Error('WebCrypto is not available: AERIS needs crypto.subtle (secure context).');
  }
  return crypto.subtle;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const digest = await subtle().digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** `sha256:<hex>` of the canonical encoding. */
export async function canonicalDigest(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error('Invalid base64 string.');
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Deep structural equality on JSON values, key order ignored. */
export function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}
