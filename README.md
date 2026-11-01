# 视频剪辑 · Video Editing

[简体中文](README.zh-CN.md)

A DesireCore managed adaptation of [FableCut](https://github.com/ronak-create/FableCut). It keeps the original nonlinear timeline, JSON project format, browser compositor, audio/media tools, REST API and `fablecut_*` MCP tools. The companion Agent is **视频剪辑师** in the separate [video-editor](https://github.com/desirecore-agent/video-editor) repository.

DesireCore owns installation, permissions, the process lifecycle, runtime generation and application data root. App association is an entry preference; it grants no tools or files. GUI edits and MCP edits use the same service and project revision. A managed MCP client attaches to that existing generation and cannot start a second service.

## Use and delivery

Use Node 22 or newer from DesireCore's managed runtime PATH. Native FFmpeg, ffprobe and a headless browser are prepared explicitly in the application's data directory; see [the runtime and backup contract](desirecore/RUNTIME.md). No developer machine paths or native binaries are bundled.

```sh
node desirecore/setup-runtime.js --data-dir /your/owned/application-data
node desirecore/start.js --data-dir /your/owned/application-data
```

For a managed installation the owner supplies `PORT`, `APP_DATA_DIR` and the actual runtime identity fields. Start the command from the fixed material root returned by platform prepare. MCP uses `node desirecore/cli.mjs mcp --runtime-file <actual-owner-response.json>`; `status` and `identity` use the same current-generation connection file. The wrapper verifies its own complete fixed material and canonical release digest, then data root, port, managed peer and all generation fields before attaching. An old local release cannot reuse a newer runtime connection file. Source-only help and location need no running service. It does not install or launch the editor.

Generate immutable platform material with `node desirecore/release.js --output /fresh/material-directory`. The generator freezes an explicit file list, enforces the default 32 MiB/file and 128 MiB total platform budgets, and writes canonical `app-release.json` plus file hashes. It excludes tests, local projects, native caches and diagnostics. `npm run check:delivery` also packs and installs the real package outside this checkout before checking its launchers, Schema and editor guide.

## Editing and export contract

[Editor guide](docs/editor-guide.md) describes the retained timeline and MCP APIs. Saves compare project identity/revision and preserve UI drafts on conflict. GUI Fast, the existing queue and MCP export submit committed JSON and declared local-media snapshots to the original job owner. A completed frame-rate group cannot complete a mixed-rate aggregate. Receipts survive restart as interrupted; retry is explicit. The same job records exact session/probe/audio and reserved single/batch partial-output ownership before encoding. Restart removes only confirmed registered artifacts, preserves completed and foreign files, and reports cleanup failures or unknown ownership (including legacy receipts and creation-before-confirmation gaps) instead of guessing. Unknown submissions must be queried before resubmitting.

Resolved declared local files are snapshotted file by file. This is not a transaction across independent file systems. Dynamic SVG dependencies, network resources and OS fonts are not a fully frozen closure. Optional ASR, MediaPipe and remote fonts may fetch their upstream resources; no paid provider or model is selected by this application. Native GUI and each OS's runtime behavior require their own acceptance evidence; CI alone is not desktop validation.

## Development

`npm run test:delivery` checks packaging and runtime integrity boundaries; `npm run test:regression` runs the focused editing/export suite with bounded concurrency. CI runs static checks, the full upstream unit suite, package installation checks and explicit per-OS runtime preparation. The editor core has no npm runtime dependency.

Version **0.1.2** is maintained in this fork. Upstream source is `61bf46babca82214c162c0650e47a81c3530982c` (1.18.0); original history and [MIT license](LICENSE) are retained. See [notices and dependency licenses](NOTICE.md). Upstream npm/MCP publication and Discord workflows are removed.
