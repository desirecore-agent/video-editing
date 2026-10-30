# Runtime licenses

The MIT editor license is at `LICENSE`; bundled font notices are at `library/fonts/LICENSES.md`.

Node is selected by DesireCore's existing managed Node runtime and retains that runtime's full license distribution. Explicit setup of native media/browser dependencies records each pinned archive URL, SHA-256, source URL and declared license in `runtime-assets.json`, copies the manifest and available full archive license/notice files into the owned runtime cache, and writes a receipt with the extracted file hashes. FFmpeg GPL builds and Chrome/Chromium BSD and third-party notices are separate from the editor's MIT license. Do not redistribute a runtime cache without its accompanying notices and corresponding source obligations.
