import { base64ToBytes, bytesToBase64, canonicalDigest, canonicalJson, utf8 } from './canonical.js';
import {
  AERIS_SIGNED_FORMAT,
  type AerisArtifact,
  type AerisSignedArtifact,
} from './types.js';
import { validateArtifact } from './validate.js';

/**
 * Ed25519 signing and verification through WebCrypto, identical in Node 20+
 * and in browsers. The signature covers a small header that pins the digest
 * of the canonical artifact, so verification does not depend on how the JSON
 * was formatted in transit.
 */

export class AerisSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AerisSignatureError';
  }
}

type Header = Omit<AerisSignedArtifact, 'artifact' | 'signature'>;

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.subtle === undefined) throw new AerisSignatureError('WebCrypto is not available.');
  return crypto.subtle;
}

function headerBytes(header: Header): Uint8Array {
  return utf8(canonicalJson({
    format: header.format,
    formatVersion: header.formatVersion,
    algorithm: header.algorithm,
    keyId: header.keyId,
    digest: header.digest,
  }));
}

/** Imports an Ed25519 private key from PKCS#8 PEM. */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', pemBody(pem, 'PRIVATE KEY') as BufferSource, { name: 'Ed25519' }, false, ['sign']);
}

/** Imports an Ed25519 public key from SPKI PEM, or from a base64 raw 32-byte key. */
export async function importPublicKey(key: string): Promise<CryptoKey> {
  if (key.includes('BEGIN PUBLIC KEY')) {
    return subtle().importKey('spki', pemBody(key, 'PUBLIC KEY') as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  }
  const raw = base64ToBytes(key.trim());
  if (raw.length !== 32) throw new AerisSignatureError('A raw Ed25519 public key must be 32 bytes.');
  return subtle().importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
}

function pemBody(pem: string, label: string): Uint8Array {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  if (match === null) throw new AerisSignatureError(`Expected a PEM block of type ${label}.`);
  return base64ToBytes(match[1]!.replace(/\s+/g, ''));
}

export async function signArtifact(artifact: AerisArtifact, privateKey: CryptoKey, keyId: string): Promise<AerisSignedArtifact> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) throw new AerisSignatureError('Invalid key id.');
  validateArtifact(artifact);
  const header: Header = {
    format: AERIS_SIGNED_FORMAT,
    formatVersion: '1.0.0',
    algorithm: 'Ed25519',
    keyId,
    digest: await canonicalDigest(artifact),
  };
  const signature = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, headerBytes(header) as BufferSource));
  return { ...header, artifact, signature: bytesToBase64(signature) };
}

/**
 * Verifies an envelope against a set of trusted keys (keyId -> key). The
 * keys must come from a trusted channel (bundled with the application), never
 * from the envelope or the server that delivers it.
 */
export async function verifyArtifact(
  envelope: unknown,
  trustedKeys: ReadonlyMap<string, CryptoKey>,
): Promise<AerisArtifact> {
  if (envelope === null || typeof envelope !== 'object') throw new AerisSignatureError('Envelope is not an object.');
  const candidate = envelope as Partial<AerisSignedArtifact>;
  const keys = Object.keys(envelope).sort().join(',');
  if (keys !== 'algorithm,artifact,digest,format,formatVersion,keyId,signature') {
    throw new AerisSignatureError('Envelope has unexpected fields.');
  }
  if (candidate.format !== AERIS_SIGNED_FORMAT || candidate.formatVersion !== '1.0.0' || candidate.algorithm !== 'Ed25519') {
    throw new AerisSignatureError('Unsupported envelope format.');
  }
  if (typeof candidate.keyId !== 'string' || typeof candidate.digest !== 'string' || typeof candidate.signature !== 'string') {
    throw new AerisSignatureError('Envelope header is malformed.');
  }
  const key = trustedKeys.get(candidate.keyId);
  if (key === undefined) throw new AerisSignatureError(`Key ${candidate.keyId} is not trusted.`);
  const signature = base64ToBytes(candidate.signature);
  if (signature.length !== 64) throw new AerisSignatureError('Ed25519 signatures are 64 bytes.');
  const header = candidate as Header;
  const valid = await subtle().verify({ name: 'Ed25519' }, key, signature as BufferSource, headerBytes(header) as BufferSource);
  if (!valid) throw new AerisSignatureError('Signature does not verify.');
  if (await canonicalDigest(candidate.artifact) !== candidate.digest) {
    throw new AerisSignatureError('Artifact digest does not match the signed header.');
  }
  validateArtifact(candidate.artifact);
  return candidate.artifact;
}
