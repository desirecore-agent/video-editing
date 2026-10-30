# 视频剪辑运行与数据合同

产品名“视频剪辑”，版本 0.1.0。应用定义 UUID `0171a763-ad35-4b94-98b9-204782817b44` 是产品身份，不是安装 ID、Agent ID、owner 或运行代际。入口为 `editor` / `video-editing:editor`。关联智能体“视频剪辑师”在独立仓库，运行身份一律采用实际安装/导入响应。

## 准备与启动

1. 由现有 DesireCore 执行 owner 核准备材料和工具权限，以平台返回的固定材料根作为 cwd。Node 22 及以上复用平台已有受管 Node PATH，不把开发机 Node 路径写进合同。
2. 显式执行 `node desirecore/setup-runtime.js --data-dir <独立应用数据根>`，准备本机固定的 FFmpeg、ffprobe 和 Chrome for Testing headless shell。正式运行 owner 注入的 `APP_DATA_DIR`、`APP_DATA_ROOT` 优先于参数和 `FABLECUT_DATA_DIR`。准备不会安装系统包、改 shell 配置或调用模型。
3. `node desirecore/start.js --data-dir <同一数据根>` 在前台启动原编辑器服务。正式 owner 提供 `PORT` 和实际的 `DESIRECORE_APP_RUNTIME_PROOF`、`DESIRECORE_APP_RELEASE_DIGEST`、`DESIRECORE_APP_SCOPE_ID`、`DESIRECORE_APP_RUNTIME_GENERATION`。不得自制这些值作为平台验证。身份端点 `/api/desirecore/runtime-identity` 仅回显本代实际注入字段；没有平台字段时返回 404。
4. 原服务通过 `.fablecut-service.lockdir/owner.json` 维护真实单 owner。正式 MCP 使用 `node desirecore/cli.mjs mcp --runtime-file <当前owner响应快照.json>`。快照格式为 `schemaVersion:1`、`dataDir`、`port`、`instanceId`、`scopeId`、`runtimeGeneration`、`releaseDigest`；后六项全部来自实际服务/平台响应，不含 proof 或凭据。CLI 先核现有 instance 和 runtime-identity，再向原 MCP 注入同一数据根、端口及四项 `FABLECUT_EXPECTED_*` 比较条件，加载同一已核媒体资产；不自启第二份应用。`status` / `identity` 使用相同 `--runtime-file` 合同，旧代际/另一数据根均拒绝。快照只是连接提示，不是授权或另一套owner账本。 CLI 必须来自同次固定材料根：先读取自身执行根的 `app-release.json`，复用生成器的完整 payload 字节重建与 `app-release-c14n-v1` canonical 算法核对清单，再要求本地 releaseDigest 与快照及 live 服务完全一致；旧材料 A 不能凭当前 B 的连接文件附着。源码 `desirecore/app-release.json` 是草稿，不能替代正式根清单；源码 `--help` 和 Agent 的 source-only `--locate` 不需要服务。此本地核验只证明客户端材料相同，安装和运行权限仍由平台实际 owner 决定。
5. 停止由原 TaskHost/ToolExecutor owner 执行，等待进程和端口真实退出。打开/关闭页面不替代后台生命周期，关联应用不授予文件、模型、MCP 或其他权限。

启动只读取并核验已准备资产，不隐式下载，不静默退回开发机或系统浏览器。缓存缺失/损坏时明确失败，由 owner 显式重新准备。`--data-dir` 必须是本任务可写的独立目录；不得扩大共享父目录权限。

## 各 OS 原生资产

`runtime-assets.json` 是版本、URL、SHA-256、展开入口、许可证和对应源的唯一资产事实源，配套 Draft-07 Schema 为 `runtime-assets.schema.json`。目标为 macOS arm64/x64、Windows x64、Linux x64/arm64；未列架构直接拒绝。该列表描述可交付资产，不表示五种原生 GUI 都已验收。

FFmpeg/ffprobe 来自维护者 ffmpeg-static 的固定发布，按各目标的实际 README 和 LICENSE 记录版本与 source；同一发布 tag 不假设全平台同一 FFmpeg 版本。其 GPL 许可独立于编辑器 MIT。Chrome for Testing 使用 Google 官方固定版本 headless-shell archive，保留 `ABOUT` 与完整 `LICENSE.headless_shell` 第三方声明；CfT 元数据没有发布 SHA-256，因此清单里的 SHA 必须来自对对应固定 URL 完整原字节的核验，不能把 MD5/CRC 当作 SHA。

准备位置为 `<data-root>/runtime/video-editing-<asset-revision>`。下载只写此根下的独占暂存区；逐档核 SHA 后解压，保存清单、完整许可和全部展开文件的 SHA 回执，成功才原子公布缓存。每次启动核对当前固定清单、目标及全部展开文件；准备失败不留下可启动的半份缓存。锁记录真实 PID，结果未知或旧锁须先检查，不自动接管活 owner。

macOS/Linux ZIP 解压使用系统 `unzip`，Windows 使用系统 `tar.exe`；缺少时明确失败，应用不安装系统工具。Linux headless shell 还依赖官方 Chrome 所需的系统图形/字体库；真实发行环境应按系统包管理器满足这些依赖及浏览器 sandbox 前提。CI 的 native dependency fixture 仅核固定资产、版本及无头文档：Linux 一次性探测为适配 runner AppArmor 使用 `--no-sandbox`，明确记录 `appExportVerified:false`、`productionSandboxVerified:false`，不算生产导出或原生 GUI 验收，也不改变应用的生产启动参数。应用不自动运行 sudo、关闭系统权限或改变系统 sandbox。Node 本身保留平台运行时随附的完整许可。

## 材料和数据归属

`node desirecore/release.js --output <新目录>` 只固定材料，不安装、启动或上传应用。单文件最多 32 MiB，总展开最多 128 MiB，最多 2048 个文件。普通源码、UI、Schema、手册和许可入包；`test/`、诊断、用户工程、media、exports、安装依赖、原生缓存、`.mcp.json` 与上游发布元数据不入包。Chromium 不通过拆块或扩大预算塞入材料。`app-release-c14n-v1` 对象键排序、files 按路径排序并排除 releaseDigest，文件列表不自引清单。source 工作树摘要覆盖实际字节，不能用 checkout HEAD 冒充未提交适配的来源。

应用数据格式 `video-editing-home-v1`，由数据根内原 `project.json`、`projects/`、`media/`、`exports/`、`analysis/`、`library/`、导出 job/快照及服务锁等文件承载。材料为不可变源码，工程和媒体为可变业务数据；运行资产是可重建缓存。卸载保留数据，不把卸载等同于清除影片。`dataContract.files=[]` 不授权平台以小文件 API 修改/备份任意影片；大媒体备份走已授权的原文件工具。

## 备份、恢复与升级

正常停止原 owner 并确认无活动编码后，以已授权文件工具备份整个数据根（含工程索引、原媒体、工程 library 和回执），保留相对路径、文件摘要及外部媒体引用。缓存 `runtime/` 可排除但应保留材料版本和资产清单。独立系统盘上的原媒体不在数据根内，须一并备份；工程文件本身不包含它们。

恢复时保持应用停止，把备份还原到新的独立数据根，核文件摘要、媒体引用和格式版本，再显式准备资产并由原 owner 启动。不得把旧 PID、URL、runtime proof、服务锁或旧审批当作当前授权。陈旧锁须核实际进程后由精确 owner 清理。先用测试工程验证读取、保存与导出，再继续编辑。0.1.0 只读写 `video-editing-home-v1`，没有自动迁移、降级或后台续渲染；格式不支持时保持原数据并明确失败。

## 编辑与导出限制

GUI、MCP 同源提交 projectId/baseRevision；冲突保留 UI 草稿。声明本地媒体在原 job 提交时逐文件复制冻结，动态 SVG/网络资源和 OS 字体仍未完整闭包。多帧率 aggregate 由全部组统一终结；取消只归属原编码会话，晚到 begin 仍需清理后返回。回执持久化，重启后原 ID 为 interrupted，不自动续跑。结果未知先查原 job；retry 明确创建新任务。

GUI Fast 与 `fablecut_export` 均由独立的已准备无头浏览器渲染原 job 的冻结输入，不使用可变的当前编辑页。导出的 `where` 省略或为 `auto`、`headless` 时使用这一后台渲染器；显式 `tab` 在捕获快照前返回 409，其它无效值返回 400，不创建快照、作业或浏览器，也不更改工程和媒体。`auto` 不表示优先当前编辑页。此限制仅适用于导出；`fablecut_frame`、`fablecut_scopes`、跟踪和转录等工具各自的 `tab` 合同不变。

原可选 Whisper ASR、MediaPipe、Google Fonts 仍可连接其上游外部资源，模型和动态网络资源不在本原生资产清单内；没有默认收费生成或隐含 Provider。旧 WebCodecs/MediaRecorder UI 实时输出未满足固定输入合同，明确不可用。
