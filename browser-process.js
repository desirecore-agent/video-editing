/* Own one export browser through Chromium's DevTools pipe. No process lookup,
   persisted PID or supervisor: the OS closes our exclusive pipe endpoint even
   when this server is killed, and Chromium's EOF callback closes the browser.
   See desirecore/RUNTIME.md for the pinned upstream implementation and limits. */
"use strict";
const fs = require("fs");
const { spawn } = require("./native-process");
const { StringDecoder } = require("node:string_decoder");

const CLOSE_GRACE_MS = 3000;
const KILL_GRACE_MS = 2000;
const PIPE_MESSAGE_BYTES = 64 * 1024;
const STDERR_BYTES = 16 * 1024;

function createBrowserProcess(exe, args, { profileDir, keep = false, onTargetCrash } = {}) {
  const observe = typeof onTargetCrash === "function";
  const diagnostics = { discovery: observe ? "pending" : "disabled", targetCrashes: [], stderrTail: "", exit: null };
  let closing = false, termTimer, killTimer;
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
      stdio: ["ignore", "ignore", observe ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true,
    });
  } catch (error) {
    removeProfile();
    throw error;
  }
  const input = proc.stdio[3], output = proc.stdio[4];
  // This remains the sole owner of the EOF pipe. Observing targets uses that
  // existing pipe, never a debug port or attachment to another browser.
  input.on("error", () => { if (observe && !closing) diagnostics.discovery = "pipe_error"; });
  output.on("error", () => { if (observe && !closing) diagnostics.discovery = "pipe_error"; });
  if (observe) {
    const decoder = new StringDecoder("utf8"), targets = new Map();
    let pending = "", discarded = false;
    const message = raw => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      if (event.id === 1) diagnostics.discovery = event.error ? "unsupported" : "enabled";
      const info = event.params?.targetInfo;
      if ((event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") && info?.targetId) {
        if (!targets.has(info.targetId) && targets.size >= 128) targets.delete(targets.keys().next().value);
        targets.set(info.targetId, { type: info.type, url: info.url });
      } else if (event.method === "Target.targetDestroyed") targets.delete(event.params?.targetId);
      else if (event.method === "Target.targetCrashed") {
        const p = event.params;
        if (!p || typeof p.targetId !== "string" || typeof p.status !== "string" || !Number.isInteger(p.errorCode)) return;
        const target = targets.get(p.targetId);
        const crash = { at: Date.now(), targetId: p.targetId, type: target?.type || "unknown", status: p.status.slice(0, 128), errorCode: p.errorCode, ownerClosing: closing };
        diagnostics.targetCrashes.push(crash);
        if (diagnostics.targetCrashes.length > 8) diagnostics.targetCrashes.shift();
        // Closing our owner can itself destroy targets. It is not a natural
        // page crash and must not replace an existing result/cancellation.
        if (!closing) onTargetCrash({ ...crash, url: target?.url });
      }
    };
    output.on("data", chunk => {
      const text = decoder.write(chunk);
      let start = 0, end;
      while ((end = text.indexOf("\0", start)) !== -1) {
        const part = text.slice(start, end);
        if (!discarded && Buffer.byteLength(pending) + Buffer.byteLength(part) <= PIPE_MESSAGE_BYTES) message(pending + part);
        pending = ""; discarded = false; start = end + 1;
      }
      if (!discarded) {
        pending += text.slice(start);
        if (Buffer.byteLength(pending) > PIPE_MESSAGE_BYTES) { pending = ""; discarded = true; }
      }
    });
    const stderrDecoder = new StringDecoder("utf8");
    proc.stderr.on("data", bytes => {
      const tail = Buffer.concat([Buffer.from(diagnostics.stderrTail), Buffer.from(stderrDecoder.write(bytes))]);
      let begin = Math.max(0, tail.length - STDERR_BYTES);
      while (begin < tail.length && (tail[begin] & 0xc0) === 0x80) begin++;
      diagnostics.stderrTail = tail.subarray(begin).toString("utf8");
    });
    proc.once("spawn", () => {
      if (closing) return;
      input.write(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }) + "\0", error => {
        if (error) diagnostics.discovery = "pipe_error";
      });
    });
  } else output.resume();
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  const clearTimers = () => { clearTimeout(termTimer); clearTimeout(killTimer); };
  proc.once("exit", clearTimers);
  proc.once("exit", (code, signal) => { diagnostics.exit = { code, signal, ownerClosing: closing }; });
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
    diagnostics() { return { pid: proc.pid ?? null, ...structuredClone(diagnostics) }; },
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
