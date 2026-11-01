# Source and third-party notices

视频剪辑 0.1.1 is a DesireCore adaptation of [FableCut](https://github.com/ronak-create/FableCut), based on upstream commit `61bf46babca82214c162c0650e47a81c3530982c` (1.18.0). The original Git history, MIT license and copyright are preserved in `LICENSE`. The timeline, browser compositor, media/audio tools and MCP tool prefix remain upstream code; managed lifecycle, reliable saving/export receipts and host theme integration are adaptations maintained here.

This fork is maintained at https://github.com/desirecore-agent/video-editing. It does not represent the upstream npm package, MCP Registry entry, Glama listing, website or Discord project. No publication to those services is configured.

Bundled fonts retain the notices in `library/fonts/LICENSES.md` (SIL Open Font License), with `docs/fonts/LICENSE.txt` for the documentation font. Library SVGs retain their upstream source. Sound effects with no redistribution permission are not included.

Native dependencies are separate from the MIT editor: Node is supplied by DesireCore's existing managed runtime (Node license: https://github.com/nodejs/node/blob/main/LICENSE). Explicit runtime preparation retrieves pinned Chromium/Chrome for Testing and FFmpeg/ffprobe assets into this application's data root; source, hashes, licenses and extraction behavior are declared in `desirecore/runtime-assets.json` and `desirecore/RUNTIME.md`. These assets and their notices must not be represented as MIT-only software.
