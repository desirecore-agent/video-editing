# Working on 视频剪辑

This repository preserves the FableCut editor, JSON timeline, compositor, REST API and `fablecut_*` MCP tool names. The upstream source is `61bf46babca82214c162c0650e47a81c3530982c`; see [NOTICE.md](NOTICE.md).

- The editor manual is [docs/editor-guide.md](docs/editor-guide.md). Do not add `CLAUDE.md` files. Update the guide when timeline, API or MCP contracts change.
- Keep the editor core standard-library only; preview and export use the same compositor. Do not add another editing, job or Agent runtime.
- DesireCore owns installation, authorization, TaskHost lifecycle, runtime proof, generation, port and data root. App association grants no permissions. A managed MCP client attaches to the existing verified service and must never start another server.
- Runtime preparation is explicit: `node desirecore/setup-runtime.js`. Downloaded native dependencies live under the application data root, outside the immutable material. Pin source, SHA-256 and license in `desirecore/runtime-assets.json`; never ship developer binaries, credentials, providers or test fixtures.
- `desirecore/release.js` is the sole material generator. Payload limits are 32 MiB per regular file, 128 MiB total and 2048 files. Keep user data, tests, caches, node_modules and diagnostics out of the payload.
- Use focused Node tests (`npm run test:delivery`, `npm run test:regression`) and `npm run check:delivery`. CI also verifies the real npm pack installed outside this checkout and prepares native dependencies on its own OS. Native GUI evidence remains a separate acceptance requirement.
- Work only on feature branches and use PRs. Do not publish to upstream npm/MCP namespaces or post upstream announcements. Preserve upstream MIT and font notices.
- Multiple agents may edit this checkout. Respect assigned file ownership and do not revert another agent's work.
