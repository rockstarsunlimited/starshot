#!/usr/bin/env bun
import { accessSync, constants, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const valueFlags = ["--mode", "--max-width", "--quality", "--format", "--output-dir"] as const;
const validModes = ["latest", "file"] as const;
const validFormats = ["path", "url", "env", "json"] as const;
const imageExtensions = [".png", ".jpg", ".jpeg", ".heic", ".heif"] as const;

type OutputFormat = "path" | "url" | "env" | "json";
type Mode = "latest" | "file";

interface UploadResponse {
  url: string;
}

interface AgentResult {
  previewPath: string;
  path: string;
  url?: string;
  width: string;
  height: string;
  previewMime: "image/jpeg";
  mime: "image/jpeg";
  source: string;
}

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(name);
  const next = index >= 0 ? args[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

function hasArg(name: string): boolean {
  return args.includes(name);
}

function positionalFile(): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && valueFlags.some((flag) => flag === arg)) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function validateChoice<T extends readonly string[]>(name: string, value: string, choices: T): T[number] {
  if (choices.some((choice) => choice === value)) return value;
  throw new Error(`${name} must be ${choices.join(", ")}`);
}

function validateInteger(name: string, value: string, min: number, max?: number): string {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || (max !== undefined && numberValue > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new Error(`${name} must be an integer ${range}`);
  }
  return value;
}

function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed`);
  }
  return result.stdout;
}

function latestImage(dir: string): string {
  let latest: { file: string; mtimeMs: number } | undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !imageExtensions.some((extension) => extension === extname(entry.name).toLowerCase())) continue;
    const file = join(dir, entry.name);
    const stats = statSync(file);
    if (!latest || stats.mtimeMs > latest.mtimeMs) {
      latest = { file, mtimeMs: stats.mtimeMs };
    }
  }

  if (!latest) throw new Error(`No screenshot image found in ${dir}`);
  return latest.file;
}

function imageInfo(file: string): { width: string; height: string } {
  const output = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = output.match(/pixelWidth:\s*(\d+)/)?.[1] ?? "";
  const height = output.match(/pixelHeight:\s*(\d+)/)?.[1] ?? "";
  if (!width || !height) {
    throw new Error(`Failed to read image dimensions for ${file}`);
  }
  return { width, height };
}

function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      throw new Error(`Unsupported image type: ${file}`);
  }
}

async function upload(file: string): Promise<string> {
  const token = process.env["STARSHOT_AUTH_TOKEN"] || process.env["AUTH_TOKEN"];
  const uploadUrl = process.env["STARSHOT_UPLOAD_URL"];
  if (!uploadUrl) throw new Error("STARSHOT_UPLOAD_URL is required");
  if (!token) throw new Error("AUTH_TOKEN or STARSHOT_AUTH_TOKEN is required");

  if (process.env["STARSHOT_UPLOAD_DRY_RUN"] === "1") {
    return `dry-run://${file}`;
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType(file),
      "X-Starshot-Scope": "agents",
    },
    body: Bun.file(file),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const body = await response.json() as Partial<UploadResponse>;
  if (typeof body.url !== "string" || !body.url) {
    throw new Error("Upload failed: response did not include a URL");
  }
  return body.url;
}

function printResult(format: OutputFormat, result: AgentResult): void {
  switch (format) {
    case "path":
      console.log(result.previewPath);
      break;
    case "url":
      console.log(result.url ?? "");
      break;
    case "env":
      console.log(`STARSHOT_AGENT_PREVIEW=${result.previewPath}`);
      if (result.url) console.log(`STARSHOT_AGENT_URL=${result.url}`);
      console.log(`STARSHOT_AGENT_WIDTH=${result.width}`);
      console.log(`STARSHOT_AGENT_HEIGHT=${result.height}`);
      console.log(`STARSHOT_AGENT_MIME=${result.previewMime}`);
      break;
    case "json":
      console.log(JSON.stringify(result));
      break;
    default:
      throw new Error("--format must be path, url, env, or json");
  }
}

async function main(): Promise<void> {
  const mode = validateChoice("mode", argValue("--mode", "latest"), validModes) as Mode;
  const screenshotDir = process.env["SCREENSHOT_DIR"] || `${process.env["HOME"]}/Pictures/Starshot Screenshots`;
  const source = mode === "file" ? positionalFile() : latestImage(screenshotDir);
  if (!source) throw new Error("Missing image file");

  const file = resolve(source);
  const maxWidth = validateInteger(
    "max width",
    argValue("--max-width", process.env["STARSHOT_AGENT_MAX_WIDTH"] || "1280"),
    1,
  );
  const quality = validateInteger(
    "quality",
    argValue("--quality", process.env["STARSHOT_AGENT_QUALITY"] || "60"),
    1,
    100,
  );
  const format = validateChoice("format", argValue("--format", "path"), validFormats) as OutputFormat;
  const outputDir = argValue(
    "--output-dir",
    process.env["STARSHOT_AGENT_DIR"] || join(dirname(file), ".starshot-agent"),
  );
  mkdirSync(outputDir, { recursive: true });
  accessSync(outputDir, constants.W_OK);

  const stem = basename(file, extname(file));
  const preview = join(outputDir, `${stem}.agent.jpg`);
  run("sips", ["-Z", maxWidth, "-s", "format", "jpeg", "-s", "formatOptions", quality, file, "--out", preview]);
  // Extended attribute cleanup is best-effort; upload still works if xattr is unavailable.
  spawnSync("xattr", ["-c", preview], { stdio: "ignore" });

  const info = imageInfo(preview);
  // Requesting URL output implies an upload because there is no URL without one.
  const url = hasArg("--upload") || format === "url" ? await upload(preview) : undefined;
  const result: AgentResult = {
    previewPath: preview,
    path: preview,
    width: info.width,
    height: info.height,
    previewMime: "image/jpeg",
    mime: "image/jpeg",
    source: file,
  };
  if (url) result.url = url;

  printResult(format, result);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
