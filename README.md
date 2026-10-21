<div align="center">

<img src="windows/src-tauri/icons/128x128.png" width="96" alt="Peika icon">

# Peika

**A small cloud that lives at the top of your screen and keeps an eye on your AI coding agent sessions.**

Approve permissions, watch your agents work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing. Click the cloud and it plays peekaboo.

</div>

---

Peika is the Windows and Linux app in [`windows/`](windows/): a [Tauri](https://tauri.app) app (Rust in `src-tauri/`, TypeScript in `src/`) plus `peika-hook`, the tiny relay your agents call. Its [README](windows/README.md) covers what it does, how to install it, and every setting.

Say **"OK Peika"** to talk to it, or use the shortcuts. It works with Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Copilot CLI, OpenCode, Amp, Hermes and more, and never blocks them: if Peika doesn't answer, the hook exits immediately.

## Build

```
cd windows && npm install && npm run tauri dev
```

`npm test` runs the frontend tests, `cargo test --workspace` the Rust ones.

## Where this comes from

Peika started as a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé and has been renamed and redrawn since: the character is a new cloud, drawn in code on the same animation engine. The Windows and Linux code is under the MIT License; keep the copyright notices in [LICENSE](LICENSE).

The repository also holds the macOS and iPhone app (`NotchBuddy/`, Swift, MIT) and the iPhone push relay (`relay/`), renamed to Peika but not built since: there is no Mac or Xcode in the loop yet, and the Apple team id is cleared (set `DEVELOPMENT_TEAM` in `NotchBuddy/project.yml` and run `xcodegen`). Some of the original's sounds and media are still here until they are replaced. [LICENSE-ASSETS.md](LICENSE-ASSETS.md) describes what the original author reserves; none of it is Peika's.

## License

- **Code:** [MIT](LICENSE).
- **Peika's own work** (the cloud character, the icon, the name) is by [kura120](https://github.com/kura120).
