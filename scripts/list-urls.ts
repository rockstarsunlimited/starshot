#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = process.env["STARSHOT_LIST_COMMAND"] || "list";
const validCommands = ["list", "last", "copy"] as const;
const validFormats = ["table", "json", "url"] as const;

interface ListItem {
  key: string;
  url: string;
  timestamp: string;
}

interface ListResponse {
  items?: ListItem[];
}

function isOneOf<T extends readonly string[]>(value: string, choices: T): value is T[number] {
  return choices.some((choice) => choice === value);
}

function isListItem(value: unknown): value is ListItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["key"] === "string"
    && typeof item["url"] === "string"
    && typeof item["timestamp"] === "string";
}

function parseListResponse(value: unknown): ListResponse {
  if (!value || typeof value !== "object") {
    throw new Error("List response was not an object");
  }
  const response = value as Record<string, unknown>;
  const items = response["items"];
  if (items === undefined) return {};
  if (!Array.isArray(items) || !items.every(isListItem)) {
    throw new Error("List response had an invalid items array");
  }
  return { items };
}

function argValue(name: string, fallback: string): string;
function argValue(name: string, fallback: undefined): string | undefined;
function argValue(name: string, fallback: string | undefined): string | undefined {
  const prefix = `${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(name);
  const next = index >= 0 ? args[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

function sinceValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+)([hd])$/);
  if (!match) return value.includes("T") ? value.replace("T", " ") : value;

  const amount = Number(match[1] ?? "0");
  const unit = match[2] ?? "h";
  const date = new Date(Date.now() - amount * (unit === "h" ? 3_600_000 : 86_400_000));
  const pad = (number: number, width = 2): string => String(number).padStart(width, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

function formatItems(items: ListItem[], format: string): string {
  if (format === "url") return items.map((item) => item.url).join("\n");
  if (format === "json") return JSON.stringify({ items });
  if (format === "table") return items.map((item) => `${item.timestamp}\t${item.url}`).join("\n");
  throw new Error(`Unknown format: ${format}. Use table, json, or url.`);
}

async function main(): Promise<void> {
  if (!isOneOf(command, validCommands)) {
    throw new Error(`Unknown command: ${command}. Use list, last, or copy.`);
  }

  const token = process.env["AUTH_TOKEN"] || process.env["STARSHOT_AUTH_TOKEN"];
  const uploadUrl = process.env["STARSHOT_UPLOAD_URL"];
  if (!token) throw new Error("AUTH_TOKEN or STARSHOT_AUTH_TOKEN is required");
  if (!uploadUrl) throw new Error("STARSHOT_UPLOAD_URL is required");

  const apiUrl = new URL("/api/list", uploadUrl);
  apiUrl.searchParams.set("scope", argValue("--scope", "humans"));
  apiUrl.searchParams.set("limit", command === "last" ? "1" : argValue("--limit", "100"));
  const sinceRaw = command === "last"
    ? argValue("--since", undefined)
    : argValue("--since", "1d");
  const since = sinceValue(sinceRaw);
  if (since) apiUrl.searchParams.set("since", since);
  const defaultFormat = command === "copy" || command === "last" ? "url" : "table";
  const format = argValue("--format", defaultFormat);
  if (!isOneOf(format, validFormats)) {
    throw new Error(`Unknown format: ${format}. Use table, json, or url.`);
  }

  const response = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`List failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const body = parseListResponse(await response.json());
  const output = formatItems(body.items ?? [], format);

  if (command === "copy") {
    const copy = spawnSync("pbcopy", { input: output });
    if (copy.status !== 0) {
      console.error("Warning: pbcopy failed, printing to stdout instead.");
      console.log(output);
    }
  } else {
    console.log(output);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
