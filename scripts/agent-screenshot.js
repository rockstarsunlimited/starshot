#!/usr/bin/env bun
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

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

function positionalFile() {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed`);
  }
  return result.stdout;
}

function latestImage(dir) {
  const script = `find "$1" -maxdepth 1 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' -o -iname '*.heif' \\) -print0 | xargs -0 ls -t 2>/dev/null | head -n 1`;
  const result = spawnSync("sh", ["-c", script, "sh", dir], { encoding: "utf8" });
  const file = result.stdout.trim();
  if (!file) throw new Error(`No screenshot image found in ${dir}`);
  return file;
}

function imageInfo(file) {
  const output = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = output.match(/pixelWidth:\s*(\d+)/)?.[1] ?? "";
  const height = output.match(/pixelHeight:\s*(\d+)/)?.[1] ?? "";
  return { width, height };
}

function contentType(file) {
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

async function upload(file) {
  const token = process.env.STARSHOT_AUTH_TOKEN || process.env.AUTH_TOKEN;
  if (!process.env.STARSHOT_UPLOAD_URL) throw new Error("STARSHOT_UPLOAD_URL is required");
  if (!token) throw new Error("AUTH_TOKEN or STARSHOT_AUTH_TOKEN is required");

  if (process.env.STARSHOT_UPLOAD_DRY_RUN === "1") {
    return `dry-run://${file}`;
  }

  const response = await fetch(process.env.STARSHOT_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType(file),
      "X-Starshot-Scope": "agents",
    },
    body: readFileSync(file),
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.url;
}

function printResult(format, result) {
  switch (format) {
    case "path":
      console.log(result.path);
      break;
    case "url":
      console.log(result.url ?? "");
      break;
    case "env":
      console.log(`STARSHOT_AGENT_PREVIEW=${result.path}`);
      if (result.url) console.log(`STARSHOT_AGENT_URL=${result.url}`);
      console.log(`STARSHOT_AGENT_WIDTH=${result.width}`);
      console.log(`STARSHOT_AGENT_HEIGHT=${result.height}`);
      console.log(`STARSHOT_AGENT_MIME=${result.mime}`);
      break;
    case "json":
      console.log(JSON.stringify(result));
      break;
    default:
      throw new Error("--format must be path, url, env, or json");
  }
}

async function main() {
  const mode = argValue("--mode", "latest");
  const screenshotDir = process.env.SCREENSHOT_DIR || `${process.env.HOME}/Desktop`;
  const source = mode === "file" ? positionalFile() : latestImage(screenshotDir);
  if (!source) throw new Error("Missing image file");

  const file = resolve(source);
  const maxWidth = argValue("--max-width", process.env.STARSHOT_AGENT_MAX_WIDTH || "1280");
  const quality = argValue("--quality", process.env.STARSHOT_AGENT_QUALITY || "60");
  const format = argValue("--format", "path");
  const outputDir = argValue(
    "--output-dir",
    process.env.STARSHOT_AGENT_DIR || join(dirname(file), ".starshot-agent"),
  );
  mkdirSync(outputDir, { recursive: true });

  const stem = basename(file, extname(file));
  const preview = join(outputDir, `${stem}.agent.jpg`);
  run("sips", ["-Z", maxWidth, "-s", "format", "jpeg", "-s", "formatOptions", quality, file, "--out", preview]);
  spawnSync("xattr", ["-c", preview], { stdio: "ignore" });

  const info = imageInfo(preview);
  const result = {
    path: preview,
    url: hasArg("--upload") || format === "url" ? await upload(preview) : undefined,
    width: info.width,
    height: info.height,
    mime: "image/jpeg",
    source: file,
  };

  printResult(format, result);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
