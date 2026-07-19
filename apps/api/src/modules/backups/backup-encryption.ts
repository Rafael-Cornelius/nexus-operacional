import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

const algorithm = "aes-256-gcm";
const associatedData = Buffer.from("nexus-encrypted-backup-v1", "utf8");

export interface EncryptedBackupEnvelope {
  format: "nexus-encrypted-backup-v1";
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function parseBackupEncryptionKey(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) throw new BadRequestException("BACKUP_ENCRYPTION_KEY nao configurada.");
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new BadRequestException("BACKUP_ENCRYPTION_KEY deve possuir exatamente 32 bytes em base64 ou 64 caracteres hexadecimais.");
  return key;
}

export function encryptBackupPayload(payload: string, key: Buffer, keyId = "primary"): EncryptedBackupEnvelope {
  if (key.length !== 32) throw new BadRequestException("Chave de backup deve possuir 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return {
    format: "nexus-encrypted-backup-v1",
    algorithm,
    keyId: keyId.trim() || "primary",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function isEncryptedBackupEnvelope(value: unknown): value is EncryptedBackupEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.format === "nexus-encrypted-backup-v1" && record.algorithm === algorithm;
}

export function decryptBackupEnvelope(envelope: EncryptedBackupEnvelope, key: Buffer) {
  if (key.length !== 32) throw new BadRequestException("Chave de backup deve possuir 32 bytes.");
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.authTag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (iv.length !== 12 || authTag.length !== 16 || !ciphertext.length) throw new Error("invalid envelope");
    const decipher = createDecipheriv(algorithm, key, iv);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new BadRequestException("Backup criptografado nao pode ser autenticado ou descriptografado.");
  }
}
