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
const NATIVE_TRACE_BYTES = 64 * 1024 * 1024;

/** 只留下固定 allocator 的数字，不把 trace 内的地址、路径或任意字段交给模型。 */
function summarizeAllocatorTrace(text) {
  const trace = JSON.parse(text), processes = new Map();
  const bytes = value => typeof value === "string" && /^[0-9a-f]+$/i.test(value)
    && Number.isSafeInteger(parseInt(value, 16)) ? parseInt(value, 16) : undefined;
  const fields = { malloc: "mallocBytes", partition_alloc: "partitionBytes",
    "partition_alloc/partitions/array_buffer": "arrayBufferBytes",
    "cc/image_memory": "imageCacheBytes", blink_gc: "blinkGcBytes", v8: "v8Bytes" };
  for (const event of trace.traceEvents || []) {
    if (!Number.isInteger(event.pid) || event.pid < 0) continue;
    if (!processes.has(event.pid)) {
      if (processes.size >= 16) continue;
      processes.set(event.pid, { pid: event.pid, type: "other" });
    }
    const item = processes.get(event.pid);
    if (event.name === "process_name") {
      const name = event.args?.name;
      item.type = name === "Renderer" ? "renderer" : name === "Browser" ? "browser" : name === "GPU Process" ? "gpu" : "other";
    }
    const dumps = event.args?.dumps;
    const resident = bytes(dumps?.process_totals?.resident_set_bytes);
    if (resident !== undefined) item.residentBytes = resident;
    for (const [allocator, field] of Object.entries(fields)) {
      const attr = dumps?.allocators?.[allocator]?.attrs?.size;
      const size = attr?.units === "bytes" ? bytes(attr.value) : undefined;
      if (size !== undefined) item[field] = size;
    }
  }
  return [...processes.values()].filter(p => Object.keys(p).length > 2);
}

function createBrowserProcess(exe, args, { profileDir, keep = false, onTargetCrash, observePageMemory, observeNativeAllocators = false } = {}) {
  const observe = typeof onTargetCrash === "function";
  const diagnostics = { discovery: observe ? "pending" : "disabled", targetCrashes: [], stderrTail: "", exit: null };
  const memoryUrl = observe && typeof observePageMemory === "string" && observePageMemory ? observePageMemory : null;
  if (memoryUrl) diagnostics.memory = { status: "waiting", sampleCount: 0, samples: [], peak: {}, stopReason: null };
  if (memoryUrl && observeNativeAllocators) diagnostics.nativeMemory = { status: "waiting" };
  let closing = false, termTimer, killTimer;
  let stopMemory = () => {};
  let stopNativeMemory = () => {};
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
  input.on("error", () => { if (observe && !closing) diagnostics.discovery = "pipe_error"; stopMemory("pipe_error"); });
  output.on("error", () => { if (observe && !closing) diagnostics.discovery = "pipe_error"; stopMemory("pipe_error"); });
  if (observe) {
    const decoder = new StringDecoder("utf8"), targets = new Map();
    let pending = "", discarded = false;
    // One exact owned page, one pending read, bounded numeric history. No JS
    // evaluation, GC, debug port, inferred cause or effect on job admission.
    let memoryTarget, memorySession, attachId, heapId, nextId = 2, memoryTimer, memoryDeadline;
    const memory = diagnostics.memory;
    const native = diagnostics.nativeMemory, nativeRequests = new Map();
    let nativeStopped = false, nativeStream, nativeStreamReject, nativeStreamTimer;
    const nativeCommand = (method, params = {}) => new Promise((resolve, reject) => {
      if (closing || nativeStopped) return reject(new Error("owner_closed"));
      const id = nextId++, timer = setTimeout(() => { nativeRequests.delete(id); reject(new Error("observation_timeout")); }, 30_000);
      timer.unref?.(); nativeRequests.set(id, { resolve, reject, timer });
      input.write(JSON.stringify({ id, method, params }) + "\0", error => {
        if (!error) return;
        const request = nativeRequests.get(id); if (!request) return;
        clearTimeout(request.timer); nativeRequests.delete(id); reject(new Error("pipe_error"));
      });
    });
    stopNativeMemory = () => {
      nativeStopped = true; clearTimeout(nativeStreamTimer); nativeStreamReject?.(new Error("owner_closed"));
      for (const request of nativeRequests.values()) { clearTimeout(request.timer); request.reject(new Error("owner_closed")); }
      nativeRequests.clear();
      if (native && ["waiting", "observing"].includes(native.status)) native.status = "owner_closed";
    };
    const captureNative = async () => {
      if (!native || native.status !== "waiting" || closing) return;
      native.status = "observing"; native.level = "light";
      let handle, traceStarted = false;
      try {
        await nativeCommand("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: {
          recordMode: "recordAsMuchAsPossible", includedCategories: ["disabled-by-default-memory-infra"],
          excludedCategories: ["*"], memoryDumpConfig: { triggers: [] },
        } }); traceStarted = true;
        const dump = await nativeCommand("Tracing.requestMemoryDump", { deterministic: false, levelOfDetail: "light" });
        if (!dump.success) throw new Error("dump_unavailable");
        const ready = new Promise((resolve, reject) => {
          nativeStream = resolve; nativeStreamReject = reject;
          nativeStreamTimer = setTimeout(() => reject(new Error("stream_timeout")), 30_000); nativeStreamTimer.unref?.();
        }); ready.catch(() => {});
        await nativeCommand("Tracing.end"); traceStarted = false; handle = await ready; clearTimeout(nativeStreamTimer);
        const chunks = []; let size = 0;
        for (;;) {
          const part = await nativeCommand("IO.read", { handle, size: 16 * 1024 });
          const chunk = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
          size += chunk.length; native.traceBytesRead = size;
          if (size > NATIVE_TRACE_BYTES) throw new Error("trace_budget_exceeded");
          chunks.push(chunk); if (part.eof) break;
        }
        const processes = summarizeAllocatorTrace(Buffer.concat(chunks).toString("utf8"));
        if (!processes.length) throw new Error("allocator_data_unavailable");
        Object.assign(native, { status: "sampled", level: "light", at: Date.now(), processes });
      } catch (error) {
        if (!closing && !nativeStopped) native.status = error.message === "trace_budget_exceeded" ? "over_budget" : "unavailable";
      } finally {
        clearTimeout(nativeStreamTimer); nativeStream = nativeStreamReject = null;
        if (handle && !closing && !nativeStopped) try { await nativeCommand("IO.close", { handle }); } catch {}
        if (traceStarted && !closing && !nativeStopped) try { await nativeCommand("Tracing.end"); } catch {}
      }
    };
    stopMemory = reason => {
      clearInterval(memoryTimer); clearTimeout(memoryDeadline);
      attachId = heapId = null;
      if (memory && !memory.stopReason) memory.stopReason = reason;
    };
    const command = (id, method, params = {}, sessionId) => {
      input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", error => {
        if (error) stopMemory("pipe_error");
      });
      memoryDeadline = setTimeout(() => {
        if (!closing && memory && !memory.stopReason) memory.status = "unresponsive";
        stopMemory("unresponsive");
      }, 30_000);
      memoryDeadline.unref?.();
    };
    const sampleMemory = () => {
      if (closing || !memorySession || heapId || memory.stopReason) return;
      heapId = nextId++;
      command(heapId, "Runtime.getHeapUsage", {}, memorySession);
    };
    const message = raw => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      const nativeRequest = nativeRequests.get(event.id);
      if (nativeRequest) {
        clearTimeout(nativeRequest.timer); nativeRequests.delete(event.id);
        event.error ? nativeRequest.reject(new Error("protocol_unavailable")) : nativeRequest.resolve(event.result);
      }
      if (event.method === "Tracing.tracingComplete" && typeof event.params?.stream === "string") nativeStream?.(event.params.stream);
      if (event.id === 1) diagnostics.discovery = event.error ? "unsupported" : "enabled";
      if (memory && !closing && !memory.stopReason && attachId && event.id === attachId) {
        clearTimeout(memoryDeadline); attachId = null;
        if (event.error || typeof event.result?.sessionId !== "string" || !event.result.sessionId) {
          memory.status = "unsupported"; stopMemory("attach_unavailable");
        } else {
          memorySession = event.result.sessionId; memory.status = "attached";
          memoryTimer = setInterval(sampleMemory, 10_000); memoryTimer.unref?.(); sampleMemory();
        }
      } else if (memory && !closing && !memory.stopReason && heapId && event.id === heapId && event.sessionId === memorySession) {
        clearTimeout(memoryDeadline); heapId = null;
        const data = event.result;
        if (event.error || !data || ![data.usedSize, data.totalSize].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
          memory.status = "unavailable"; stopMemory("heap_unavailable");
        } else {
          const sample = { at: Date.now() };
          for (const key of ["usedSize", "totalSize", "embedderHeapUsedSize", "backingStorageSize"]) {
            if (typeof data[key] !== "number" || !Number.isFinite(data[key]) || data[key] < 0) continue;
            sample[key] = data[key]; memory.peak[key] = Math.max(memory.peak[key] || 0, data[key]);
          }
          memory.status = "sampled"; memory.sampleCount++; memory.samples.push(sample);
          if (memory.samples.length > 32) memory.samples.shift();
          // 一次真实原生 allocator 样本，补充 heap 无法解释的进程占用；不触发 GC。
          if (memory.sampleCount === 13) captureNative().catch(() => {});
        }
      }
      const info = event.params?.targetInfo;
      if ((event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") && info?.targetId) {
        if (!targets.has(info.targetId) && targets.size >= 128) targets.delete(targets.keys().next().value);
        targets.set(info.targetId, { type: info.type, url: info.url });
        if (memory && !closing && !memory.stopReason && !memoryTarget && info.type === "page" && info.url === memoryUrl) {
          memoryTarget = info.targetId; memory.status = "attaching"; attachId = nextId++;
          command(attachId, "Target.attachToTarget", { targetId: memoryTarget, flatten: true });
        }
      } else if (event.method === "Target.targetDestroyed") {
        targets.delete(event.params?.targetId);
        if (memoryTarget && event.params?.targetId === memoryTarget) stopMemory("target_destroyed");
      }
      else if (event.method === "Target.targetCrashed") {
        const p = event.params;
        if (!p || typeof p.targetId !== "string" || typeof p.status !== "string" || !Number.isInteger(p.errorCode)) return;
        const target = targets.get(p.targetId);
        const crash = { at: Date.now(), targetId: p.targetId, type: target?.type || "unknown", status: p.status.slice(0, 128), errorCode: p.errorCode, ownerClosing: closing };
        diagnostics.targetCrashes.push(crash);
        if (diagnostics.targetCrashes.length > 8) diagnostics.targetCrashes.shift();
        if (p.targetId === memoryTarget) stopMemory("target_crashed");
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
  const clearTimers = () => { clearTimeout(termTimer); clearTimeout(killTimer); stopMemory("process_exit"); stopNativeMemory(); };
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
      stopMemory("owner_closed");
      stopNativeMemory();
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

module.exports = { createBrowserProcess, summarizeAllocatorTrace };
