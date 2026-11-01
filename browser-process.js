/* Own one export browser through Chromium's DevTools pipe. No process lookup,
   persisted PID or supervisor: the OS closes our exclusive pipe endpoint even
   when this server is killed, and Chromium's EOF callback closes the browser.
   See desirecore/RUNTIME.md for the pinned upstream implementation and limits. */
"use strict";
const fs = require("fs");
const { spawn } = require("./native-process");

const CLOSE_GRACE_MS = 3000;
const KILL_GRACE_MS = 2000;

function createBrowserProcess(exe, args, { profileDir, keep = false }) {
  const removeProfile = (attempts = 5) => {
    if (keep) return;
    fs.rm(profileDir, { recursive: true, force: true }, (error) => {
      if (error && attempts > 0) setTimeout(() => removeProfile(attempts - 1), 1000).unref();
    });
  };
  let proc;
  try {
    // Chromium reads FD3 and writes FD4. Never pass our side of these pipes to
    // another child: only this owner may keep the browser's input pipe open.
    proc = spawn(exe, [...args, "--remote-debugging-pipe"], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true,
    });
  } catch (error) {
    removeProfile();
    throw error;
  }
  const input = proc.stdio[3], output = proc.stdio[4];
  // No CDP commands or responses are needed. Drain output so it cannot block
  // browser shutdown, and tolerate pipe errors during startup or termination.
  input.on("error", () => {});
  output.on("error", () => {});
  output.resume();
  let closing = false, termTimer, killTimer;
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  const clearTimers = () => { clearTimeout(termTimer); clearTimeout(killTimer); };
  proc.once("exit", clearTimers);
  proc.once("error", clearTimers);
  proc.once("close", () => {
    clearTimers();
    input.destroy();
    output.destroy();
    // In particular, never remove a still-live browser's locked profile just
    // because a timer elapsed. Spawn failure also emits close without a PID.
    removeProfile();
  });
  return {
    proc, profileDir, keep,
    close() {
      if (closing) return;
      closing = true;
      input.destroy(); // the same EOF path also runs when our owner is SIGKILLed
      if (exited() || !proc.pid) return;
      termTimer = setTimeout(() => {
        if (exited()) return;
        // Fallbacks concern only this original, unreaped ChildProcess. They do
        // not prove descendant termination and never look up or reuse a PID.
        try { proc.kill("SIGTERM"); } catch {}
        if (!exited()) killTimer = setTimeout(() => {
          if (!exited()) { try { proc.kill("SIGKILL"); } catch {} }
        }, KILL_GRACE_MS);
      }, CLOSE_GRACE_MS);
    },
  };
}

module.exports = { createBrowserProcess };
