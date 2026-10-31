/* Agent-requested exports (POST /api/export/request, MCP fablecut_export).

   The compositor lives in the browser, so an export job is handed to an
   editor tab: an open one gets it over SSE, otherwise a headless Chrome /
   Edge is started on `/?exportJob=<id>` and closed when the job ends. The tab
   claims the job, renders it with the normal Fast export, and reports
   progress and the finished file back here. A job is
     pending → running → done | failed | cancelled
   and stays readable for an hour after it ends. Zero dependencies. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PENDING_TAB_MS = 20_000;       // an open tab answers SSE within a beat
const PENDING_HEADLESS_MS = 90_000;  // a cold browser has to boot and load media
const STALL_MS = 120_000;            // a running tab reports at least every few seconds
const KEEP_MS = 60 * 60 * 1000;

/** A Chromium-family browser to run headless: FABLECUT_CHROME, else the usual
 *  Chrome / Edge / Chromium install paths for this platform. Null if none. */
function findBrowser(env = process.env) {
  if (env.FABLECUT_CHROME) return fs.existsSync(env.FABLECUT_CHROME) ? env.FABLECUT_CHROME : null;
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(path.join(r, "Chromium", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      const r = spawnSync("which", [name], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
  }
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** opts: {url(id) → page to open headless, broadcast(event, data), editors() → open tab count,
 *  keepProfile(kind) → a browser profile dir that outlives the job (a model cache), or null for a throwaway one} */
function createExportJobs(opts) {
  const jobs = new Map();
  let timer = null;
  const isEnded = (j) => j.status === "done" || j.status === "failed" || j.status === "cancelled" || j.status === "interrupted";
  const view = (j) => ({
    id: j.id, kind: j.kind, status: j.status, via: j.via, range: j.range, profile: j.profile || null, preset: j.delivery ? j.delivery.preset || "custom" : null,
    time: j.time ?? null, progress: j.progress, src: j.src || null, result: j.result || null, error: j.error || null,
    snapshot: j.snapshot || null, cleanup: j.cleanup || null,
    created: j.created, updated: j.updated,
  });

  function persist(j) {
    if (!opts.storeDir) return;
    fs.mkdirSync(opts.storeDir, {recursive:true});
    const file=path.join(opts.storeDir,j.id+".json"), tmp=file+".tmp";
    fs.writeFileSync(tmp,JSON.stringify({...j,browser:undefined}),{flush:true});fs.renameSync(tmp,file);
  }
  // Original job facts, not a second job store. Intents precede exclusive creation;
  // only a subsequently persisted nonzero file identity permits restart deletion.
  const identity = stat => stat.dev > 0n && stat.ino > 0n && stat.birthtimeNs > 0n
    ? {dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)} : null;
  const sameIdentity = (a,b) => a && b && a.dev===b.dev && a.ino===b.ino && a.birthtimeNs===b.birthtimeNs;
  function artifactChecks(records) {
    if(process.platform!=="win32"||!records.length)return null;
    if(!opts.dataRoot||!opts.artifactRoot||path.relative(path.resolve(opts.dataRoot),path.resolve(opts.artifactRoot))!=="exports")throw Error("export artifact ownership root is unavailable");
    const root=path.join(fs.realpathSync(opts.dataRoot),"exports"), paths=new Set([root]);
    for(const record of records){const rel=record.path;if(typeof rel!=="string"||!rel||/[\\\0:?#]/.test(rel)||rel.split("/").some(p=>!p||p==="."||p===".."))continue;
      let current=root;for(const segment of rel.split("/")){current=path.join(current,segment);paths.add(current);}}
    if(paths.size>4096)throw Error("export artifact attribute batch exceeds its bounded budget");
    // One synchronous operation-local native query, never one process per
    // record/ancestor and never cached across an await or another cleanup.
    // Windows PowerShell 5 emits a JSON array as one pipeline value. Assign
    // that array directly: @(... | ConvertFrom-Json) would nest it and make
    // Get-Item query several paths in one iteration, losing per-path results.
    // A missing literal containing [] can emit no item without an error in
    // PowerShell 5. It is unconfirmed, never a successful non-reparse result.
    const names=[...paths],script='$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.Encoding]::UTF8; $paths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $result=@(foreach($p in $paths){try{$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; if($null -eq $item){-1}else{if($item -isnot [IO.FileSystemInfo] -or $null -eq $item.Attributes){throw "export artifact attributes are unconfirmed"}; $a=$item.Attributes; [int](($a -band [IO.FileAttributes]::ReparsePoint) -ne 0)}}catch{if($_.CategoryInfo.Category -eq "ObjectNotFound"){-1}else{throw}}}); [Console]::Write((ConvertTo-Json -InputObject $result -Compress))';
    const probe=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{input:JSON.stringify(names),encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:1024*1024});
    if(probe.error||probe.status!==0)throw Error("export artifact reparse status is unsafe or unconfirmed");
    let flags;try{flags=JSON.parse(probe.stdout);}catch{throw Error("export artifact attribute batch is invalid");}
    if(!Array.isArray(flags)||flags.length!==names.length||flags.some(v=>![-1,0,1].includes(v)))throw Error("export artifact attribute batch is incomplete");
    return new Map(names.map((name,i)=>[name,flags[i]]));
  }
  function artifactStat(file,checks) {
    const stat=fs.lstatSync(file,{bigint:true});
    if(stat.isSymbolicLink())throw Error("export artifact is linked");
    if(process.platform==="win32"&&checks?.get(file)!==0)throw Error("export artifact reparse status is unsafe or unconfirmed");
    return stat;
  }
  function artifactBase(checks) {
    if (!opts.dataRoot || !opts.artifactRoot) throw Error("export artifact ownership root is unavailable");
    const data=fs.realpathSync(opts.dataRoot), relative=path.relative(path.resolve(opts.dataRoot),path.resolve(opts.artifactRoot));
    if(relative!=="exports")throw Error("export artifacts must stay in the owned data exports root");
    const root=path.join(data,relative), stat=artifactStat(root,checks);
    if(stat.isSymbolicLink()||!stat.isDirectory()||fs.realpathSync(root)!==root)throw Error("export artifact root is linked or not a directory");
    return {root,identity:identity(stat)};
  }
  function artifactPath(j,record,allowMissing=false,checks) {
    const base=artifactBase(checks), rel=record.path;
    if(!sameIdentity(j.artifacts.rootIdentity,base.identity))throw Error("export artifact root identity changed or is unconfirmed");
    if(typeof rel!=="string"||!rel||/[\\\0:?#]/.test(rel)||rel.split("/").some(p=>!p||p==="."||p===".."))throw Error("invalid export artifact path");
    if(typeof record.sessionId!=="string"||!/^[a-z0-9-]+$/.test(record.sessionId))throw Error("invalid export artifact session");
    const segments=rel.split("/"), name=segments[0];
    if(record.kind==="directory") {
      if(segments.length!==1||!name.startsWith("fablecut-"+record.sessionId+"-"))throw Error("artifact is not this session's temporary directory");
    } else if(record.kind==="part") {
      if(segments.length!==1||!/^.+\.part\.[a-z0-9]+$/i.test(name))throw Error("artifact is not a reserved partial output");
    } else if(record.kind==="temp-file") {
      if(segments.length!==2||!j.artifacts.entries.some(e=>e.sessionId===record.sessionId&&e.kind==="directory"&&e.path===name&&e.state==="owned"))throw Error("temporary file has no owned session directory");
    } else throw Error("invalid export artifact kind");
    let current=base.root;
    for(const segment of segments.slice(0,-1)) {
      current=path.join(current,segment);
      let stat;try{stat=artifactStat(current,checks);}catch(e){if(allowMissing&&e.code==="ENOENT")return path.join(base.root,...segments);throw e;}
      if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(current)!==current)throw Error("export artifact ancestor is linked or changed");
      const parent=j.artifacts.entries.find(e=>e.sessionId===record.sessionId&&e.kind==="directory"&&e.path===segment);
      if(!parent||!sameIdentity(parent.identity,identity(stat)))throw Error("export artifact directory identity changed");
    }
    return path.join(base.root,...segments);
  }
  function cleanupSummary(entries) {
    const retained=entries.filter(e=>e.state!=="removed");
    const errors=retained.filter(e=>e.error).map(e=>e.error);
    const failed=retained.some(e=>e.state==="owned"&&e.error);
    const unknown=retained.some(e=>e.state!=="owned");
    return{status:failed?"failed":unknown?"unknown":retained.length?"pending":"complete",removed:entries.length-retained.length,retained:retained.length,errors};
  }
  function persistCleanup(j) {
    try{persist(j);return true;}catch(e){
      const summary=Array.isArray(j.artifacts?.entries)?cleanupSummary(j.artifacts.entries.filter(e=>e&&typeof e==="object")):{removed:0,retained:0,errors:[]};
      j.cleanup={...summary,status:"failed",errors:[...summary.errors,"cleanup receipt persistence failed: "+String(e.code||e.message)]};
      return false;
    }
  }
  function cleanupArtifacts(j,sessionId,encoderConfirmed=true,operationChecks) {
    if(j.status==="done")return j.cleanup||{status:"not-needed",removed:0,retained:0,errors:[]};
    const facts=j.artifacts;
    if(!facts||facts.schemaVersion!==1||facts.jobId!==j.id||!Array.isArray(facts.entries)||facts.entries.some(e=>!e||typeof e!=="object")) {
      j.cleanup={status:"unknown",removed:0,retained:0,errors:["original job has no confirmed artifact ownership facts"]};persistCleanup(j);return j.cleanup;
    }
    const entries=facts.entries.filter(e=>!sessionId||e.sessionId===sessionId);
    if(!Array.isArray(facts.stoppedSessions))facts.stoppedSessions=[];
    if(sessionId){facts.stoppedSessions=facts.stoppedSessions.filter(id=>id!==sessionId);if(encoderConfirmed)facts.stoppedSessions.push(sessionId);}
    if(!encoderConfirmed){for(const record of entries)if(record.state!=="removed")record.error="encoder termination unconfirmed; retained";j.cleanup=cleanupSummary(facts.entries);if(!persistCleanup(j))return j.cleanup;return cleanupSummary(entries);}
    let checks;
    try{checks=operationChecks||artifactChecks(entries.filter(e=>e.state!=="removed"));}catch(e){for(const record of entries)if(record.state!=="removed")record.error=String(e.message);j.cleanup=cleanupSummary(facts.entries);persistCleanup(j);return j.cleanup;}
    // Files first; directories are removed only when empty, never recursively.
    for(const record of [...entries].sort((a,b)=>(a.kind==="directory")-(b.kind==="directory"))) {
      if(record.state==="removed")continue;
      try {
        const file=artifactPath(j,record,true,checks);let stat;
        try{stat=artifactStat(file,checks);}catch(e){if(e.code!=="ENOENT")throw e;}
        if(!stat){record.state="removed";delete record.error;if(!persistCleanup(j))return j.cleanup;continue;}
        if(record.state!=="owned"||!record.identity){record.error="creation was not durably confirmed; retained";continue;}
        if(stat.isSymbolicLink()||fs.realpathSync(file)!==file||!(record.kind==="directory"?stat.isDirectory():stat.isFile())
          || !sameIdentity(record.identity,identity(stat))||(record.kind!=="directory"&&stat.nlink!==1n))throw Error("artifact is linked, replaced or has an unconfirmed identity");
        if(record.kind==="directory")fs.rmdirSync(file);else fs.unlinkSync(file);
        record.state="removed";delete record.error;if(!persistCleanup(j))return j.cleanup;
      } catch(e){record.error=String(e.code||e.message);}
    }
    const result=cleanupSummary(entries);
    j.cleanup=cleanupSummary(facts.entries);if(!persistCleanup(j))return j.cleanup;return result;
  }
  function createArtifact(id,sessionId,file,kind) {
    const j=jobs.get(id);
    if(!j||j.status!=="running")throw Object.assign(Error("original export job ended while encoder setup was pending"),{code:409});
    const relative=path.relative(path.resolve(opts.artifactRoot),path.resolve(file)).split(path.sep).join("/");
    const checks=artifactChecks([{path:relative}]), base=artifactBase(checks);
    if(!j.artifacts)j.artifacts={schemaVersion:1,jobId:j.id,rootIdentity:base.identity,entries:[]};
    if(!j.artifacts.rootIdentity)j.artifacts.rootIdentity=base.identity;
    const record={sessionId,path:relative,kind,state:"planned"};
    const canonical=artifactPath(j,record,false,checks);
    if(Array.isArray(j.artifacts.stoppedSessions))j.artifacts.stoppedSessions=j.artifacts.stoppedSessions.filter(id=>id!==sessionId);
    j.artifacts.entries.push(record);persist(j); // crash before/after create remains explicit, never guessed owned
    let fd;
    try {
      if(kind==="directory")fs.mkdirSync(canonical,{mode:0o700});else fd=fs.openSync(canonical,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0),0o600);
      const stat=fd===undefined?fs.lstatSync(canonical,{bigint:true}):fs.fstatSync(fd,{bigint:true});
      record.identity=identity(stat);record.state=record.identity?"owned":"unconfirmed";
      if(!record.identity)record.error="filesystem identity unavailable; recovery cleanup is unknown";
      persist(j);j.cleanup=null;
    }catch(e){
      // EEXIST is a collision, never a claim. A create that succeeded but failed
      // to persist keeps its prior intent; it cannot be silently called clean.
      if(e.code==="EEXIST"){j.artifacts.entries.splice(j.artifacts.entries.indexOf(record),1);persist(j);}
      throw e;
    }finally{if(fd!==undefined)fs.closeSync(fd);}
    return canonical;
  }
  function writeArtifact(id,sessionId,file,body) {
    const j=jobs.get(id);
    if(!j||j.status!=="running")throw Object.assign(Error("original export job ended before artifact write"),{code:409});
    const relative=path.relative(path.resolve(opts.artifactRoot),path.resolve(file)).split(path.sep).join("/");
    const record=j.artifacts?.entries.find(e=>e.sessionId===sessionId&&e.path===relative&&e.kind==="temp-file"&&e.state==="owned");
    if(!record)throw Error("artifact write has no confirmed original job ownership");
    const checks=artifactChecks([record]);
    const canonical=artifactPath(j,record,false,checks), before=artifactStat(canonical,checks);
    if(!before.isFile()||before.nlink!==1n||!sameIdentity(record.identity,identity(before)))throw Error("artifact write target is linked or replaced");
    const fd=fs.openSync(canonical,fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0));
    try {
      const stat=fs.fstatSync(fd,{bigint:true});
      if(!stat.isFile()||stat.nlink!==1n||!sameIdentity(record.identity,identity(stat)))throw Error("artifact write target changed before open");
      fs.ftruncateSync(fd,0);fs.writeFileSync(fd,body);
    }finally{fs.closeSync(fd);}
  }
  if (opts.storeDir && fs.existsSync(opts.storeDir)) for (const file of fs.readdirSync(opts.storeDir)) {
    if (!/^x_[a-z0-9]+\.json$/.test(file)) continue;
    try { const j=JSON.parse(fs.readFileSync(path.join(opts.storeDir,file),"utf8"));
      if(j.id+".json"!==file)throw Error("original job identity does not match its receipt");
      if (!isEnded(j)) Object.assign(j,{status:"interrupted",error:"server restarted; original job retained, no automatic re-render",updated:Date.now()});
      jobs.set(j.id,j);persist(j);
    } catch(e) { throw new Error("cannot restore export receipt "+file+": "+e.message); }
  }
  const restoring=[...jobs.values()].filter(j=>["interrupted","failed","cancelled"].includes(j.status));
  let recoveryChecks;
  try{recoveryChecks=artifactChecks(restoring.flatMap(j=>Array.isArray(j.artifacts?.entries)?j.artifacts.entries.filter(e=>e&&typeof e==="object"&&e.state!=="removed"):[]));}
  catch(e){recoveryChecks={error:String(e.message)};}
  for(const j of restoring){
    if(recoveryChecks?.error&&Array.isArray(j.artifacts?.entries)&&j.artifacts.entries.every(e=>e&&typeof e==="object")&&j.artifacts.entries.some(e=>e.state!=="removed")){for(const e of j.artifacts.entries)if(e.state!=="removed")e.error=recoveryChecks.error;j.cleanup=cleanupSummary(j.artifacts.entries);persistCleanup(j);}
    else cleanupArtifacts(j,undefined,true,recoveryChecks);
  }
  function closeBrowser(j) {
    const b = j.browser;
    if (!b) return;
    j.browser = null;
    try { b.proc.kill(); } catch {}
    if (b.keep) return;
    // The profile dir is locked until the browser exits.
    const rm = (n) => fs.rm(b.profileDir, { recursive: true, force: true }, (err) => {
      if (err && n > 0) setTimeout(() => rm(n - 1), 1000);
    });
    b.proc.once("exit", () => rm(5));
    setTimeout(() => rm(5), 3000);
  }
  function end(j, status, fields = {}) {
    if (isEnded(j)) return;
    Object.assign(j, fields, { status, updated: Date.now() });
    persist(j);
    closeBrowser(j);
  }
  function sweep() {
    const now = Date.now();
    for (const j of jobs.values()) {
      if (j.status === "pending" && now - j.created > (j.via === "headless" ? PENDING_HEADLESS_MS : PENDING_TAB_MS))
        end(j, "failed", { error: j.via === "headless"
          ? "the headless browser never picked up the job (it may have failed to start or to load the editor)"
          : "no editor tab picked up the job — is it busy exporting? Retry with where:\"headless\"" });
      else if (j.status === "running" && now - j.updated > STALL_MS)
        end(j, "failed", { error: "the editor stopped reporting progress (tab closed or browser crashed)" });
      else if (isEnded(j) && now - j.updated > KEEP_MS) jobs.delete(j.id);
    }
    if (![...jobs.values()].some((j) => !isEnded(j)) && timer) { clearInterval(timer); timer = null; }
  }
  function launch(j) {
    const exe = findBrowser();
    if (!exe) throw Object.assign(new Error("没有可用的后台导出浏览器；请通过视频剪辑运行时准备 Chromium，" +
      "或为独立运行设置 FABLECUT_CHROME"), { code: 409 });
    const kept = opts.keepProfile ? opts.keepProfile(j.kind) : null;
    if (kept) fs.mkdirSync(kept, { recursive: true });
    const profileDir = kept || fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-export-"));
    const proc = spawn(exe, [
      "--headless=new", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows", "--window-size=1600,900",
      opts.url(j.id),
    ], { stdio: "ignore", windowsHide: true });
    j.browser = { proc, profileDir, keep: !!kept };
    proc.on("error", (e) => end(j, "failed", { error: "could not start the headless browser: " + e.message }));
    proc.on("exit", () => { if (j.browser) { j.browser = null; if (!isEnded(j)) end(j, "failed", { error: "the headless browser exited before the export finished" }); } });
  }

  return {
    /** Queue an export. where: auto (open tab, else headless) · tab · headless.
     *  kind "scopes" measures one still at `time` instead (fablecut_scopes);
     *  kind "track" follows a region of a clip and saves it (fablecut_track);
     *  kind "transcribe" turns files' speech into words and saves them (fablecut_transcribe).
     *  A scopes job's `image` flag also returns that still as a JPEG data URL,
     *  which is how fablecut_frame shows an agent the composed program picture. */
    request({ kind = "export", range, profile, delivery = null, deliveries = null, time, revision, where = "auto", matte = null, mask = null, track = null, transcribe = null, image = false, snapshot = null }) {
      if (!["auto", "tab", "headless"].includes(where)) throw Object.assign(new Error("where must be auto, tab or headless"), { code: 400 });
      if (!["export", "scopes", "track", "transcribe"].includes(kind)) throw Object.assign(new Error("kind must be export, scopes, track or transcribe"), { code: 400 });
      if (time != null && !(Number.isFinite(time) && time >= 0)) throw Object.assign(new Error("time must be seconds ≥ 0"), { code: 400 });
      if (range != null && range !== "entire" && range !== "in-out") throw Object.assign(new Error("range must be \"entire\" or \"in-out\""), { code: 400 });
      const busy = [...jobs.values()].find((j) => !isEnded(j));
      if (busy) throw Object.assign(new Error(`${busy.kind === "scopes" ? "scope reading" : busy.kind === "track" ? "tracking job" : busy.kind === "transcribe" ? "transcription" : "export"} ${busy.id} is still ${busy.status} — wait for it, or cancel it`), { code: 409 });
      const tabs = opts.editors();
      if (where === "tab" && !tabs) throw Object.assign(new Error("no editor tab is open — open the editor, or use where:\"headless\""), { code: 409 });
      const now = Date.now();
      const j = {
        id: "x_" + Math.random().toString(36).slice(2, 10), kind, status: "pending", progress: 0, snapshot,
        range: range || null, profile: profile || null, delivery: kind === "export" && delivery ? delivery : null,
        deliveries: kind === "export" && Array.isArray(deliveries) && deliveries.length ? deliveries : null, time: time ?? null, revision: Number.isFinite(revision) ? revision : null,
        matte: kind === "scopes" && matte ? { clip: String(matte.clip), layer: matte.layer } : null,
        mask: kind === "scopes" && mask ? { clip: String(mask.clip) } : null,
        track: kind === "track" && track ? track : null,
        transcribe: kind === "transcribe" && transcribe ? transcribe : null,
        image: kind === "scopes" && !!image,
        via: where === "headless" || (where === "auto" && !tabs) ? "headless" : "tab",
        created: now, updated: now,
        artifacts: {schemaVersion:1,jobId:null,rootIdentity:null,entries:[]},
      };
      j.artifacts.jobId=j.id;
      if (j.via === "headless") (opts.launchBrowser || launch)(j);
      jobs.set(j.id, j);
      persist(j);
      if (j.via === "tab") opts.broadcast("export", JSON.stringify(this.ticket(j.id)));
      if (!timer) { timer = setInterval(sweep, 1000); timer.unref?.(); }
      return view(j);
    },
    get(id) { const j = jobs.get(id); return j ? view(j) : null; },
    createArtifact, writeArtifact,
    cleanupState(id) {
      const j=jobs.get(id), facts=j?.artifacts;
      if(!facts||facts.schemaVersion!==1||facts.jobId!==id||!Array.isArray(facts.entries)||facts.entries.some(e=>!e||typeof e!=="object"))return{encoderConfirmed:false,encoderTermination:"unconfirmed",cleanup:{status:"unknown",removed:0,retained:0,errors:["original job has no confirmed artifact ownership facts"]}};
      const encoderConfirmed=facts.entries.every(e=>facts.stoppedSessions?.includes(e.sessionId));
      return{encoderConfirmed,encoderTermination:!facts.entries.length?"not-started":encoderConfirmed?"confirmed":"unconfirmed",cleanup:j.cleanup||cleanupSummary(facts.entries)};
    },
    cleanupArtifacts(id,sessionId,encoderConfirmed=true) {const j=jobs.get(id);return j?cleanupArtifacts(j,sessionId,encoderConfirmed):{status:"unknown",removed:0,retained:0,errors:["original job not found"]};},
    /** What a tab needs to run the job (headless pages fetch it by id). */
    ticket(id) { const j = jobs.get(id); return j ? { id: j.id, kind: j.kind, range: j.range, profile: j.profile, delivery: j.delivery || null, deliveries: j.deliveries || null, time: j.time, revision: j.revision, matte: j.matte || null, mask: j.mask || null, track: j.track || null, transcribe: j.transcribe || null, image: !!j.image, status: j.status, snapshot: j.snapshot || null } : null; },
    /** First tab to claim a pending job runs it. */
    claim(id) {
      const j = jobs.get(id);
      if (!j || j.status !== "pending") return false;
      j.status = "running"; j.updated = Date.now();
      persist(j);
      return true;
    },
    /** Progress / result from the running tab. Returns {cancel} so a cancel reaches it. */
    report(id, { progress, status, src, result, error } = {}) {
      const j = jobs.get(id);
      if (!j) return null;
      if (j.status === "cancelled") return { cancel: true };
      if (j.status !== "running") return { cancel: false };
      j.updated = Date.now();
      if (Number.isFinite(progress)) j.progress = Math.max(0, Math.min(1, progress));
      if (status === "done") end(j, "done", { progress: 1, src: String(src || ""), result: result && typeof result === "object" ? result : null });
      else if (status === "failed") end(j, "failed", { error: String(error || "export failed") });
      persist(j);
      return { cancel: false };
    },
    cancel(id) {
      const j = jobs.get(id);
      if (!j) return null;
      // A running tab hears about it on its next report and stops; pending just ends.
      if (!isEnded(j)) end(j,"cancelled",{error:"cancelled"});
      // A repeated cancel may join/retry the same original session cleanup;
      // it never creates another job or reclassifies an unconfirmed encoder.
      if(j.status!=="done")opts.onCancel?.(id);
      return view(j);
    },
    shutdown() { for (const j of jobs.values()) { if (!isEnded(j)) end(j,"interrupted",{error:"server stopped; original job retained, explicit retry required"}); else closeBrowser(j); } if (timer) clearInterval(timer); },
  };
}

module.exports = { createExportJobs, findBrowser };
