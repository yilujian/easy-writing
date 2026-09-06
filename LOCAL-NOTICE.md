# Source and modification notice

Upstream: https://github.com/yilujian/easy-writing
Author: yilujian
Upstream version: 1.0.6
Base commit: 74ebfe496f792dba61f2001581023bee766ef89d
Modification date: 2026-09-05
License: AGPL-3.0-only, see LICENSE (retained unmodified).

This is an unofficial local enhancement of the upstream project, prepared for the requesting user. It is not an official upstream release. Original author attribution and source are retained.

Changes: a Node.js loopback companion server; disk snapshots of active books; a local backup/restore center; streaming model forwarding; cross-platform launch scripts; browser global search; shared book export payload extraction; pnpm 11 allowlist compatibility; documentation and regression tests.

Modified upstream files: package.json, pnpm-workspace.yaml, src/main.ts, src/App.vue, src/router/index.ts, src/layouts/components/Sidebar.vue, src/components/GlobalSearchPalette.vue, src/storage/local-library.ts, src/utils/local-ai-client.ts and .gitignore. Added files are documented in docs/LOCAL-DEVELOPMENT.md.

The archive contains complete corresponding application source, the original Tauri source, build configuration, dependency lockfile, tests and a prebuilt Web distribution. node_modules and Git internal history are not bundled. No API credentials or user writing data are bundled.

All additions and modifications are provided under AGPL-3.0-only. Distribution and modification should preserve the original license and attribution.
