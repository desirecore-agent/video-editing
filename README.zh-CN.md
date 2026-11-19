# 视频剪辑

[English](README.md)

0.1.7 在导出时核验实际素材画面、校验完整工程替换，并增加持续关键词着色及已核连接/MCP 配置辅助命令。合同与示例见[编辑手册](docs/editor-guide.md)。

工作台跟随 DesireCore 设置中选定的界面语言。简体中文和英文可在工作台打开时切换，保留当前页面和草稿。宿主未提供语言时默认显示简体中文，此时可在工作台网址加上 `?lang=en-US` 选择英文。

导出结果成为附件前仍须经过正常授权交付：核对已完成作业和当前受管实例，从其回执导出 URL 下载到智能体已授权工作目录，核验真实文件后附工作目录路径。安装、关联或连接 MCP 不授予应用数据根的附件读取权限。审批或下载失败时保留失败，不改用未授权源路径或旧成片重发。

导出按钮在快照准入前刷新已保存文档和修订，并以该次实际服务文档准入；刷新中发生人工编辑、切换工程或刷新失败时停止准入并保留草稿。参考分析不为持续纯音推定音乐速度；禁用音轨提取也不表示参考没有音轨。提取保留整条音轨，包括人声，不分离音乐与旁白。强制抠像帧等待新遮罩；模型缺失或推理失败在原取帧/导出作业报告 `BACKGROUND_MASK_UNAVAILABLE`，普通预览仍按尽力加载处理。强制 SVG 帧也须等到真实位图，缺少素材、XML 无效或栅格失败报告 SVG_FRAME_UNAVAILABLE，不静默丢弃图形。抠像/键控媒体支持已有 strokeWidth/strokeColor 参数的人物轮廓描边，默认关闭。可选 bgThreshold/bgSoftness 在描边前清理低置信背景残影，GPU/CPU 使用相同 alpha 曲线，参数带 Schema 并在工程准入校验。后台导出浏览器启用 GPU 渲染，使已准备的 chrome-headless-shell 可创建分割所需 WebGL 上下文；模型/WebGL 初始化失败在原作业回报；仍需核验真实画面以发现图形驱动故障。

后台浏览器采用 800×600 的控件视口。Windows 冷启动实测复现硬件视频解码导致 GPU 上下文丢失、人物消失，因此该平台关闭硬件视频解码，GPU/WebGL 图形和抠像仍启用。工程及导出画布仍按已保存尺寸渲染，包括真实 4K，不随控件窗口缩小。软件视频解码可能增加 CPU 开销，仍须检查实际输出。

导出寻帧在发起跳转前登记画面回调，按已观测的源帧区间复用不同输出帧率下的同一画面；时钟回退不用于推算源帧率，避免反复越过正确画面再回跳。

JPEG worker 首次遇到 `EncodingError` 时保留同一帧快照，只尝试一次 CPU 读回，再复用该 CPU 画布。再次失败或其他错误仍使原作业失败，不跳帧或重新渲染。交付回执在 `result.diagnostics.jpegReadbackRecoveries` 记录实际恢复帧编号；验收时须查看成片中这些帧及前后帧。

媒体 Range、静态文件、缩略图和缓存帧共用文件传输生命周期。浏览器中断请求时关闭对应读取流；异步打开或读取失败只使该次传输失败，不再因未处理的流错误终止编辑服务。成功传输的字节和 Range 响应保持原契约。

基于 [FableCut](https://github.com/ronak-create/FableCut) 的 DesireCore 受管应用，保留原非线性时间线、JSON 工程、浏览器合成器、音视频工具、REST API 和 `fablecut_*` MCP 工具。配套智能体为独立 [video-editor](https://github.com/desirecore-agent/video-editor) 仓库中的 **视频剪辑师**。

DesireCore 负责安装、权限、进程生命周期、运行代际与应用数据根。应用关联是入口偏好，不授予工具或文件权限。GUI 与 MCP 通过同一个服务和工程修订编辑；受管 MCP 只能连接当前已核代际，不自启第二个服务。

## 使用与交付

Node 22 及以上复用 DesireCore 已有受管 Node 的 PATH。FFmpeg、ffprobe 与无头浏览器需显式准备到本应用的数据目录，详见[运行与备份合同](desirecore/RUNTIME.md)。材料不携开发机绝对路径或原生二进制。

```sh
node desirecore/setup-runtime.js --data-dir /your/owned/application-data
node desirecore/start.js --data-dir /your/owned/application-data
```

正式安装由 owner 注入 `PORT`、`APP_DATA_DIR` 和真实运行身份，从平台 prepare 返回的固定材料根启动。MCP 使用 `node desirecore/cli.mjs mcp --runtime-file <实际owner响应.json>`；`status` 与 `identity` 使用同一当前代际连接文件。包装器先核自身完整固定材料与 canonical release digest，再核数据根、端口、受管身份及全部代际字段，旧材料不能复用新运行的连接文件。源码帮助与定位不需要服务；它不安装或启动编辑器。

运行 `node desirecore/release.js --output /fresh/material-directory` 生成不可变平台材料。生成器固定明确文件清单，执行默认每文件 32 MiB、总计 128 MiB 的平台预算，并生成 canonical `app-release.json` 与逐文件摘要。测试、用户工程、原生缓存及诊断不进入材料。`npm run check:delivery` 会把真实 npm 包安装到仓库外，再检查启动器、Schema 和编辑手册。

## 编辑与导出合同

[编辑手册](docs/editor-guide.md) 说明保留的时间线与 MCP API。保存比较工程身份与修订，冲突保留界面草稿。GUI Fast、原队列和 MCP 导出把已提交 JSON 与声明本地媒体快照交给原 job owner；多帧率分组完成不会提前结束 aggregate。回执重启后仍可读取为 interrupted，重试须明确发起。同一 job 在编码前登记 session、预检、音频及 single/batch 排他预留的准确临时产物身份；重启只清理已确认登记项，保留已完成和无关文件，清理失败或归属不明（含旧回执和创建后身份未确认的窗口）均明确呈现，不猜测删除；提交结果未知时先查原 job，不能自动重提。

声明且已解析的本地文件逐文件快照，不承诺跨独立文件系统的事务。动态 SVG 依赖、网络资源与 OS 字体没有完整冻结。可选 ASR、MediaPipe 和远程字体可能获取上游资源；应用不默认选择收费 Provider 或模型。原生 GUI 与各 OS 运行行为需要独立验收证据，CI 本身不能证明桌面验收。

## 开发

`npm run test:delivery` 检查打包与运行资产完整性；`npm run test:regression` 以受控并发执行编辑与导出范围回归。CI 执行静态检查、原上游单测、真实包安装与明确的各 OS 资产准备。编辑内核没有 npm 运行时依赖。

本 fork 产品版本为 **0.1.7**。上游源为 `61bf46babca82214c162c0650e47a81c3530982c`（1.18.0），完整保留历史和 [MIT 许可](LICENSE)，详见[来源与第三方声明](NOTICE.md)。上游 npm/MCP 发布和 Discord 工作流已移除。

固定原生资产使用简短的 `r2` 缓存修订。Windows 准备会在创建目录或下载前检查 Chromium 模块与 ICU 路径长度；进程创建使用长路径表达并不能解除浏览器内部的启动限制。旧缓存保留，新修订通过显式准备生成新的回执。
