# Cyrene 前端实施任务清单与进度跟踪

**文档状态：** 维护中（项目当前状态的唯一事实源）
**最后核验：** 2026-09-11
**适用阶段：** 阶段 0～8
**权威范围：** 当前阶段、完成状态、阻塞项、最近验证和下一步；任务定义与阶段门槛分别以 doc 10、doc 12 为准

---

## 1. 当前结论

- 阶段 1～7 已完成开发与真实 Windows Electron 联调。
- 阶段 1～7 修缮批次已完成并通过真实前后端复核。
- 阶段 8 尚未进入，当前状态为 **暂缓**。
- 独立新批次：**多角色 Stage H 已完成前后端实现、契约对齐并通过最终真实 Windows Electron 联调，现已正式闭账**。最终功能基线为前端 `d02ce15`、后端 `7d2e2b31`（运行版本 `0.1.0+7d2e2b3`）；详见 [最终真实联调验收](review/2026-09-10-多角色Stage-H最终真实联调验收.md)。
- 旧数据决策：开发阶段不做旧会话/角色/缓存迁移，联调前直接清理开发数据；协议降级与缺字段守卫仍保留。详见 [决策记录](review/2026-09-08-多角色旧数据不迁移决策记录.md)。
- 最终复验使用隔离 Electron appData 和正式 Stage H fixture；Definition 通过公开 API 推进，未手工修补数据库。后端停机后执行正式 cleanup，二次清理全零，冷启动目录、会话与实例均无 fixture 残留。
- 验收后热修：Stage H 闭账后发现角色绑定会话首条消息渲染崩溃（`DataCloneError` 导致消息列表坍缩），已由前端 `2b31719` 修复并通过本地门禁；Stage H 功能基线（`d02ce15`）与验收结论不变，该提交的真机端到端复验仍待执行。详见 [验收后热修记录](review/2026-09-10-多角色Stage-H验收后热修-角色revision渲染崩溃.md)。
- README、CLAUDE.md、doc 10 和 doc 12 不再复制本节的实时状态。
- 门禁体系整改（2026-09-10）：评估发现自动门禁长期失效——CI 自 2026-08-16 起未再绿过，`verify:sensitive` 全红、`check:contract` 空转通过，且 `DataCloneError` 真机崩溃信号已在 CI 日志中连续出现 4 天而无人查看。本轮已完成整改，门禁健康记录见 §3.1，完整证据与残余风险见[门禁体系评估与整改记录](review/2026-09-10-前端门禁体系评估与整改记录.md)。第三方资产授权另立阻塞项 `EXT-01`，见 [决策记录](review/2026-09-10-第三方资产授权与来源立为阻塞项-决策记录.md)。
- 门禁整改轮暴露的三项产品缺陷与集成偶发根因已处置（2026-09-10，`f462edd`／`2c1f34c`）：① 角色编辑器清空「主动间隔」会使保存被原生约束**静默拦截**（无反应、零提示、内容未保存）——现回退 3600 并由表单自查后就地解释原因；② 附件媒体「字节完好但本机解不开」时占位永不出现、元素静默损坏——现把渲染失败与附件状态分开表达并给出可重试占位；③ 集成套件被中断后遗留的测试应用跨运行争抢 CPU/GPU 导致 Live2D spec 偶发超时——现由 `globalSetup` 在套件启动时按进程树回收（真机端到端 20 → 0 进程）。决策与验证见[修复决策记录](review/2026-09-10-三项产品缺陷与集成孤儿进程修复-决策记录.md)。
- **Live2D「模型加载失败」根因定位并修复（2026-09-10）**：上一批交付的诊断态首次把真实原因显示出来——「原因：Failed to fetch」与「已发现 3 个模型，其中可用 3 个」并列。
- 根因是 **dev 形态模型文件供给跨源被拒**：模型文件只在 `cyrene://` 上供给，而 `pnpm dev` 页面在 `http://localhost:<port>`，`cyrene` scheme 恒为 `corsEnabled:false`（阶段 5 D-4 安全结论），跨源 `fetch` 被 Chromium 拒绝；清单走 invoke 通道不受影响，故两者并不矛盾。
- 该限制自阶段 5 起记录在案（F-后续-2）但从未修复，且**集成测试全部运行 prod 形态**（`helpers/app.ts` 无条件删除 `ELECTRON_RENDERER_URL`），因此没有任何测试覆盖 dev 形态。
- 修法为 dev 下经 IPC 供给字节（不放开 `corsEnabled`、不起本地 HTTP），闸门与协议通道共用新增的 `src/main/live2d/serve-gate.ts`。真机 dev 形态探针 8/8 通过（`Live2D 就绪 · Wanko`），禁用修复后探针**复现用户现象且文案逐字一致**。详见[根因定位与修复记录](review/2026-09-10-dev形态Live2D资源跨源失败修复-决策记录.md)。
- 同轮修复的文档回归：上一批我曾把 doc 17 §4.1 里**正确**的 `corsEnabled:false` 限制说明判为「未经实测的强断言」而删除——判断错误，依据是一条与实现不符的 dev CSP 注释。doc 17 §4.1 与 README 已按实测结论改写，dev CSP 中因此长期冗余的 `connect-src cyrene:` 已移除。
- **全量前端评审批次（2026-09-11，未改任何业务代码）**：[评审报告](review/2026-09-11-full-frontend-review.md) 覆盖 `src/{main,preload,renderer,shared}`、`tests/`、`scripts/`、构建与 CI 配置及 `docs/`，结论为 0 Critical / 12 High / 40 Medium / 33 Low。该报告自行**证伪**了两条 High 级 Subagent 结论与一条任务书假设（本轮复核：证伪正确）。
- 该报告是**问题目录**而非工作队列：Medium/Low 多数自陈「今日不可达」或属一致性/整洁度，不应作为勾选清单使用。报告建议的 P0 批次**尚未开始**；已先处置 UI 改版引入的三条回归，见下与 §5。
- 本轮复核（逐处读码，非采信结论）确认机制成立的条目：H-01（`upload-service.ts:143` 唯一边界是 userData **一个目录**，`isPathBlacklisted` 在附件链 0 次调用）、H-02、H-03、H-04（`flush` 全仓仅 2 个调用点）、H-10（`message.store.ts` 无任何定时器）、H-11b、H-12、M-08、M-20、M-27、M-30、M-35。
- H-02 复核补充：`onRowResized` 在内容增长时只写 `heights`，不动 `scrollTop`/`atBottom`；且因 `atBottom` 仍为 `true`，`v-if="!atBottom"` 的「回到底部」按钮**也不出现**——用户连手动找回的入口都没有，比报告描述的更严重。
- **报告 §11 R-09 结论已纠正（2026-09-11）**：该报告称本机 `pnpm test:integration`「22 文件全红（81 failed / 12 passed / 47 skipped）」。本轮独立重跑**不可复现**：单文件 `ipc-security.spec.ts` 18/18 通过，全套 **22 files / 138 passed + 2 skipped，exit 0**（227s），与 2026-09-10 批次数字一致；重跑前本机无残留 Electron 进程、无 `cy-int-ud-*` 目录。
- R-09 定性（**2026-09-11 补正**）：该次全红是**运行环境态**，非产品缺陷、非门禁失效，「非产品缺陷」的方向判断成立。但原措辞「不可复现」过强——其描述的症状**间歇可复现**：本地单独运行 `audit-lifecycle.spec.ts` 曾 4/4 失败于 `electron.launch: Process failed to launch!`（debugger 连上后 1006 断开）；`ee8f7fa` 那次 CI 红是该文件 `expect.poll(timeout:5000)` 等不到 `credential:set` 落盘，`gh run rerun --failed` 后转绿。故全套可绿（已两次实测），但此类中断会偶发。
- 报告最值得保留的两条结构性判断（已复核属实）：① **收口点是路由点而非策略点**——`registerHandler` 只校验来源与参数个数、`createIpcHandler` 只校验形状，故 `MAX_IPC_MESSAGE_BYTES` 只在 1 条通道真正执行、`PATH_BLACKLIST_DEFAULTS` 在附件链 0 次调用，H-01 与 M-03 是同一根因的两个实例；
- ② **测试保护了 bug**——`debounce-trailing.spec.ts:11-13` 把防抖（而非节流）语义钉成了正确行为，这是 H-03 能在 214 个测试文件下长期存活的原因。建议把「这条断言在实现坏掉时会红吗」列入评审清单项，这比修单个缺陷更能防止下一批同类问题。
- **UI 改版后的复评（2026-09-11）**：用户 UI 批次 `034c110`／`85f2602`／`116d529` 落地后按 HEAD 重核报告 UI 条目。已改善：M-20 部分修复（`CyChatInput` 4 处、`CyNavRail` 1 处的 `--cy-accent` 文本误用已清除）。逐处读码确认**仍在**：H-02（不跟随底部且不可复制）、M-19、M-21、M-22、M-23、M-24。
- 复评发现该 UI 批次**新引入三条**，本批已修：① `--cy-accent` 被调浅（`#dce8ff`→`#e7edff`），使安全授权按钮文本对比度由 1.23:1 **降到 1.17:1**（暗色 1.31:1）——改用配对文字色 `--cy-accent-text`（11.0:1／13.1:1）并按规则级加守护断言；② 主题背景用 `@media (prefers-color-scheme: dark)` 切换、而全仓其它颜色用 `light-dark()`，应用内主题落地时会出现「token 翻了、背景图没翻」——补根节点 `data-theme` 覆盖路径并与 `color-scheme` 同步；③ 装饰图 `cyrene-deco-voice-wave.png` 为 1024×768／496 KB，而实际渲染宽度 ≤280px——按 2× 出图改**无损** webp（106,918 B，−78%）。
- 三条修复均过**变异验证**：还原文本色→授权按钮断言红；去掉 `:not([data-theme='light'])`→主题断言红；再单独去掉 `color-scheme: dark`→另一条红；放回 PNG→回退断言红；把 webp 换成 444 KB→尺寸上限断言红。装饰图保真度用客观指标核验（alpha 通道逐位相同；白底／黑底合成后 PSNR 69.1／68.5 dB，差异在 ±1/255 内）。
- 复评另记两条**治理问题（未处置）**：① `85f2602` 的 check-runs 数为 **0**——该 UI 大改从未被 CI 验证（本轮本地补齐门禁为绿；`116d529` 的 CI 以它为祖先一并覆盖）；② `ui/设计风格.md`（1349 行）落在 `docs/` 治理体系之外，`docs:check` 与 doc 00 均不覆盖，且已在响应式口径上与 doc 03 冲突（其 §35 仅列 1366+ 桌面档）。

阶段 8 暂缓的正式依据见 [阶段 8 暂缓决策记录](review/2026-08-29-阶段8暂缓决策记录.md)。

## 2. 阶段状态

| 阶段 | 范围 | 当前状态 | 主要证据 |
|---|---|---|---|
| 0 | 工程、协议与协作基线 | 已完成 | [历史进度归档](review/2026-08-29-doc16实施进度历史归档.md) |
| 1 | Electron 安全骨架 | 已完成并经后续真机复核 | [阶段 1～7 修缮真实联调](review/2026-08-28-阶段1-7修缮批次-真实联调验收.md) |
| 2 | 核心聊天纵向闭环 | 已真实联调 | [历史进度归档](review/2026-08-29-doc16实施进度历史归档.md) |
| 3 | 完整聊天、历史与多媒体 | 已真实联调 | [阶段 3 验收](review/2026-08-15-阶段3真实联调通过-验收记录.md) |
| 4 | 模型服务与语音 | 已真实联调 | [阶段 4 验收](review/2026-08-17-阶段4修复后真实联调验收.md) |
| 5 | Live2D | 已真实联调 | [阶段 5 验收](review/2026-08-19-阶段5-Live2D真实联调验收.md) |
| 6 | 工具、权限与 Desktop P0 | 已真实联调 | [阶段 6 验收](review/2026-08-21-阶段6-真实联调验收.md) |
| 7 | 安全、稳定性与性能收敛 | 已真实联调并收口 | [批次 D 验收](review/2026-08-28-阶段7批次D-真实联调验收.md) |
| H | 多角色、UserIdentity、自定义角色与角色状态 | 已完成并通过真实 Windows Electron 联调 | [最终真实联调验收](review/2026-09-10-多角色Stage-H最终真实联调验收.md) |
| 8 | 打包、跨平台与 Demo 验收 | 暂缓，尚未进入 | [暂缓决策](review/2026-08-29-阶段8暂缓决策记录.md) |

“已真实联调”表示对应范围已由真实后端和真实 Electron 运行证据验证；它不表示阶段 8 的安装包、签名、升级或跨平台发布验收已经完成。

## 3. 最近一次验证

| 项 | 记录 |
|---|---|
| 验证日期 | 2026-09-10 |
| 前端功能基线 | `d02ce15` |
| 后端功能基线 | `7d2e2b3188a79ffb97591b28af6d2fa84e4af135` / `0.1.0+7d2e2b3` |
| 自动门禁 | 本轮只执行真实 Stage H 定向联调，未重跑前端全量单元测试；不得沿用 2026-09-08 的测试数字冒充本轮结果 |
| 真机范围 | Windows Electron test build + REAL BackendAdapter；覆盖预检、校验/preview、pinned/follow、generation 归属、tail busy 强串行、A/B Prompt/Engine 隔离、正式 cleanup 与冷启动复查 |
| 当前结论 | **PASS**；预检 12/12、preview-validation 12/12，pinned=revision 1、follow_latest=revision 2；B buffer/Prompt 无 A 标记；cleanup 二次全零且冷启动无残留 |
| 验收证据 | [Stage H 最终真实联调验收](review/2026-09-10-多角色Stage-H最终真实联调验收.md) |

以上数字是带日期和证据的历史验证结果，不会因为只修改文档而自动刷新。后续代码批次必须用新的日期、commit 和验收记录整体替换本表，不能在其他文档追加另一组“最新数字”。

### 3.1 自动门禁（按代码批次记录，不并入上表）

上表记录的是**功能验收**口径；本小节记录**门禁健康**。二者分开的理由见 [门禁体系评估](review/2026-09-10-前端门禁体系评估与整改记录.md) §2.3：上表可以写「PASS」而自动门禁同时全红，此前正是这个缺口让 CI 连续 25 天无人查看。

| 门禁 | 命令 | 2026-09-10 整改批次（`4971053`） | 2026-09-10 缺陷修复批次（`cf217eb`） | 2026-09-10 测试陈旧性审查批次（本地，未推送） | 2026-09-10 多套 UI 基础批次（`98efd5d`） | 2026-09-10 Live2D dev 供给修复批次（本地） |
|---|---|---|---|---|---|---|
| 类型检查 | `pnpm typecheck` | PASS | PASS | PASS | PASS | PASS |
| Lint | `pnpm lint` | PASS | PASS | PASS | PASS | PASS |
| 文档结构 | `pnpm docs:check` | PASS | PASS（19 core / 67 review / 40 superpowers / 42 archived） | PASS（19 core / 68 review / 40 superpowers / 42 archived） | PASS（19 core / 69 review / 40 superpowers / 42 archived） | PASS（19 core / 74 review / 40 superpowers / 42 archived） |
| 敏感信息扫描 | `pnpm -F @cyrene/desktop verify:sensitive` | PASS（扫描 715 文件、按规则豁免 557 行、allowlist 放行 63 行） | PASS（扫描 735 文件、排除 368、按规则豁免 557 行、allowlist 放行 63 行） | PASS（未触碰扫描面；仅测试文件与文档变更） | PASS（扫描 736 文件、排除 368、按规则豁免 557 行、allowlist 放行 63 行） | PASS（扫描 751 文件、排除 368、按规则豁免 557 行、allowlist 放行 63 行） |
| 单元测试 | `pnpm test` | PASS（207 files / 2596 passed + 7 expected-fail + 21 skipped） | PASS（208 files / 2622 passed + 7 expected-fail + 21 skipped） | PASS（208 files / 2622 passed + 7 expected-fail + 21 skipped；本轮仅换断言写法，用例数不变） | PASS（**212 files / 2653 passed + 6 expected-fail + 21 skipped**；新增 3 条门禁 + `cy-code-block`，详见下） | PASS（**214 files / 2682 passed + 6 expected-fail + 21 skipped**；新增 `live2d-serve-gate` 10 条、`live2d-dev-resource-fetch` 11 条、`cy-tool-card` 2 条；两处新断言均过变异验证） |
| 集成测试 | `pnpm test:integration` | PASS（22 files；本机存在 Live2D 资源竞争型偶发，单文件运行稳定 27/27，见评估记录 §8.2） | PASS（22 files / 136 passed + 2 skipped，连续三轮全绿；孤儿根因已消除，见下） | PASS（22 files / 136 passed + 2 skipped；`electron-live2d` 27/27、`perf-gate` 实测 `found=500`） | PASS（22 files / 136 passed + 2 skipped；`markdown-xss` 2/2、`electron-live2d` 27/27、`electron-voice` 16/16 均复绿） | PASS（22 files / 138 passed + 2 skipped；新增 `electron-live2d` 用例 `5b` 断言两供给通道同门禁同字节。另：`ipc-security` 暴露面白名单按预期变红一次，见下） |
| 跨仓契约 | `pnpm -F @cyrene/desktop check:contract` | **NOT VERIFIED（exit 2）**：本机未挂载后端仓库；该状态不得读作通过 | **NOT VERIFIED（exit 2）**：同上，未重跑 | **NOT VERIFIED（exit 2）**：同上，未重跑 | **PASS（exit 0）**：首次对**真实 Linux 后端**验证——`192.168.1.18:~/elysia-agent`（`200d4b52`）契约 `WS v2 36/36 + REST 16/16`；桌面副本（`ceceabe8`）为 `33/33 + 16/16`，差异来自版本 | **PASS（exit 0）**：真实 Linux 后端 `fdf39898`（经 SSH 取回 `frontend_contract` 后本地校验）→ `WS v2 36/36 + REST 16/16`。本批未触碰后端线协议，此跑为回归确认 |
| 产物校验 | `pnpm verify:artifact` | 静态部分 PASS；fuse 读回与启动冒烟因无 `dist/` 未执行 | **未执行**：本轮未触碰打包链 | **未执行**：同上 | **未执行**：同上 | **未执行**：本轮未触碰打包链 |
| GitHub CI | `.github/workflows/ci.yml` | 见正文 | 见正文 | 见正文 | **PASS**（`98efd5d` / [run 34508128478](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34508128478)：5 个 job 全绿；`becedc9` / [run 34508996184](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34508996184)：首跑集成偶发、重跑全绿，见下） | **PASS**（`da64667` / [run 34562266876](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34562266876)：5 个 job 全绿，首跑即绿） |

CI 历史（本表 CI 行只记当前批次，历史见下）：

- `b498c59` / [run 34484192232](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34484192232)：自 2026-08-16 以来首次全绿。
- `79e4ba9` / [run 34494572138](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34494572138)：缺陷修复批次。
- `5e9039a` / [run 34502757096](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34502757096)：契约用例改写批次（含此前 `58008a8`／`91e399f`）。
- `98efd5d` / [run 34508128478](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34508128478)：多套 UI 基础批次，5 个 job 全绿（typecheck + lint、unit tests、integration tests、windows build-level、packaged artifact smoke）。
- `becedc9` / [run 34508996184](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34508996184)：首跑 `integration tests` 挂 `electron-voice.spec.ts` 用例 4（`CyRealtimeBar` 未在 POLL 内出现），`gh run rerun --failed` 后**全绿**。
- `0ac3830` / [run 34525605979](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34525605979)：Live2D 失败态可诊断化批次，5 个 job 全绿。
- `da64667` / [run 34562266876](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34562266876)：Live2D dev 供给修复批次，5 个 job 全绿且**首跑即绿**（本批新增集成用例 `5b` 与 `ipc-security` 白名单同步均在本地先验证过）。
- `90aee67` / [run 34568017964](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34568017964)：全量评审报告落库批次（仅文档，无代码改动），5 个 job 全绿且**首跑即绿**。其中 `typecheck + lint` job 内部含 `docs:check` 与敏感扫描两步，恰为本批改动的全部面，故这两个门禁由 CI 独立复核，而非仅凭本地自证。

**`electron-voice.spec.ts` 用例 4 偶发已定位并修复（2026-09-10 追加）**：根因为「采集成功后模式出现」类等待沿用 5s `POLL`，而 `startRecord`/`startRealtime`/`startDictation` 在置 mode 前要 await `getUserMedia → AudioContext → worklet.addModule` 整条真实设备链，高负载 runner 上可超 5s，且该静默期无任何 UI 反馈。现新增 `CAPTURE_POLL`（15s）用于全部此类等待（共 6 处，非只补挂掉那一处）。**未加 `--retry`**——真实挂起仍会失败，只是更晚。定位过程与已排除假设见[多套 UI 基础与模块耦合整改](review/2026-09-10-多套UI基础与模块耦合整改-决策记录.md) §7.2。

**注意**：GitHub **不保留被重跑覆盖的失败 attempt 日志**（`gh api .../logs?attempt=1` 返回的仍是最后一次 attempt）。因此偶发必须在**首次失败时**就取现场证据，事后无法补取。

多套 UI 基础批次（本地）落地了「换 UI 风格不必改功能层」的基础设施，并立起**三条此前完全缺失的门禁**：`token-contract.spec.ts`（组件引用的 `--cy-*` 必须已定义、不得私自定义、不得带兜底值）、`store-graph.spec.ts`（store 间循环依赖，Tarjan SCC）、`error-message.spec.ts`（错误文案回退链 + 全部本地码有映射）。三条门禁均做过**变异测试**（注入缺陷确认变红），而非只看绿灯。本轮同时把 46 条用户可见文案、代码块 HTML 模板、markdown 渲染缓存控制、Live2D 面板可见性与 TTS DOM 宿主四处功能层对 UI 的反向依赖全部反转。完整审计结论、规模与残余风险见[多套 UI 基础与模块耦合整改](review/2026-09-10-多套UI基础与模块耦合整改-决策记录.md)。

`expected-fail` 由 7 降至 6 的原因：`markdown-sanitize.spec.ts` 中一条「代码块包裹」canary 所测的 `wrapCodeBlocks` 已删除（其职责拆为 `splitCodeBlocks` 纯函数 + `CyCodeBlock.vue`），原 canary 改为确定性用例。**其余 6 条 happy-dom canary 仍必要**，升级 happy-dom 时必须复跑该文件。

缺陷修复批次（`f462edd`／`2c1f34c`／`cf217eb`）另外消除了一条**集成偶发的真实根因**：套件被中断时 `launchApp` 拉起的测试应用不会退出，带着 `cy-int-ud-` 临时 userData 跨运行驻留并争抢 CPU/GPU。现已由 `globalSetup` 在套件启动时按进程树回收（真机端到端 20 → 0 进程），因此上面「集成测试」一行的偶发注记不再适用。证据见[修复决策记录](review/2026-09-10-三项产品缺陷与集成孤儿进程修复-决策记录.md)。

测试陈旧性审查（本批次）另外核实：`markdown-sanitize.spec.ts` 的 7 个 `it.fails` canary **仍然必要**——升级 happy-dom 至最新（20.14.3）后输出逐字节不变，根因为 happy-dom 在 `Node.prototype` 上自带硬编码返回 `''` 的 `nodeName` getter，而 DOMPurify 的 `lookupGetter` 遇首个自有描述符即返回，永久锁定该空值。**每次升级 happy-dom 必须复跑该文件**（升级会让 canary 反向失效）。详见[测试陈旧性审查](review/2026-09-10-前端测试陈旧性审查.md)。

**Live2D dev 供给修复批次：`ipc-security` 暴露面白名单按预期变红一次（2026-09-10，值得记录）**

新增 preload 方法 `readLive2dModelFile` 后，`tests/integration/ipc-security.spec.ts` 的「`desktopApi` 只暴露白名单方法」用例立即失败。**这是该门禁设计意图的正确体现**，不是回归：它把「暴露面不得未经 review 增长」钉成硬编码表（刻意不从 `IpcChannels` 派生，派生会让断言恒真）。处置为在表中加入该方法**并写明 review 结论**——不新增能力（入参经 schema 收窄、判定全在 Main、只回字节与 mime、绝对路径不出 Main；打包形态下 Renderer 本就能同源 fetch 同一批字节）。

该用例的历史（见其注释）说明这类门禁的价值与风险都在同一处：它曾长期停留在 91 键而漏掉 `resetCharacterEvolution`，于是「唯一哨兵」长期红灯、保护意义归零——**任何真实的意外面扩张都会被同一个红灯掩盖**。因此本次不是简单补一个字符串，而是要求任何新增都必须附带结论。

**同批新增的两条断言均做过变异验证**（避免只看绿灯）：把 `gateLive2dFile` 的 `verifyIntegrity` 与 `listInstalledModels` 顺序对调 → 新 spec 2 条失败，而**既有 `protocol-live2d.spec.ts` 19/19 仍全绿**（即 fail-closed 时序此前完全没有被测试钉住）；把 `needsIpcResourceSupply()` 改为恒 `true` → 新 spec 4 条失败。

**全量评审报告落库批次（2026-09-11，仅文档变更，无代码改动）**：`pnpm docs:check` PASS（19 core / 75 review / 40 superpowers / 42 archived）；`pnpm test:integration` PASS（**22 files / 138 passed + 2 skipped**，exit 0，227s），用于复核报告 §11 R-09（见 §1）。`pnpm typecheck` / `pnpm lint` / 单元测试本轮**未重跑**——本批不含代码改动，不得把 2026-09-10 的数字读作本批结果。GitHub CI 结果见下方 CI 历史的 `90aee67` 行。

**UI 改版引入的三条回归修复批次（2026-09-11，本批）**：`pnpm typecheck` PASS；`pnpm lint` PASS；`pnpm docs:check` PASS（19 core / 75 review / 40 superpowers / 42 archived）；`pnpm test` PASS（**215 files / 2690 passed + 6 expected-fail + 21 skipped**，较上批 +3＝背景素材 +2、授权按钮 +1）；`pnpm test:integration` PASS（**22 files / 138 passed + 2 skipped**，exit 0，245s）；`pnpm build` PASS，产物中装饰图由 496,074 B 的 PNG 换成 **106,918 B** 的无损 webp。新增与收紧的 5 条断言均过变异验证（见 §1）。

维护规则：

- 每个代码批次用新的日期与 commit 整体替换本表，不在其他文档追加另一组“最新数字”。
- **`NOT VERIFIED` 与 `未执行` 必须显式记录，不得省略或读作通过**；这是 `check:contract` 原以 exit 0 冒充通过所暴露的教训。
- 出现红灯时先记录事实，再决定修门禁还是修代码；不得以「已知红」为由跳过查看——本仓库已经为此付出过一次真机事故的代价。

## 4. 阶段 8 阻塞项

| ID | 待确认事项 | 解除条件 |
|---|---|---|
| H-01 | 主验收平台 | 明确主平台、版本和验收优先级 |
| H-02 | Windows 10 / Windows 11 / Ubuntu 支持范围 | 明确最低系统版本和“支持”定义 |
| H-04 | 签名证书与发布身份 | 明确证书、保管方式、签名主体和无证书时的验收口径 |
| H-07 | Demo 成功标准 | 固化演示脚本、P0 功能、失败判定和证据要求 |

恢复阶段 8 前，还要复核 H-03、H-05、H-06、H-08、H-09 等发布相关项是否已经确认、仍然适用或被显式豁免。阶段 7 通过本身不足以自动启动阶段 8。

### 4.1 对外分发阻塞项（非阶段 8 专属）

| ID | 待确认事项 | 解除条件 |
|---|---|---|
| EXT-01 | 第三方资产（Live2D Cubism SDK 及模型）的授权与来源 | 见[决策记录](review/2026-09-10-第三方资产授权与来源立为阻塞项-决策记录.md) §4 的 6 项全部形成仓库内可查记录 |

`EXT-01` **不受阶段 8 状态影响**：阶段 8 暂缓与否、H 组决策是否齐备，都不改变这条阻塞；反之它也不构成阶段 5 的追溯性未完成项（阶段 5「已真实联调」记录的是运行时集成证据，该证据不构成可对外分发的许可依据）。当前可接受用途为内部/个人开发验证与本机 userData 装配；不可接受用途为向第三方交付含 SDK 的产物或在公开渠道分发。

## 5. 下一步

1. Stage H 已闭账；后续多角色新增需求应另立批次，不再复用已关闭的整改项。
2. 保留参数化 Stage H runner、公开 API tail 强串行语义和 fixture 的“停服务后 cleanup → 冷启动复查”顺序。
3. 任务中心、Neo4j 与阶段 8 均保持原有暂缓/排除状态；Stage H 完成不自动启动这些范围。
4. 全量评审建议的 P0-1～P0-7 **尚未开始**：恢复开发前需先定批次与顺序；其中 P0-7（`EXT-01` 第三方资产授权、`asar` 完整性与 Windows 打包进 CI）依赖外部授权事实与阶段 8 决策，不在可立即执行范围。
5. M-20 其余 **6 处** `--cy-accent` 文本误用（`CyConnectionPanel`×2、`CyLinkAttachment`、`CyRealtimeBar`、`CyToolCard`、`CyMessageList` hover）**未动**——属视觉设计取舍，待用户决定；本批只收口了安全授权按钮。
6. `ui/设计风格.md` 的归属待定：或收进 `docs/` 并挂到 doc 00／03，或明确标注为参考资料（像 `ref/`）。
7. 报告按仓库纪律**原样保留**（历史记录不改写其历史主张）；R-09 的更正记于 §1 与 §3.1，不回头修改报告正文。

## 6. 状态维护规则

- 本文件只保留“现在”，不积累按天追加的长篇日记。
- 每个阶段只有一个当前状态；细节和证据链接到 `docs/review/`。
- 测试数字必须同时记录日期、前端 commit 和验收文档。
- doc 10 负责技术任务定义，doc 12 负责进入/退出门槛；二者的带日期状态注记只视作历史快照。
- README 和 CLAUDE.md 只链接本文件，不复制状态或测试数字。
- 新增或关闭阻塞项时，同步更新相关决策记录。
- 状态表单行应保持可扫描，禁止把进度日记写入元数据字段。

## 7. 历史入口

- [治理前 doc 16 完整快照](review/2026-08-29-doc16实施进度历史归档.md)
- [治理前 README 完整快照](review/2026-08-29-README状态历史归档.md)
- [Review、决策与验收索引](review/README.md)
- [Spec、Plan 与 Final Report 索引](superpowers/README.md)
- [阶段 1～7 修缮候清单](review/2026-08-28-阶段1-7修缮候清单.md)
