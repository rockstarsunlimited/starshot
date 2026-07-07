#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const stateDir =
  process.env.STARSHOT_STATE_DIR || `${process.env.HOME}/Library/Application Support/Starshot`;
const queueDir = join(stateDir, "queue");
const command = process.env.STARSHOT_SYNC_COMMAND || "sync";

interface QueueItem {
  file: string;
  content_type: string;
  scope?: string;
}

interface UploadResult {
  url: string;
}

async function upload(item: QueueItem): Promise<UploadResult> {
  const token = process.env.STARSHOT_AUTH_TOKEN || process.env.AUTH_TOKEN;
  if (!process.env.STARSHOT_UPLOAD_URL) throw new Error("STARSHOT_UPLOAD_URL is required");
  if (!token) throw new Error("AUTH_TOKEN or STARSHOT_AUTH_TOKEN is required");
  if (!existsSync(item.file)) throw new Error(`Queued file missing: ${item.file}`);

  const response = await fetch(process.env.STARSHOT_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": item.content_type,
      "X-Starshot-Scope": item.scope || "humans",
    },
    body: readFileSync(item.file),
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as UploadResult;
}

async function main(): Promise<void> {
  if (!existsSync(queueDir)) {
    console.log(command === "status" ? "Queued uploads: 0" : "No queued uploads.");
    return;
  }

  const files = readdirSync(queueDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(queueDir, file))
    .sort();

  if (files.length === 0) {
    console.log(command === "status" ? "Queued uploads: 0" : "No queued uploads.");
    return;
  }

  if (command === "status") {
    console.log(`Queued uploads: ${files.length}`);
    return;
  }

  let uploaded = 0;
  for (const file of files) {
    try {
      const item = JSON.parse(readFileSync(file, "utf8")) as QueueItem;
      const result = await upload(item);
      rmSync(file);
      if (item.file?.includes("/Starshot/blobs/")) {
        rmSync(item.file, { force: true });
      }
      uploaded += 1;
      console.log(result.url);
    } catch (error: unknown) {
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.error(`Synced ${uploaded}/${files.length} queued upload${files.length === 1 ? "" : "s"}.`);
}

await main();
