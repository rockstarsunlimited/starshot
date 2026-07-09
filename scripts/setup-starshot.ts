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
const localWranglerPath = resolve(root, "wrangler.local.toml");
const dryRun = process.env["STARSHOT_SETUP_DRY_RUN"] === "1";
const rl = createInterface(input as NodeJS.ReadableStream, output as NodeJS.WritableStream);

interface RunOptions {
  input?: string;
}

interface LocalWranglerConfig {
  bucketName: string;
  publicBaseUrl: string;
  customDomain: string;
}

interface ProfileConfig {
  publicBaseUrl: string;
  uploadUrl: string;
  agentMaxWidth: string;
  agentQuality: string;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

async function promptChoice<T extends string>(
  question: string,
  fallback: T,
  choices: readonly T[],
): Promise<T> {
  const answer = (await prompt(question, fallback)).toLowerCase();
  if (choices.includes(answer as T)) {
    return answer as T;
  }

  console.error(`Choose one of: ${choices.join(", ")}.`);
  process.exit(1);
}

async function prompt(question: string, fallback: string): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || fallback;
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

function validateInteger(name: string, value: string, min: number, max?: number): string {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < min || (max !== undefined && numberValue > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    console.error(`${name} must be an integer ${range}.`);
    process.exit(1);
  }

  return value;
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

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    console.error(`Invalid Public base URL: ${value}`);
    process.exit(1);
  }
}

function wranglerValue(pattern: RegExp, fallback: string): string {
  const sourcePath = existsSync(localWranglerPath) ? localWranglerPath : wranglerPath;
  const match = readFileSync(sourcePath, "utf8").match(pattern);
  return match?.[1] ?? fallback;
}

function writeLocalWranglerConfig({ bucketName, publicBaseUrl, customDomain }: LocalWranglerConfig): void {
  const original = readFileSync(wranglerPath, "utf8");
  let next = original
    .replace(/^PUBLIC_BASE_URL = "([^"]*)"$/m, `PUBLIC_BASE_URL = "${publicBaseUrl}"`)
    .replace(/^bucket_name = "([^"]*)"$/m, `bucket_name = "${bucketName}"`);

  if (customDomain) {
    const routeBlock = `[[routes]]\npattern = "${customDomain}"\ncustom_domain = true`;
    const customDomainRoutePattern =
      /^\[\[routes\]\]\r?\npattern = "([^"]*)"\r?\ncustom_domain = true$/m;
    if (customDomainRoutePattern.test(next)) {
      next = next.replace(
        customDomainRoutePattern,
        routeBlock,
      );
    } else if (!next.includes(routeBlock)) {
      next = `${next.trimEnd()}\n\n${routeBlock}\n`;
    }
  }

  if (dryRun) {
    console.log(`[dry-run] write ${localWranglerPath}`);
    return;
  }

  mkdirSync(dirname(localWranglerPath), { recursive: true });
  writeFileSync(localWranglerPath, next);
}

function writeProfile({
  publicBaseUrl,
  uploadUrl,
  agentMaxWidth,
  agentQuality,
}: ProfileConfig): void {
  mkdirSync(dirname(profilePath), { recursive: true });
  const lines = [
    `PUBLIC_BASE_URL=${envQuote(publicBaseUrl)}`,
    `STARSHOT_UPLOAD_URL=${envQuote(uploadUrl)}`,
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

function createR2Bucket(bucketName: string): void {
  const bucketResult = run("bunx", ["wrangler", "r2", "bucket", "create", bucketName]);
  if (bucketResult.status !== 0) {
    console.error(`Failed to create R2 bucket "${bucketName}".`);
    console.error("If it already exists, rerun setup and choose bucket mode \"existing\".");
    process.exit(bucketResult.status ?? 1);
  }
}

function printNextSteps(
  secretMode: string,
  endpointMode: string,
  customDomain: string,
  publicBaseUrl: string,
  installedFinderService: boolean,
): void {
  console.log("");
  console.log("Next steps:");
  console.log("1. Check local config: bun run config:check");
  console.log("2. Deploy the Worker: bun run deploy");
  if (secretMode === "skip") {
    console.log(
      "3. Upload the Keychain-stored AUTH_TOKEN after deploy: bunx varlock printenv -p .env.schema -p .varlock/profiles/starshot.env AUTH_TOKEN | bunx wrangler secret put AUTH_TOKEN",
    );
  } else {
    console.log("3. AUTH_TOKEN was uploaded to Cloudflare during setup.");
  }
  if (endpointMode === "workers-dev") {
    console.log(`4. Confirm the Worker URL is enabled in Cloudflare: ${publicBaseUrl}`);
  } else if (customDomain) {
    console.log(`4. Confirm the custom domain appears in Cloudflare: ${customDomain}`);
  } else {
    console.log(`4. Add a Worker custom domain or route for ${publicBaseUrl} in Cloudflare.`);
  }
  console.log("5. Test an upload: bun run starshot upload-file ./screenshot.png");
  if (process.platform === "darwin") {
    console.log(installedFinderService
      ? "6. Finder Quick Action installed: right-click an image and choose Starshot Upload."
      : "6. Optional: install Finder Quick Action with scripts/install-macos-finder-service.sh");
  }
  console.log(`Local Worker config: ${localWranglerPath}`);
}

async function main(): Promise<void> {
  if (!existsSync(wranglerPath)) {
    console.error("wrangler.toml not found. Run setup from the Starshot project root.");
    process.exit(1);
  }

  const bucketMode = hasArg("--skip-bucket")
    ? "skip"
    : argValue("--bucket-mode") ??
      (await promptChoice(
        "R2 bucket mode: create, existing, or skip",
        "existing",
        ["create", "existing", "skip"] as const,
      ));
  const existingBucketName = wranglerValue(/^bucket_name = "([^"]*)"$/m, "starshot-screenshots");
  const bucketName = argValue("--bucket") ??
    (bucketMode === "skip" ? existingBucketName : await prompt("R2 bucket name", existingBucketName));
  const secretMode = hasArg("--skip-wrangler-secret")
    ? "skip"
    : argValue("--secret-mode") ??
      (await promptChoice(
        "Worker secret setup: now or skip",
        "skip",
        ["now", "skip"] as const,
      ));
  const endpointMode = hasArg("--no-custom-domain")
    ? "workers-dev"
    : hasArg("--custom-domain") || argValue("--custom-domain")
      ? "custom-domain"
      : argValue("--endpoint-mode") ??
        (await promptChoice(
          "Public endpoint: custom-domain or workers-dev",
          "custom-domain",
          ["custom-domain", "workers-dev"] as const,
        ));
  const existingPublicBaseUrl = wranglerValue(
    /^PUBLIC_BASE_URL = "([^"]*)"$/m,
    endpointMode === "workers-dev"
      ? "https://your-worker.your-subdomain.workers.dev"
      : "https://your-domain.example",
  );
  const publicBaseUrl =
    argValue("--public-base-url") ??
    (await prompt(
      endpointMode === "workers-dev" ? "workers.dev URL" : "Custom domain URL",
      existingPublicBaseUrl,
    ));
  const inferredCustomDomain = hostnameFromUrl(publicBaseUrl);
  const explicitCustomDomain = argValue("--custom-domain");
  const shouldPromptForCustomDomainRoute =
    endpointMode === "custom-domain" &&
    !explicitCustomDomain &&
    !hasArg("--custom-domain") &&
    !argValue("--endpoint-mode") &&
    !argValue("--public-base-url");
  const customDomain = endpointMode === "workers-dev" || hasArg("--no-custom-domain")
    ? ""
    : explicitCustomDomain ??
      (shouldPromptForCustomDomainRoute &&
      !(await promptBool(
        `Add ${inferredCustomDomain} as a Worker custom domain route in local Wrangler config`,
        true,
      ))
        ? ""
        : inferredCustomDomain);
  const uploadUrl =
    argValue("--upload-url") ?? `${publicBaseUrl.replace(/\/$/, "")}/upload`;
  const agentMaxWidth = validateInteger(
    "Agent preview max width",
    argValue("--agent-max-width") ?? (await prompt("Agent preview max width", "1280")),
    1,
  );
  const agentQuality = validateInteger(
    "Agent preview JPEG quality",
    argValue("--agent-quality") ?? (await prompt("Agent preview JPEG quality", "60")),
    1,
    100,
  );
  const installFinderService = process.platform === "darwin" &&
    !hasArg("--skip-finder-service") &&
    (hasArg("--install-finder-service") ||
      await promptBool("Install macOS Finder Quick Action for right-click uploads", true));
  const token = randomBytes(32).toString("base64url");

  writeLocalWranglerConfig({ bucketName, publicBaseUrl, customDomain });
  writeProfile({
    publicBaseUrl,
    uploadUrl,
    agentMaxWidth,
    agentQuality,
  });
  storeTokenInKeychain(token);
  console.log("Stored AUTH_TOKEN locally in macOS Keychain.");

  if (bucketMode === "create") {
    createR2Bucket(bucketName);
  } else if (bucketMode === "existing") {
    console.log(`Using existing R2 bucket "${bucketName}".`);
  } else {
    console.log("Skipping R2 bucket creation.");
  }

  if (secretMode === "now") {
    putWranglerSecret(token);
  } else {
    console.log("Skipping Worker secret upload.");
    console.log(
      "After the Worker exists, upload the same Keychain token with: bunx varlock printenv -p .env.schema -p .varlock/profiles/starshot.env AUTH_TOKEN | bunx wrangler secret put AUTH_TOKEN",
    );
  }

  if (installFinderService) {
    const installResult = run("sh", [resolve(root, "scripts/install-macos-finder-service.sh")]);
    if (installResult.status !== 0) {
      process.exit(installResult.status ?? 1);
    }
  }

  console.log("Starshot setup complete.");
  console.log(`Profile: ${profilePath}`);
  printNextSteps(secretMode, endpointMode, customDomain, publicBaseUrl, installFinderService);
}

try {
  await main();
} finally {
  rl.close();
}
