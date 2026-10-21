import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const version = "v1";

const encryptionKey = (): Buffer => {
  const configured = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!configured) throw new Error("META_TOKEN_ENCRYPTION_KEY no está configurada");
  const key = Buffer.from(configured, "base64url");
  if (key.length !== 32) throw new Error("META_TOKEN_ENCRYPTION_KEY debe tener 32 bytes en base64url");
  return key;
};

export const encryptSecret = (plaintext: string): string => {
  if (!plaintext) throw new Error("No se puede cifrar un secreto vacío");
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
};

export const decryptSecret = (encoded: string): string => {
  const [storedVersion, ivValue, tagValue, ciphertextValue] = encoded.split(".");
  if (storedVersion !== version || !ivValue || !tagValue || !ciphertextValue)
    throw new Error("Secreto cifrado inválido");
  const decipher = createDecipheriv(algorithm, encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
};

export const secretFingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);
