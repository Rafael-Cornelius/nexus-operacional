import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptBackupEnvelope,
  encryptBackupPayload,
  isEncryptedBackupEnvelope,
  parseBackupEncryptionKey
} from "../../apps/api/src/modules/backups/backup-encryption";

describe("backup encryption", () => {
  it("encrypts with AES-256-GCM without exposing snapshot plaintext", () => {
    const key = randomBytes(32);
    const plaintext = JSON.stringify({ format: "nexus-json-snapshot-v1", tables: { users: [{ email: "private@example.com" }] } });
    const envelope = encryptBackupPayload(plaintext, key, "key-2026-07");

    expect(envelope).toMatchObject({ format: "nexus-encrypted-backup-v1", algorithm: "aes-256-gcm", keyId: "key-2026-07" });
    expect(JSON.stringify(envelope)).not.toContain("private@example.com");
    expect(isEncryptedBackupEnvelope(envelope)).toBe(true);
    expect(decryptBackupEnvelope(envelope, key)).toBe(plaintext);
  });

  it("rejects wrong keys and authenticated-ciphertext tampering", () => {
    const key = randomBytes(32);
    const envelope = encryptBackupPayload("sensitive", key);
    expect(() => decryptBackupEnvelope(envelope, randomBytes(32))).toThrow("autenticado");
    expect(() => decryptBackupEnvelope({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }, key)).toThrow("autenticado");
  });

  it("accepts only exact 32-byte base64 or hexadecimal keys", () => {
    const key = randomBytes(32);
    expect(parseBackupEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(parseBackupEncryptionKey(key.toString("hex"))).toEqual(key);
    expect(() => parseBackupEncryptionKey("short")).toThrow("32 bytes");
    expect(() => parseBackupEncryptionKey(undefined)).toThrow("nao configurada");
  });
});
