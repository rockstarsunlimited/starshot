#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";

const stateDir =
  process.env["STARSHOT_STATE_DIR"] || `${process.env["HOME"]}/Library/Application Support/Starshot`;
const queueDir = join(stateDir, "queue");
const inflightDir = join(queueDir, "inflight");
const failedDir = join(queueDir, "failed");
const blobDir = join(stateDir, "blobs");
const command = process.env["STARSHOT_SYNC_COMMAND"] || "sync";
const maxAttempts = Number(process.env["STARSHOT_SYNC_MAX_ATTEMPTS"] || "5");
const validCommands = ["sync", "status"] as const;
const validScopes = ["humans", "agents"] as const;
const validContentTypes = ["image/png", "image/jpeg", "image/heic", "image/heif"] as const;

if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
  throw new Error("STARSHOT_SYNC_MAX_ATTEMPTS must be an integer >= 1");
}

interface QueueItem {
  file: string;
  content_type: string;
  scope?: string;
  attempts?: number;
  last_error?: string;
  last_attempt_at?: string;
}

interface UploadResult {
  url: string;
}

function isOneOf<T extends readonly string[]>(value: string, choices: T): value is T[number] {
  return choices.some((choice) => choice === value);
}

function ensureQueueDirs(): void {
  mkdirSync(queueDir, { recursive: true });
  mkdirSync(inflightDir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });
}

function queueFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(dir, file))
    .sort();
}

function validateQueueItem(value: unknown): QueueItem {
  if (!value || typeof value !== "object") {
    throw new Error("Queue item must be an object");
  }

  const item = value as Partial<QueueItem>;
  if (typeof item.file !== "string" || !item.file) {
    throw new Error("Queue item file is required");
  }
  if (typeof item.content_type !== "string" || !isOneOf(item.content_type, validContentTypes)) {
    throw new Error("Queue item content_type is invalid");
  }
  if (item.scope !== undefined && !isOneOf(item.scope, validScopes)) {
    throw new Error("Queue item scope is invalid");
  }
  if (item.attempts !== undefined && (!Number.isInteger(item.attempts) || item.attempts < 0)) {
    throw new Error("Queue item attempts is invalid");
  }

  const stats = lstatSync(item.file);
  if (!stats.isFile()) {
    throw new Error(`Queued file is not a regular file: ${item.file}`);
  }

  return {
    file: item.file,
    content_type: item.content_type,
    ...(item.scope ? { scope: item.scope } : {}),
    ...(item.attempts !== undefined ? { attempts: item.attempts } : {}),
    ...(item.last_error ? { last_error: item.last_error } : {}),
    ...(item.last_attempt_at ? { last_attempt_at: item.last_attempt_at } : {}),
  };
}

function parseQueueItem(file: string): QueueItem {
  return validateQueueItem(JSON.parse(readFileSync(file, "utf8")));
}

function writeQueueItem(file: string, item: QueueItem): void {
  writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`);
}

function claimQueuedFile(file: string): string | undefined {
  const target = join(inflightDir, basename(file));
  try {
    renameSync(file, target);
    return target;
  } catch (error: unknown) {
    console.error(`${file}: failed to claim queue item: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function quarantine(file: string, reason: string, item?: QueueItem): void {
  const target = join(failedDir, basename(file));
  if (item) {
    writeQueueItem(file, {
      ...item,
      last_error: reason,
      last_attempt_at: new Date().toISOString(),
    });
  }
  renameSync(file, target);
}

function retryOrQuarantine(file: string, item: QueueItem, reason: string): void {
  const attempts = (item.attempts ?? 0) + 1;
  const nextItem = {
    ...item,
    attempts,
    last_error: reason.slice(0, 500),
    last_attempt_at: new Date().toISOString(),
  };

  writeQueueItem(file, nextItem);
  if (attempts >= maxAttempts) {
    renameSync(file, join(failedDir, basename(file)));
  } else {
    renameSync(file, join(queueDir, basename(file)));
  }
}

function removeBlobIfSafe(file: string): void {
  if (!existsSync(file) || !existsSync(blobDir)) return;

  const realBlobDir = realpathSync(blobDir);
  const realFile = realpathSync(file);
  if (realFile !== realBlobDir && !realFile.startsWith(`${realBlobDir}${sep}`)) {
    return;
  }

  if (statSync(realFile).isFile()) {
    rmSync(realFile, { force: true });
  }
}

async function upload(item: QueueItem): Promise<UploadResult> {
  const token = process.env["STARSHOT_AUTH_TOKEN"] || process.env["AUTH_TOKEN"];
  const uploadUrl = process.env["STARSHOT_UPLOAD_URL"];
  if (!uploadUrl) throw new Error("STARSHOT_UPLOAD_URL is required");
  if (!token) throw new Error("AUTH_TOKEN or STARSHOT_AUTH_TOKEN is required");

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": item.content_type,
      "X-Starshot-Scope": item.scope || "humans",
    },
    body: Bun.file(item.file),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const body = await response.json() as Partial<UploadResult>;
  if (typeof body.url !== "string" || !body.url) {
    throw new Error("Upload failed: response did not include a URL");
  }
  return { url: body.url };
}

async function main(): Promise<void> {
  if (!isOneOf(command, validCommands)) {
    throw new Error(`Unknown command: ${command}. Use sync or status.`);
  }

  if (!existsSync(queueDir)) {
    console.log(command === "status" ? "Queued uploads: 0" : "No queued uploads.");
    return;
  }

  ensureQueueDirs();
  const files = queueFiles(queueDir);
  const inflightFiles = queueFiles(inflightDir);
  const failedFiles = queueFiles(failedDir);

  if (files.length === 0) {
    console.log(command === "status"
      ? `Queued uploads: 0, inflight: ${inflightFiles.length}, failed: ${failedFiles.length}`
      : "No queued uploads.");
    return;
  }

  if (command === "status") {
    console.log(`Queued uploads: ${files.length}, inflight: ${inflightFiles.length}, failed: ${failedFiles.length}`);
    return;
  }

  let uploaded = 0;
  for (const file of files) {
    const claimedFile = claimQueuedFile(file);
    if (!claimedFile) continue;
    let item: QueueItem | undefined;
    try {
      item = parseQueueItem(claimedFile);
      const result = await upload(item);
      rmSync(claimedFile, { force: true });
      removeBlobIfSafe(item.file);
      uploaded += 1;
      console.log(result.url);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (item) {
          retryOrQuarantine(claimedFile, item, message);
        } else {
          quarantine(claimedFile, message);
        }
      } catch (queueError: unknown) {
        console.error(`${claimedFile}: failed to update queue state: ${queueError instanceof Error ? queueError.message : String(queueError)}`);
      }
      console.error(`${claimedFile}: ${message}`);
    }
  }

  console.log(`Synced ${uploaded}/${files.length} queued upload${files.length === 1 ? "" : "s"}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
