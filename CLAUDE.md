# Peika — guide for AI coding agents

Peika is a small animated cloud at the top of the screen that shows AI coding agent sessions (Claude Code, Gemini CLI, Antigravity and more) and a few integrations, and lets the user approve, answer, chat and drop files from it. It is a fork of Coucou, renamed and redrawn. The app is `windows/` (Tauri, for Windows and Linux).

## Where things are
- `windows/src-tauri/` — Rust: the app, the agent hooks (`agents.rs`, `agent_hooks.rs`), voice, phone link, platform code. `windows/hook/` — the `peika-hook` relay. `windows/src/` — TypeScript: the island, views, settings, and the character in `src/peika/` (`engine.ts` draws the cloud with Canvas, `outfits.ts` the wardrobe, `greeting.ts` the launch greeting).
- `windows/dev/mascot-preview.html` — every state, outfit and the peekaboo of the cloud side by side (`npm run dev`, then `/dev/mascot-preview.html`; `?outfits`, `?hands`).
- `windows/README.md` — what the app does and how to install it.
- Inherited, being removed or replaced: `NotchBuddy/` (macOS and iPhone, Swift), `android/`, `relay/`, `design/`, `docs/`. Their sounds and media are the original author's (see `LICENSE-ASSETS.md`). `windows/vite.config.ts` still reads the sounds from `NotchBuddy/Resources/sounds`.

## Build
```
cd windows && npm install && npm run tauri dev
npm test && npx tsc --noEmit
cargo test --workspace
```
The Rust build needs `cargo build --release -p peika-hook` first (`npm run predev` does it).

## Rules
- The character is drawn in code (`Canvas`), no Rive/Lottie/images. No third-party dependencies unless truly unavoidable.
- Secrets live in the system credential store, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block an agent: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a Claude Code or Codex permission without an explicit click.
- Performance: 0 % CPU when the island is hidden. An animation that waits (a hold, a delay) must keep a tween running, or the island's loop stops and never draws the end.
- Pill IDs are stable contract values (settings, hook routing): never rename an existing pill ID.
- Phone-link wire constants (`coucou://pair`, the relay key label `coucou-relay/v1`) stay as they are until the phone apps change with them.
- Every release adds its CHANGELOG.md section.
