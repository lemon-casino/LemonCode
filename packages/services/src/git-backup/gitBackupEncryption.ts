import {
  randomBytes,
  createCipheriv,
  publicEncrypt,
  generateKeyPair,
  createPrivateKey,
  createPublicKey,
  constants,
} from "node:crypto";
import { readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withFileLock, atomicWritePrivateTextFile } from "@lcode/shared/node";

const generateKeyPairAsync = promisify(generateKeyPair);
const KEY_DIR_NAME = "git-backup-keys";

export interface EncryptionKeyPair {
  publicKey: string;
  privateKey: string;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function ensureKeyPair(dataDir: string): Promise<EncryptionKeyPair> {
  const keyDir = join(dataDir, KEY_DIR_NAME);
  const pubPath = join(keyDir, "backup.pub");
  const privPath = join(keyDir, "backup.pem");
  // 多窗口并发首次生成曾覆盖彼此私钥；目录锁覆盖读取、校验和整对持久化。
  return withFileLock(join(keyDir, "key-pair"), async () => {
    const [existingPublic, existingPrivate] = await Promise.all([
      readOptional(pubPath),
      readOptional(privPath),
    ]);
    if (existingPublic !== null || existingPrivate !== null) {
      if (!existingPublic || !existingPrivate)
        throw new Error("Backup key pair is incomplete; refusing to replace surviving keys");
      try {
        const derived = createPublicKey(createPrivateKey(existingPrivate)).export({
          type: "spki",
          format: "pem",
        });
        const supplied = createPublicKey(existingPublic).export({ type: "spki", format: "pem" });
        if (derived !== supplied) throw new Error("Key pair mismatch");
      } catch {
        throw new Error("Backup key pair is corrupt; refusing to replace keys");
      }
      await chmod(privPath, 0o600);
      return { publicKey: existingPublic, privateKey: existingPrivate };
    }
    const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    // 先保存私钥；崩溃留下残缺时明确失败，不自动重生成导致旧备份无法恢复。
    await atomicWritePrivateTextFile(privPath, privateKey);
    await atomicWritePrivateTextFile(pubPath, publicKey);
    return { publicKey, privateKey };
  });
}

export interface EncryptedPayload {
  encryptedData: Buffer;
  encryptedKey: Buffer;
  iv: Buffer;
}

export function encryptBuffer(data: Buffer, publicKeyPem: string): EncryptedPayload {
  const symmetricKey = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-ctr", symmetricKey, iv);
  const encryptedData = Buffer.concat([cipher.update(data), cipher.final()]);
  const encryptedKey = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    symmetricKey,
  );
  return { encryptedData, encryptedKey, iv };
}

export async function readPublicKey(dataDir: string): Promise<string> {
  return (await ensureKeyPair(dataDir)).publicKey;
}

export async function readPrivateKey(dataDir: string): Promise<string> {
  return (await ensureKeyPair(dataDir)).privateKey;
}
