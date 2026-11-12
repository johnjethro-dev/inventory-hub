import { backup } from "node:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { db } from "./db.js";

function encryptionKey() {
  const encoded = process.env.BACKUP_ENCRYPTION_KEY;
  if (!encoded) throw new Error("BACKUP_ENCRYPTION_KEY is required (32 random bytes encoded as base64).");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export async function createEncryptedBackup() {
  const directory = resolve(process.env.BACKUP_DIR || "backups");
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const plainPath = join(directory, `.inventory-${stamp}.sqlite.tmp`);
  const encryptedPath = join(directory, `inventory-${stamp}.sqlite.enc`);
  await backup(db, plainPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const output = createWriteStream(encryptedPath, { flags: "wx" });
  output.write(Buffer.from("IHBACKUP1"));
  output.write(iv);
  await pipeline(createReadStream(plainPath), cipher, output, { end: false });
  output.write(cipher.getAuthTag());
  output.end();
  await new Promise((resolvePromise, reject) => {
    output.on("close", resolvePromise);
    output.on("error", reject);
  });
  await unlink(plainPath);
  return encryptedPath;
}

export async function pruneBackups(retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30)) {
  const directory = resolve(process.env.BACKUP_DIR || "backups");
  await mkdir(directory, { recursive: true });
  const threshold = Date.now() - retentionDays * 24 * 60 * 60_000;
  const removed = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".sqlite.enc")) continue;
    const path = join(directory, name);
    if ((await stat(path)).mtimeMs < threshold) {
      await unlink(path);
      removed.push(basename(path));
    }
  }
  return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  try {
    const path = await createEncryptedBackup();
    const removed = await pruneBackups();
    console.log(`Encrypted backup created: ${path}`);
    if (removed.length) console.log(`Pruned ${removed.length} expired backup(s).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
