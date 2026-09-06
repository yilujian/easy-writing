# Validation record

Date: 2026-09-05
Environment: Linux, Node.js 24.19.0, pnpm 11.19.0.

- Frozen-lockfile installation: passed.
- TypeScript + Vite production build: passed.
- ESLint on all changed and added frontend source files: passed, no diagnostics.
- Node HTTP integration tests: 5 passed (backup round-trip / deduplication / validation; host / origin / token / traversal / SPA checks; AI streaming and HTTP errors; snapshot retention; upstream cancellation).
- IndexedDB book export / restore integration: 1 passed.
- Production HTTP smoke: root HTML, referenced entry assets and four SPA routes passed.
- Original AGPL license retained; full original source and added source included.

Limitations: no interactive browser QA, no Windows/macOS device test, no real model API call, no Tauri executable build. Upstream VueUse annotation and large-chunk warnings are nonfatal.
