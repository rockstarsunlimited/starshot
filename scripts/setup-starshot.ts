#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = resolve(root, ".varlock/profiles/starshot.env");
const wranglerPath = resolve(root, "wrangler.toml");
const dryRun = process.env.STARSHOT_SETUP_DRY_RUN === "1";

interface RunOptions {
  input?: string;
}

interface WranglerPatch {
  bucketName: string;
  publicBaseUrl: string;
}

interface ProfileConfig {
  publicBaseUrl: string;
  uploadUrl: string;
  screenshotDir: string;
  uploadFormat: string;
  jpegQuality: string;
  cleanupDays: string;
  agentMaxWidth: string;
  agentQuality: string;
}

interface MacScreenshotDefaults {
  screenshotDir: string;
  includeShadows: boolean;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

async function prompt(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = fallback ? ` (${fallback})` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function promptBool(question: string, fallback: boolean): Promise<boolean> {
  const label = fallback ? "Y/n" : "y/N";
  const answer = (await prompt(`${question} [${label}]`, "")).toLowerCase();
  if (!answer) return fallback;
  return ["y", "yes", "true", "1"].includes(answer);
}

function envQuote(value: string): string {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function run(command: string, args: string[], options: RunOptions = {}): { status: number | null } {
  if (dryRun) {
    console.log(`[dry-run] ${command} ${args.join(" ")}`);
    return { status: 0 };
  }

  return spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    input: options.input,
  });
}

function patchWrangler({ bucketName, publicBaseUrl }: WranglerPatch): void {
  const original = readFileSync(wranglerPath, "utf8");
  const next = original
    .replace(/^PUBLIC_BASE_URL = ".*"$/m, `PUBLIC_BASE_URL = "${publicBaseUrl}"`)
    .replace(/^bucket_name = ".*"$/m, `bucket_name = "${bucketName}"`);

  if (dryRun) {
    console.log(`[dry-run] update ${wranglerPath}`);
    return;
  }

  writeFileSync(wranglerPath, next);
}

function writeProfile({
  publicBaseUrl,
  uploadUrl,
  screenshotDir,
  uploadFormat,
  jpegQuality,
  cleanupDays,
  agentMaxWidth,
  agentQuality,
}: ProfileConfig): void {
  mkdirSync(dirname(profilePath), { recursive: true });
  const lines = [
    `PUBLIC_BASE_URL=${envQuote(publicBaseUrl)}`,
    `STARSHOT_UPLOAD_URL=${envQuote(uploadUrl)}`,
    `SCREENSHOT_DIR=${envQuote(screenshotDir)}`,
    `STARSHOT_UPLOAD_FORMAT=${envQuote(uploadFormat)}`,
    `STARSHOT_JPEG_QUALITY=${envQuote(jpegQuality)}`,
    `STARSHOT_CLEANUP_DAYS=${envQuote(cleanupDays)}`,
    `STARSHOT_AGENT_MAX_WIDTH=${envQuote(agentMaxWidth)}`,
    `STARSHOT_AGENT_QUALITY=${envQuote(agentQuality)}`,
  ];

  if (dryRun) {
    console.log(`[dry-run] write ${profilePath}`);
    return;
  }

  writeFileSync(profilePath, `${lines.join("\n")}\n`);
}

function storeTokenInKeychain(token: string): void {
  const result = run(
    "bunx",
    [
      "varlock",
      "keychain",
      "set",
      "AUTH_TOKEN",
      "--project",
      "starshot",
      "--profile",
      "starshot",
      "--write-to",
      profilePath,
      "--force",
    ],
    { input: `${token}\n` },
  );

  if (result.status !== 0) {
    console.error("Failed to store AUTH_TOKEN in macOS Keychain through Varlock.");
    process.exit(result.status ?? 1);
  }
}

function putWranglerSecret(token: string): void {
  const result = run("bunx", ["wrangler", "secret", "put", "AUTH_TOKEN"], {
    input: `${token}\n`,
  });

  if (result.status !== 0) {
    console.error("Failed to set Cloudflare Worker secret AUTH_TOKEN.");
    process.exit(result.status ?? 1);
  }
}

function applyMacScreenshotDefaults({ screenshotDir, includeShadows }: MacScreenshotDefaults): void {
  if (dryRun) {
    console.log(`[dry-run] mkdir -p ${screenshotDir}`);
  } else {
    mkdirSync(screenshotDir, { recursive: true });
  }

  const disableShadow = includeShadows ? "false" : "true";
  const commands: Array<[string, string[]]> = [
    ["defaults", ["write", "com.apple.screencapture", "location", screenshotDir]],
    ["defaults", ["write", "com.apple.screencapture", "type", "png"]],
    ["defaults", ["write", "com.apple.screencapture", "disable-shadow", "-bool", disableShadow]],
    ["killall", ["SystemUIServer"]],
  ];

  for (const [command, args] of commands) {
    run(command, args);
  }
}

async function main(): Promise<void> {
  if (!existsSync(wranglerPath)) {
    console.error("wrangler.toml not found. Run setup from the Starshot project root.");
    process.exit(1);
  }

  const bucketName =
    argValue("--bucket") ?? (await prompt("R2 bucket name", "starshot-screenshots"));
  const publicBaseUrl =
    argValue("--public-base-url") ??
    (await prompt("Public base URL", "https://your-domain.example"));
  const uploadUrl =
    argValue("--upload-url") ?? `${publicBaseUrl.replace(/\/$/, "")}/upload`;
  const screenshotDir =
    argValue("--screenshot-dir") ??
    (await prompt("Local screenshot folder", `${process.env.HOME}/Pictures/Starshot Screenshots`));
  const uploadFormat = (
    argValue("--upload-format") ?? (await prompt("Upload format: jpeg, png, or original", "jpeg"))
  ).toLowerCase();
  if (!["jpeg", "jpg", "png", "original"].includes(uploadFormat)) {
    console.error("Upload format must be jpeg, png, or original.");
    process.exit(1);
  }
  const jpegQuality = argValue("--jpeg-quality") ?? (await prompt("JPEG upload quality", "75"));
  const cleanupDays = argValue("--cleanup-days") ?? (await prompt("Cleanup local screenshots older than days", "7"));
  const agentMaxWidth = argValue("--agent-max-width") ?? (await prompt("Agent preview max width", "1280"));
  const agentQuality = argValue("--agent-quality") ?? (await prompt("Agent preview JPEG quality", "60"));
  const includeShadows = hasArg("--no-shadows")
    ? false
    : hasArg("--shadows")
      ? true
      : await promptBool("Include macOS window shadows in screenshots", true);
  const token = randomBytes(32).toString("base64url");

  patchWrangler({ bucketName, publicBaseUrl });
  writeProfile({
    publicBaseUrl,
    uploadUrl,
    screenshotDir,
    uploadFormat: uploadFormat === "jpg" ? "jpeg" : uploadFormat,
    jpegQuality,
    cleanupDays,
    agentMaxWidth,
    agentQuality,
  });
  storeTokenInKeychain(token);

  if (!hasArg("--skip-macos-defaults")) {
    applyMacScreenshotDefaults({ screenshotDir, includeShadows });
  }

  if (!hasArg("--skip-bucket")) {
    const bucketResult = run("bunx", ["wrangler", "r2", "bucket", "create", bucketName]);
    if (bucketResult.status !== 0) {
      console.warn("R2 bucket creation failed or bucket already exists; continuing.");
    }
  }

  if (!hasArg("--skip-wrangler-secret")) {
    putWranglerSecret(token);
  }

  if (hasArg("--install")) {
    const installResult = run("sh", [resolve(root, "scripts/install-launch-agent.sh")]);
    if (installResult.status !== 0) {
      process.exit(installResult.status ?? 1);
    }
  }

  console.log("Starshot setup complete.");
  console.log(`Profile: ${profilePath}`);
}

await main();
