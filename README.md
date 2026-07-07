# Starshot

Starshot is a tiny screenshot transport tool for humans, local agents, and browser automation. It captures or accepts screenshots, keeps full-resolution originals locally, creates lightweight previews when useful, uploads to Cloudflare R2, and gives you terminal-friendly URLs.

This is an exploration around providing a cleaner, more minimal way to work with agents. Screenshots are extremely valuable context for agents when they need to understand UI state, debug failures, or fix visual issues without a heavy workflow.

Free to use, fork, and modify. PRs for features and fixes are welcome; credit is appreciated.

## Setup

```sh
git clone git@github.com:rockstarsunlimited/starshot.git
cd starshot
rustup target add wasm32-unknown-unknown
bun install
```

Run setup:

```sh
bun run setup
```

Setup generates one upload token, stores it in Cloudflare with Wrangler, stores the local uploader token through Varlock/macOS Keychain, and writes local settings to `.varlock/profiles/starshot.env`.

By default setup configures macOS to save full-resolution PNG screenshots in `~/Pictures/Starshot Screenshots`, uploads human screenshots as JPEG copies at quality `75`, creates agent previews at max width `1280` and quality `60`, keeps window shadows on, and cleans local screenshots older than `7` days.

R2 keys are split by prefix: `humans/...` for normal screenshot uploads and `agents/...` for agent/headless uploads. Set bucket lifecycle rules in Cloudflare for retention, for example deleting `agents/` after fewer days than `humans/`.

Useful setup flags: `--upload-format jpeg|png|original`, `--jpeg-quality 75`, `--agent-max-width 1280`, `--agent-quality 60`, `--cleanup-days 7`, `--shadows`, `--no-shadows`, `--screenshot-dir <path>`, `--skip-macos-defaults`.

```sh
bun run config:check
bun run dev
bun run deploy
```

## Upload

```sh
bun run upload
```

The uploader sends the newest PNG/JPEG/HEIC/HEIF from `SCREENSHOT_DIR`. It never edits the original screenshot; it creates a temporary upload copy in `.starshot-upload` when conversion is enabled.

## Agents

Fast local preview path:

```sh
bun run starshot agent
```

Headless or Playwright screenshot:

```sh
bun run starshot agent-file ./screenshot.png --format path
bun run starshot upload-file ./screenshot.png
```

Formats: `path`, `url`, `env`, `json`. Agent uploads use the `agents/` R2 prefix.

## URLs

```sh
bun run starshot last
bun run starshot list --since 1d
bun run starshot list --since 1h --scope agents
bun run starshot copy --since 1d
```

`last` prints the latest URL. `list` prints readable timestamps and URLs. `copy` puts matching URLs on the clipboard.

## Offline

If an upload fails because the network or Worker is unavailable, Starshot queues it locally and shows a macOS notification. Public URLs appear after sync:

```sh
bun run starshot sync
bun run starshot status
bun run starshot list --since 1d
```

For automatic macOS uploads:

```sh
bun run starshot install
```

This installs the current repo as the per-user LaunchAgent `co.rockstarsunlimited.starshot`. Uninstall it with `bun run starshot uninstall`.

If installed as a package, use:

```sh
bunx starshot setup
bunx starshot install
bunx starshot uninstall
```

## Checks

```sh
cargo fmt --check
cargo test
cargo clippy --all-targets --target wasm32-unknown-unknown -- -D warnings
cargo check --target wasm32-unknown-unknown
worker-build --release
bun run typecheck
bun run scan
```
