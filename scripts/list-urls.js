#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = process.env.STARSHOT_LIST_COMMAND || "list";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function hasArg(name) {
  return args.includes(name);
}

function sinceValue(value) {
  if (!value) return undefined;
  const match = value.match(/^(\d+)([hd])$/);
  if (!match) return value.includes("T") ? value.replace("T", " ") : value;

  const amount = Number(match[1]);
  const unit = match[2];
  const date = new Date(Date.now() - amount * (unit === "h" ? 3_600_000 : 86_400_000));
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatItems(items, format) {
  if (format === "url") return items.map((item) => item.url).join("\n");
  if (format === "json") return JSON.stringify({ items });
  return items.map((item) => `${item.timestamp}\t${item.url}`).join("\n");
}

async function main() {
  const token = process.env.AUTH_TOKEN || process.env.STARSHOT_AUTH_TOKEN;
  const uploadUrl = process.env.STARSHOT_UPLOAD_URL;
  if (!token) throw new Error("AUTH_TOKEN or STARSHOT_AUTH_TOKEN is required");
  if (!uploadUrl) throw new Error("STARSHOT_UPLOAD_URL is required");

  const apiUrl = new URL("/api/list", uploadUrl);
  apiUrl.searchParams.set("scope", argValue("--scope", "humans"));
  apiUrl.searchParams.set("limit", command === "last" ? "1" : argValue("--limit", "100"));
  const since = sinceValue(argValue("--since", command === "last" ? undefined : "1d"));
  if (since) apiUrl.searchParams.set("since", since);

  const response = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`List failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const defaultFormat = command === "copy" || command === "last" ? "url" : "table";
  const format = argValue("--format", defaultFormat);
  const output = formatItems(body.items ?? [], format);

  if (command === "copy") {
    const copy = spawnSync("pbcopy", { input: output });
    if (copy.status !== 0) throw new Error("pbcopy failed");
  } else {
    console.log(output);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
