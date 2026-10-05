import { readFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey, type KeyObject } from 'jose';
import type { JsonValue } from '../ir/types.js';
import type { AuthConfig } from './config.js';

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export type SessionClaims = Record<string, JsonValue>;
export type SessionResolver = (headers: IncomingHttpHeaders) => Promise<SessionClaims>;

function pick(source: unknown, path: string): JsonValue | undefined {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as JsonValue | undefined;
}

/**
 * Verifies the caller and extracts session claims. Every gateway call is
 * re-authenticated: nothing a device stores is trusted as identity.
 */
export async function sessionResolver(config: AuthConfig, fetchImpl: typeof fetch = fetch): Promise<SessionResolver> {
  if (config.mode === 'jwt') {
    let key: JWTVerifyGetKey | KeyObject | CryptoKey;
    if (config.jwksUrl !== undefined) key = createRemoteJWKSet(new URL(config.jwksUrl));
    else if (config.publicKeyFile !== undefined) {
      const pem = await readFile(config.publicKeyFile, 'utf8');
      key = await importSPKI(pem, /BEGIN PUBLIC KEY/.test(pem) ? 'RS256' : 'EdDSA');
    } else throw new Error('jwt auth needs jwksUrl or publicKeyFile.');
    return async (headers) => {
      const header = headers.authorization;
      const token = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : undefined;
      if (token === undefined) throw new AuthenticationError('Missing bearer token.');
      try {
        const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
          ...(config.issuer === undefined ? {} : { issuer: config.issuer }),
          ...(config.audience === undefined ? {} : { audience: config.audience }),
        });
        const claims: SessionClaims = {};
        for (const [name, source] of Object.entries(config.claims)) {
          const value = pick(payload, source);
          if (value !== undefined) claims[name] = value;
        }
        return claims;
      } catch (error) {
        throw new AuthenticationError(`Invalid token: ${(error as Error).message}`);
      }
    };
  }
  if (config.mode === 'introspection') {
    return async (headers) => {
      const forwarded: Record<string, string> = { accept: 'application/json' };
      for (const name of config.forwardHeaders) {
        const value = headers[name.toLowerCase()];
        if (typeof value === 'string') forwarded[name] = value;
      }
      const response = await fetchImpl(config.url, { headers: forwarded });
      if (response.status === 401 || response.status === 403) throw new AuthenticationError(`Introspection refused the session (${response.status}).`);
      if (!response.ok) throw new Error(`Introspection failed with ${response.status}.`);
      const body = await response.json() as unknown;
      const claims: SessionClaims = {};
      for (const [name, path] of Object.entries(config.claims)) {
        const value = pick(body, path);
        if (value !== undefined) claims[name] = value;
      }
      return claims;
    };
  }
  return async (headers) => {
    const claims: SessionClaims = {};
    for (const [name, header] of Object.entries(config.claims)) {
      const value = headers[header.toLowerCase()];
      if (typeof value === 'string' && value.length > 0) claims[name] = value;
    }
    if (Object.keys(claims).length === 0) throw new AuthenticationError('No session headers.');
    return claims;
  };
}
