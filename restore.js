import { createDecipheriv } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const [, , sourceArgument, confirmation] = process.argv;
if (!sourceArgument || confirmation !== "--confirm-replace") {
  console.error("Usage: node restore.js <backup.sqlite.enc> --confirm-replace");
  console.error("Stop Inventory Hub before restoring. The current database is retained as a .before-restore copy.");
  process.exit(1);
}

const source = resolve(sourceArgument);
const destination = resolve(process.env.INVENTORY_DB_PATH || "data/inventory-hub.db");
const temporary = `${destination}.restore.tmp`;
const safetyCopy = `${destination}.before-restore`;
const encodedKey = process.env.BACKUP_ENCRYPTION_KEY;
const key = Buffer.from(encodedKey || "", "base64");
if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be the same 32-byte base64 key used for the backup.");

const info = await stat(source);
if (info.size < 37) throw new Error("Backup file is too small to be valid.");
const header = await readFile(source);
if (header.subarray(0, 9).toString() !== "IHBACKUP1") throw new Error("This is not an Inventory Hub encrypted backup.");
const iv = header.subarray(9, 21);
const authTag = header.subarray(-16);
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(authTag);
await pipeline(createReadStream(source, { start: 21, end: info.size - 17 }), decipher, createWriteStream(temporary, { flags: "w" }));
const sqliteHeader = await readFile(temporary);
if (sqliteHeader.subarray(0, 16).toString() !== "SQLite format 3\0") {
  await unlink(temporary);
  throw new Error("Decrypted content is not a valid SQLite database.");
}
try { await copyFile(destination, safetyCopy); } catch (error) { if (error.code !== "ENOENT") throw error; }
await rename(temporary, destination);
console.log(`Database restored to ${destination}`);
console.log(`Previous database retained at ${safetyCopy}`);
