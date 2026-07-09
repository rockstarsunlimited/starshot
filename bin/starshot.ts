#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

const scripts: Record<string, string> = {
  setup: "scripts/setup-starshot.ts",
  agent: "scripts/agent-screenshot.ts",
  "agent-file": "scripts/agent-screenshot.ts",
  last: "scripts/list-urls.ts",
  list: "scripts/list-urls.ts",
  copy: "scripts/list-urls.ts",
  sync: "scripts/sync-queue.ts",
  status: "scripts/sync-queue.ts",
};

const varlockCommands = [
  "agent",
  "agent-file",
  "upload-file",
  "last",
  "list",
  "copy",
  "sync",
  "status",
] as const;

function help(): void {
  console.log(`Starshot

Usage:
  starshot setup
  starshot agent [--format path|url|env|json] [--upload]
  starshot agent-file <image> [--format path|url|env|json]
  starshot upload-file <image> [--scope humans|agents]
  starshot last [--scope humans|agents]
  starshot list [--since 1h|1d] [--scope humans|agents]
  starshot copy [--since 1h|1d] [--scope humans|agents]
  starshot sync
  starshot status

For development commands, clone the repo and use bun run <script>.`);
}

if (command === "help" || command === "--help" || command === "-h") {
  help();
  process.exit(0);
}

if (command === "upload-file") {
  const result = spawnSync("cargo", ["run", "--quiet", "--", "upload-file", ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const script = scripts[command];
if (!script) {
  console.error(`Unknown command: ${command}`);
  help();
  process.exit(1);
}

const commandArgs =
  command === "agent-file"
    ? ["--mode", "file", ...args]
    : args;

if (varlockCommands.some((varlockCommand) => varlockCommand === command) && process.env["STARSHOT_VARLOCK_WRAPPED"] !== "1") {
  const profilePath = resolve(root, ".varlock/profiles/starshot.env");
  const varlockArgs = ["varlock", "run", "-p", ".env.schema"];
  try {
    if (await Bun.file(profilePath).exists()) {
      varlockArgs.push("-p", ".varlock/profiles/starshot.env");
    }
  } catch {
    // Fall back to schema-only resolution.
  }
  varlockArgs.push("--", resolve(root, "bin/starshot.ts"), command, ...args);

  const result = spawnSync("bunx", varlockArgs, {
    cwd: root,
    env: { ...process.env, STARSHOT_VARLOCK_WRAPPED: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const result = spawnSync(resolve(root, script), commandArgs, {
  cwd: root,
  env: { ...process.env, STARSHOT_LIST_COMMAND: command, STARSHOT_SYNC_COMMAND: command },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
