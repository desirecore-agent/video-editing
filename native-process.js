/* Native executable spelling only. Keep command lookup, arguments, options,
   callbacks and ChildProcess ownership with Node's existing implementation. */
"use strict";
const path = require("path");
const cp = require("child_process");

function nativeExecutable(executable, platform = process.platform) {
  if (platform !== "win32" || typeof executable !== "string") return executable;
  // A root-relative path (\tool.exe) still depends on the current drive. Only
  // already fully-qualified drive/UNC paths enter the extended-length API.
  if (!path.win32.isAbsolute(executable) || path.win32.parse(executable).root.length <= 1) return executable;
  return path.win32.toNamespacedPath(executable);
}

// Read the native method at call time: callers and existing unit fixtures may
// replace it after this module loads. No global child_process patch is applied.
const forward = method => (executable, ...args) => cp[method](nativeExecutable(executable), ...args);
module.exports = {
  nativeExecutable,
  spawn: forward("spawn"),
  spawnSync: forward("spawnSync"),
  execFile: forward("execFile"),
};
