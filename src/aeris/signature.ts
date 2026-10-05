import { sign, verify, type KeyLike } from 'node:crypto';
import type { AERISArtifact, AERISSignedArtifact } from './types.js';
import { AERIS_IR_VERSION } from './types.js';

export function signAERISArtifact(
  artifact: AERISArtifact,
  privateKey: KeyLike,
  keyId: string,
): AERISSignedArtifact {
  if (!keyId.trim()) throw new Error('AERIS signing key id must not be empty.');
  const signature = sign(null, serializeSignedContent(keyId, artifact), privateKey);
  return {
    format: 'aeris-signed-ir',
    formatVersion: '1.0.0',
    algorithm: 'Ed25519',
    keyId,
    artifact,
    signature: signature.toString('base64'),
  };
}

export function verifyAERISArtifact(
  envelope: unknown,
  publicKey: KeyLike,
): envelope is AERISSignedArtifact {
  if (!isSignedArtifact(envelope)) return false;
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) return false;
  try {
    return verify(null, serializeSignedContent(envelope.keyId, envelope.artifact), publicKey, signature);
  } catch {
    return false;
  }
}

function isSignedArtifact(value: unknown): value is AERISSignedArtifact {
  if (value === null || typeof value !== 'object') return false;
  const envelope = value as Partial<AERISSignedArtifact>;
  const keys = Object.keys(value).sort();
  return envelope.format === 'aeris-signed-ir' && envelope.formatVersion === '1.0.0' &&
    envelope.algorithm === 'Ed25519' && typeof envelope.keyId === 'string' && envelope.keyId.trim().length > 0 &&
    typeof envelope.signature === 'string' && envelope.artifact !== undefined &&
    typeof envelope.artifact === 'object' && envelope.artifact.format === 'aeris-ir' &&
    envelope.artifact.formatVersion === AERIS_IR_VERSION &&
    keys.join(',') === 'algorithm,artifact,format,formatVersion,keyId,signature';
}

function serializeSignedContent(keyId: string, artifact: AERISArtifact): Buffer {
  return Buffer.from(JSON.stringify({
    format: 'aeris-signed-ir',
    formatVersion: '1.0.0',
    algorithm: 'Ed25519',
    keyId,
    artifact,
  }), 'utf8');
}
