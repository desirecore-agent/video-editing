/* HTTP file transfers share one lifetime: a closed response must also close
 * its file, and an asynchronous open/read error must fail that transfer rather
 * than escape as an unhandled ReadStream error and terminate the editor. */
const fs = require("node:fs");
const { pipeline } = require("node:stream");

function report(error) {
  if (!error || ["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET"].includes(error.code)) return;
  // Do not include a private media path or request contents in diagnostics.
  console.warn("Video Editing file transfer failed:", error.code || "FILE_READ_FAILED");
}

function streamFileResponse(res, filePath, options) {
  if (res.destroyed || res.writableEnded) return null;
  let source;
  try {
    source = fs.createReadStream(filePath, options);
    pipeline(source, res, report);
  } catch (error) {
    source?.destroy();
    res.destroy();
    report(error);
  }
  return source || null;
}

module.exports = { streamFileResponse };
