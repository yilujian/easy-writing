# Easy Writing（易创）

**A local-first desktop app for serial web novel writing**: novel editor, word-count tracking, AI-assisted writing (BYOK), and ranking-trend insights. Manuscripts, settings, and writing records stay on your own machine. No account or login is required, and core writing features work offline.

[中文说明](./README.md) · [Download](#download) · [Roadmap](#roadmap) · [Commercial cooperation](#commercial-cooperation-and-contact)

> Refactored from a long-running writing platform client. The editor, autosave pipeline, and chapter management have seen sustained real-world use by Chinese web-novel authors. Built for writers on Qidian, Fanqie, Qimao, JJWXC and anyone who wants to truly own their manuscripts.

## Interface preview

**Local-first writing home**

![Easy Writing local-first writing home](./docs/images/home.png)

**Writing desk and typing preferences**

![Easy Writing editor with typing sounds and visual-effect settings](./docs/images/writing-experience.png)

**AI book-building workflow**

![Easy Writing AI book-building workflow](./docs/images/workflow-book.png)

## Why this app

- **Your data, your disk**: books, worldbuilding notes and writing stats live in a local SQLite database, with scheduled automatic backups (txt + json) and one-click full export.
- **Bring Your Own Key (BYOK)**: configure DeepSeek, Qwen, GLM, Kimi, OpenAI, or most services that expose an OpenAI-compatible API. Your key is stored locally, and requests go directly from your machine to the configured model provider. Locally deployed models (Ollama, LM Studio, …) work too — just leave the API key empty.
- **Fully open prompts**: every AI prompt is a local Markdown file you can edit in-app or with any editor, including per-scene sampling temperature.
- **Free and open source** under AGPL-3.0.

## Features

### Writing

- **Editor**: rich text (TipTap), volume/chapter tree with drag-and-drop, full-book search, find & replace
  - Continuous autosave (160 ms debounce + snapshot on close); crash-safe recovery
  - Automatic per-chapter version history
  - Local sensitive-word linting, typing sound effects, focus mode
- **Reference panels**: outline, characters (with relationship graph canvas), worldbuilding, timeline, storyline mind-map canvas
- **Bookshelf**: multi-book management, grouping, covers, TXT/JSON import & export, recycle bin
- **Writing stats**: daily words, trends, calendar, streaks, daily goals — manual words and AI-generated words tracked separately
- **Quick notes**: capture inspirations anywhere, reuse them everywhere

### Writing experience and personalization

- **Immersive typing feedback**: choose clicky or tactile mechanical-key sounds, a vintage typewriter, gunshot, or dog-bark feedback, with a silent option
- **Cursor-level visual effects**: trigger ink splashes, ripples, drifting mist, flames, or short encouragement messages as you type, or turn effects off entirely
- **Flexible editor typography**: adjust font, weight, color, size, line height, content width, paragraph spacing, alignment, and writing-grid style
- **Four themes and custom backgrounds**: switch between Clean Paper, Classic Letter, Forest Eye-Care, and Dark Ink themes; choose from eight bundled backgrounds or use your own image
- **Focus and reading preview**: write in fullscreen, use the inactivity countdown challenge, and preview the current chapter in a synchronized mobile reader
- **Audiobook listening**: the writing desk reads the latest saved chapter, refreshes edited text when resuming, and stops at the chapter end. Bookshelf listening supports sentence highlighting, continuous playback, resume-where-you-left-off, and a sleep timer; uses system speech by default, with optional BYOK cloud TTS models that support `/audio/speech`

### AI assistance (bring your own key)

- **Selection actions**: polish / expand / proofread / custom instruction on any selected text, with accept & discard review
- **Continuation**: hotkey-triggered streaming continuation plus inline ghost-text suggestions (accept with Tab)
- **AI chat companion**: a side-panel consultant for plot, characters and settings, with local chat history
- **One-click book workflow**: idea → outline → worldbuilding → book creation → chapter-by-chapter auto-drafting with resumable checkpoints
- **Competitive analysis**: import any TXT novel and get per-chapter pacing breakdowns, a "golden first three chapters" deep-dive and a whole-book report
- **Name generator / blurb generator / AI covers**
- **AI usage ledger**: every call logged locally with scene, tokens and outcome

### Ranking trends (desktop only)

A built-in crawler fetches public ranking pages of major Chinese web-novel sites **over your own network**; snapshots stay on your machine, with trend analysis, tag insights, CSV export and AI interpretation.

## Roadmap

> The following capabilities are planned. Scope and release timing may change and will be confirmed in future releases.

- **Infinite-canvas book workflow**: turn inspiration, characters, worldbuilding, outlines, volume plans, chapter plans, and drafting into connected nodes that can be rearranged, branched, reused, and revised at any point
- **AI scriptwriting**: move from premise, character profiles, and episode outlines to scenes, action, and dialogue, with explicit review and partial-rewrite checkpoints
- **Storyboard breakdown workflow**: split scripts into scenes and shots, producing structured shot size, camera position, camera movement, performance, dialogue, duration, and visual-prompt information
- **Novel-to-script-to-storyboard continuity**: carry context and version history across writing, adaptation, and storyboard stages to reduce repeated manual organization

## Download

Once installers are published, download them from the [Releases](https://github.com/yilujian/easy-writing/releases) page:

- **macOS**: download the `.dmg`. After confirming that it came from this repository, if macOS reports that the app is damaged or from an unidentified developer, run `xattr -cr /Applications/易创.app` once and try again (the app is currently not notarized).
- **Windows**: download the `.exe` installer. If SmartScreen objects, choose "More info → Run anyway".

The app checks GitHub for new releases at most once a day and shows a notification that links to the download page.

## Quick start

1. Install, open, click "New book" — writing needs zero configuration.
2. For AI features: sidebar → **Model Manager** → pick a provider preset → paste your own API key → test → save, then set it as the default model.
3. To customize prompts: sidebar → **Prompt Manager**; every scene is editable and restorable.

## Where data lives

- **Desktop**: a SQLite database inside the app data directory; automatic backups (txt + json) and prompt Markdown files live in your Documents folder.
- **Browser mode** (for development preview): IndexedDB + localStorage — export your books before clearing site data.

## Development

```bash
pnpm install
pnpm dev        # web dev server on port 6789
pnpm check      # typecheck + lint; also runs tests when local test files exist
pnpm build      # web production build
```

Desktop (Tauri 2): install [Rust](https://rustup.rs/) first, then `pnpm dev:desktop` to debug and `pnpm tauri build` to package.

Stack: Vue 3 + TypeScript + Vite + Pinia + Element Plus + TipTap 3 + Tauri 2.

## FAQ

**Does AI cost money?** The app is free. AI usage is billed by your configured model provider based on actual usage.

**Is my API key safe?** Keys are stored in your local configuration. When you use AI features, the key and request content are sent directly from your machine to the model provider you configured.

**Why doesn't the ranking feature work in the browser?** Crawling needs desktop-only system capabilities. On desktop it runs over your own network and stores data locally.

**How do I migrate to a new computer?** Export any book as JSON (worldbuilding included) and import it on the new machine, or copy the app data directory wholesale.

**Thinking models (DeepSeek V4, Qwen, etc.) fail or are very slow when generating an outline?** Their reasoning eats into the output budget. Every model in Model Management has a "Thinking" setting: "Off" is fastest and most reliable for structured tasks; if you keep it on, raise "Max output tokens" to 32768 or more. Vendors use different switches; the app ships mappings for DeepSeek, Zhipu, Volcengine Ark, Qwen, SiliconFlow, OpenRouter, Gemini and Ollama, and other endpoints can set theirs in "Extra request params".

**A local model (Ollama, LM Studio, etc.) fails with "no access permission" / 403?** Leave the API key empty. If you still get 403, the local server is most likely rejecting the request by its origin. Current desktop builds no longer send an origin with AI requests, so update first; on older builds, set `OLLAMA_ORIGINS=*` and restart Ollama, or add `http://tauri.localhost` and `tauri://localhost` to your server's allowed origins.

## Disclaimer

The ranking-trend feature is for personal study and creative reference only. Crawling happens on your own device and network — respect the target sites' terms of service, keep request rates low, and do not build commercial data services on top of it. You are responsible for the copyright and compliance of AI-generated content.

## Feedback

Use the in-app **Feedback** page to compose a report, then paste it into a new [issue](https://github.com/yilujian/easy-writing/issues).

## Commercial cooperation and contact

For the following services or other partnership ideas, contact me by email or WeChat:

- The official Easy Writing SaaS commercial edition and related partnerships
- Alternative commercial licensing outside AGPL, private deployment, OEM, and secondary development
- Custom software, AI product, and business-system development
- AI agent, workflow, and automation development
- Other technical partnerships, joint projects, and consulting

**Email**: [75082807@qq.com](mailto:75082807@qq.com)

**WeChat**: please include the intended cooperation area in your request.

<img src="./docs/images/wechat-contact.png" alt="yilujian WeChat QR code" width="260">

**WeChat group**: the Easy Writing feedback group, for questions and suggestions. The group QR code changes weekly; if it has expired, add the WeChat above and ask to be invited.

<img src="./docs/images/wechat-group.png" alt="Easy Writing feedback group QR code" width="260">

## License

[AGPL-3.0](./LICENSE) — free to use, modify and redistribute; modified versions (including network-hosted services built on it) must be open-sourced under the same license.

## Author

[yilujian](https://github.com/yilujian)

## Links

- Thanks to the [LINUX DO](https://linux.do/) community for supporting developer exchange and open-source sharing.
