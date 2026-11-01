# 视频剪辑

[English](README.md)

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

本 fork 产品版本为 **0.1.1**。上游源为 `61bf46babca82214c162c0650e47a81c3530982c`（1.18.0），完整保留历史和 [MIT 许可](LICENSE)，详见[来源与第三方声明](NOTICE.md)。上游 npm/MCP 发布和 Discord 工作流已移除。
