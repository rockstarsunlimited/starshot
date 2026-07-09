# Starshot

Starshot is a tiny screenshot transport tool for humans, local agents, and browser automation. It accepts screenshot files, creates lightweight previews when useful, uploads to Cloudflare R2, and gives you terminal-friendly URLs.

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

Setup asks whether to create a new R2 bucket or use an existing one, whether public links should use a custom domain or the `workers.dev` URL, generates one upload token, stores the local uploader token through Varlock/macOS Keychain, writes local settings to `.varlock/profiles/starshot.env`, and writes Worker deployment settings to `wrangler.local.toml`.

`PUBLIC_BASE_URL` controls the URLs Starshot prints. If you choose `workers-dev`, paste the production Worker URL, for example `https://starshot.example.workers.dev`. If you choose `custom-domain`, setup writes a `[[routes]]` Custom Domain entry to `wrangler.local.toml`; `bun run deploy` will attach that domain. The local Wrangler config is git-ignored so personal domains and bucket names do not get committed to this public repo. You can also add a domain in the Cloudflare dashboard under Workers & Pages > your Worker > Domains.

If you choose `Worker secret setup: skip`, deploy or create the Worker first, then upload the same token later with:

```sh
bunx varlock printenv -p .env.schema -p .varlock/profiles/starshot.env AUTH_TOKEN | bunx wrangler secret put AUTH_TOKEN
```

If the Worker already exists and you want setup to upload the secret immediately, choose `Worker secret setup: now`.

Setup configures explicit file uploads and agent previews. It does not install an OS-level screenshot watcher and does not change screenshot settings for macOS, Windows, or Linux. On macOS, setup offers to install a Finder Quick Action for right-click uploads; this is enabled by default and can be skipped.

R2 keys are split by prefix: `humans/...` for normal screenshot uploads and `agents/...` for agent/headless uploads. Set bucket lifecycle rules in Cloudflare for retention, for example deleting `agents/` after fewer days than `humans/`.

Useful setup flags: `--bucket-mode create|existing|skip`, `--secret-mode now|skip`, `--endpoint-mode custom-domain|workers-dev`, `--custom-domain`, `--custom-domain <hostname>`, `--no-custom-domain`, `--agent-max-width 1280`, `--agent-quality 60`, `--install-finder-service`, `--skip-finder-service`.

```sh
bun run config:check
bun run dev
bun run deploy
```

## Upload

```sh
bun run starshot upload-file ./screenshot.png
cargo run -- upload-file ./screenshot.png --scope humans
```

The TypeScript command can generate agent-friendly previews before upload. The native Rust command is the universal fast path for direct file upload and works on Linux, macOS, and Windows.

On macOS, you can add a Finder Quick Action for selected image files:

```sh
scripts/install-macos-finder-service.sh
```

That service does not watch folders or change screenshot settings; it uploads the file you right-clicked and copies the URL to the clipboard.

By default, the Finder action resolves secrets through Varlock/Keychain each time. To avoid repeated prompts during a local session, you can opt into a per-session plaintext cache when installing the Finder action:

```sh
STARSHOT_FINDER_SESSION_CACHE=1 scripts/install-macos-finder-service.sh
```

The cache is written with `0600` permissions under the current user's temporary directory. It is convenient, but it is not equivalent to Keychain isolation.

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

If an upload fails because the network or Worker is unavailable, Starshot can queue it locally when using the queue-aware TypeScript scripts. Public URLs appear after sync:

```sh
bun run starshot sync
bun run starshot status
bun run starshot list --since 1d
```

If installed as a package, use:

```sh
bunx starshot setup
bunx starshot upload-file ./screenshot.png
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
