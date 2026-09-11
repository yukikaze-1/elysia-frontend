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
- **报告 §11 R-09 的两组观测（2026-09-11）**：报告称本机 `pnpm test:integration`「22 文件全红（81 failed / 12 passed / 47 skipped）」，而本轮多次重跑得到**全绿**（单文件 `ipc-security.spec.ts` 18/18；全套 **22 files / 138 passed + 2 skipped，exit 0**，227s 与 245s 各一次）。**两组都是真的**，由同一机制决定（`out/` 的构建模式），见下条与 §3.1。
- R-09 定性（**2026-09-11 二次修正**）：该报告的症状描述**属实**，但**不是环境玄学、也不是 Playwright 握手偶发**——本地那些 `Process failed to launch!` 的根因是 dev/production 构建与 harness 覆盖门冲突，已定位并给出可复现判据，见 §3.1「集成测试「全红」的真正机制」。简言之：`pnpm dev`（或 `pnpm build`）会重写 `out/`，而集成套件跑的正是 `out/` 产物，`CYRENE_TEST_APP_DATA` 被 fail-closed 拒绝。先前措辞「不可复现 / 运行环境态」的方向对（非产品缺陷、非门禁失效）但成因错，现予取代。另：报告用于反证该结论的「进程存活 12 秒」推理不成立（模态框会让进程一直活着），见同节方法论陷阱。
- 报告最值得保留的两条结构性判断（已复核属实）：① **收口点是路由点而非策略点**——`registerHandler` 只校验来源与参数个数、`createIpcHandler` 只校验形状，故 `MAX_IPC_MESSAGE_BYTES` 只在 1 条通道真正执行、`PATH_BLACKLIST_DEFAULTS` 在附件链 0 次调用，H-01 与 M-03 是同一根因的两个实例；- ② **测试保护了 bug**——`debounce-trailing.spec.ts:11-13` 把防抖（而非节流）语义钉成了正确行为，这是 H-03 能在 214 个测试文件下长期存活的原因。建议把「这条断言在实现坏掉时会红吗」列入评审清单项，这比修单个缺陷更能防止下一批同类问题。
- **UI 改版后的复评（2026-09-11）**：用户 UI 批次 `034c110`／`85f2602`／`116d529` 落地后按 HEAD 重核报告 UI 条目。已改善：M-20 部分修复（`CyChatInput` 4 处、`CyNavRail` 1 处的 `--cy-accent` 文本误用已清除）。逐处读码确认**仍在**：H-02（不跟随底部且不可复制）、M-19、M-21、M-22、M-23、M-24。
- 复评发现该 UI 批次**新引入三条**，本批已修：① `--cy-accent` 被调浅（`#dce8ff`→`#e7edff`），使安全授权按钮文本对比度由 1.23:1 **降到 1.17:1**（暗色 1.31:1）——改用配对文字色 `--cy-accent-text`（11.0:1／13.1:1）并按规则级加守护断言；② 主题背景用 `@media (prefers-color-scheme: dark)` 切换、而全仓其它颜色用 `light-dark()`，应用内主题落地时会出现「token 翻了、背景图没翻」——补根节点 `data-theme` 覆盖路径并与 `color-scheme` 同步；③ 装饰图 `cyrene-deco-voice-wave.png` 为 1024×768／496 KB，而实际渲染宽度 ≤280px——按 2× 出图改**无损** webp（106,918 B，−78%）。
- 三条修复均过**变异验证**：还原文本色→授权按钮断言红；去掉 `:not([data-theme='light'])`→主题断言红；再单独去掉 `color-scheme: dark`→另一条红；放回 PNG→回退断言红；把 webp 换成 444 KB→尺寸上限断言红。装饰图保真度用客观指标核验（alpha 通道逐位相同；白底／黑底合成后 PSNR 69.1／68.5 dB，差异在 ±1/255 内）。
- 复评另记两条**治理问题（未处置）**：① `85f2602` 的 check-runs 数为 **0**——该 UI 大改从未被 CI 验证（本轮本地补齐门禁为绿；`116d529` 的 CI 以它为祖先一并覆盖）；② `ui/设计风格.md`（1349 行）落在 `docs/` 治理体系之外，`docs:check` 与 doc 00 均不覆盖，且已在响应式口径上与 doc 03 冲突（其 §35 仅列 1366+ 桌面档）。
- **门禁判别力批次（2026-09-11，`b51ba49`；报告 P1-2／P2-5／P1-4）**：三项都针对同一类缺陷——「门禁全绿，功能却是坏的」。① IPC **三面对齐**：声明面 `IpcChannels`、装配面 Main 真实注册的 handler（mock 捕获注册调用）、可达面 preload 源码引用；实测三面逐通道一一对应（**88 = 88 = 88**）、三张例外表为空，此前「通道声明了、preload 也在调、Main 却没人注册」可全门禁绿灯。② **dev 形态集成覆盖**首次存在：此前集成套件全部跑 prod 形态，正是用户 Live2D「Failed to fetch」躲过所有测试的原因。③ `check:contract` **首次进入 CI** 并显式标注 NOT VERIFIED。
- 本批**逐项变异验证**（共 10 次，变异均真正改变代码路径且先重建产物）：A 删注册点→红；B 加孤儿声明通道→红；C preload 指向别通道→红；D 令 preload 扫描器退化→红；**E 关掉 dev IPC 供给→端到端红于 `'Failed to fetch'`（逐字复现用户现象）**；F 移除 `@fs` deny→红并点名目标 URL；G 去掉 CSP 头→红；H 不注入 dev URL→红于 `page.url()=cyrene://renderer/index.html`；I／J 恢复契约段静默跳过→红。

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

**集成测试「全红」的真正机制已定位（2026-09-11，重要——影响所有后续集成测试的可信度）**

`pnpm dev` 会以 **development** 模式重写 `out/main/index.js` 与 `out/preload/index.js`，而集成套件启动的是 `out/` 里的构建产物。于是 `applyTestAppDataOverride("development")` 与 harness 传入的 `CYRENE_TEST_APP_DATA` 冲突，`test-app-data.ts:21-22` 按 fail-closed 抛错 → 主进程弹「测试 appData 覆盖仅允许未打包的 test harness」并退出 → Playwright 只看到 `electron.launch: Process failed to launch!`（或 `Timeout 30000ms exceeded`）。

单变量实验（重建 `--mode test` 后同一探针 attempt 1 即成功、`applyTestAppDataOverride("test")` 回读确认）证明因果，非环境玄学。这解释了本地全部观测：`pnpm build`（production）或 `pnpm dev`（development）之后，只要没经 `--mode test` 重建，单文件与全套都会相继全红；而 13:51、20:26 两次全套绿正是因为该脚本入口自带 `--mode test` 构建。**注意与 CI 的偶发要分开**：`ee8f7fa` 那次 CI 红是 `audit-lifecycle.spec.ts` 的 `expect.poll(timeout:5000)` 在 runner 上等不到 `credential:set` 落盘（`gh run rerun --failed` 后转绿），与本节机制无关，是独立的计时余量问题。

**一个方法论陷阱（本轮亲踩，务必记住）**：`fatal()` 用的是**模态对话框**，进程会一直存活直到有人点「确定」。因此「手动启动 `electron.exe`、十几秒后进程仍在运行」**不构成「应用正常」的证据**——框弹着，进程当然活着。本轮我先据此判定「应用健康、系 Playwright 握手偶发」，是错的；报告 §11 R-09 那句「直接启动 electron.exe，12 秒后仍在运行 ⇒ 非产品缺陷」用的是同一个不成立的推理（结论恰好对，论证无效）。**判据应换成**：回读 `applyTestAppDataOverride` 的实参、或断言窗口出现且首帧渲染完成。

**运维结论**：**跑集成测试/依赖 `out/` 产物的验证前，必须先 `pnpm exec electron-vite build --mode test`，且不要同时开着 `pnpm dev`**。`pnpm test:integration` 脚本本身含该构建，因此从脚本入口跑是安全的；直接用 `vitest run --config vitest.integration.config.mts` 单跑某个 spec 则**不会**重建，会踩到这个坑——这正是本轮先误判为「Playwright↔Electron 握手偶发」的原因（报告 §11 R-09 亦同）。用户侧现象是桌面上反复弹出该错误框，属测试副作用而非产品缺陷。

**UI 三处改动的实拍复核（2026-09-11，真实 Electron + 截图）**：授权弹窗「允许一次」实测亮色 `rgb(39,53,127)` on white = **11.04:1**、暗色 **13.07:1**（改前 `--cy-accent` 为 1.17:1）；「允许指定目录」同值；对照「拒绝」14.39:1。主题背景在 `data-theme='dark'` 下由 `cyrene-bg-chat-light` 切到 `cyrene-bg-chat-dark` 且 `color-scheme` 同步翻为 `dark`（`light` 时翻回）——即 (b) 要防的「token 翻了、背景图没翻」错配不成立。装饰图实渲 **280×147**、素材 560×420（正好 2× DPR）。设置体 `scrollHeight 617 > clientHeight 543`，确为内部滚动。

**H-02／H-03／H-04 修复批次（2026-09-11，报告 P0 前三项）**

三项均按「修 → 变异验证 → 提交」完成，且**每项都查了真实边界**，其中两项与报告的表述有出入：

- **H-03 流式渲染（`91704c8`）**：`utils/debounce-trailing.ts` 是纯防抖，token 间隔 <80ms 时回调永不触发；且 `debounce-trailing.spec.ts:11-13` 把该语义钉成了正确行为（「测试保护了 bug」的实例）。新增 `utils/throttle.ts`（首沿立即＋冷却窗口固定＋尾沿必达），删除旧 util 与其 spec。变异：改回防抖 → 两个 spec 共 7 条全红，组件层实测**流进行中 0 次非空采样**（与该 bug 的用户可见表现逐字对应）。
- **H-04 退出 flush（`bc66099`）**：新增下行契约（`app:persist-flush-request` / `app:persist-flush-done`），Main 在 before-quit 等 ack，复用既有 steps 有序 await 与 1500ms 超时。另修掉一个真 bug：`onTimeout` 抛错会从定时器回调逃逸（退出期即未捕获异常），由本轮单测抓到。
- **但报告的「草稿丢失」一半不成立**：关窗时 `createShutdownHandler` 先 preventDefault，随后 `adapter.disconnect()` 向仍存活的 Renderer 推 `disconnected`，`message.store.ts:1064` 的**既有断线 flush** 已把当前会话草稿落盘（否证实验：同时禁用两条路径后草稿才不落盘）。真正会丢的是**没有既有 teardown flush 的那一批**——设置／布局／角色草稿／非当前会话草稿；实测移除退出 flush 后 **`settings.json` 根本没被写出来**。
- **H-02 贴底跟随＋可复制（`f4466e4`）**：三处改动中**只有 `commitScrollHeights` 的贴底重锚是承重的**（变异后 e2e 立刻红于「距底部 551px」——根因是估高→实测高修正让 scrollHeight 增长、锚点恢复把用户留在离底部数百像素处）；`onRowResized`／`items.length` 两处跟随针对流式增长，语义正确但本 e2e 无法证明，已如实标注为 reasoned addition。可复制侧修了「正文可选中」与「消息级复制操作行」两条，**右键 Edit 菜单未做**。

**方法论教训（本轮两次踩到，值得单列）**：① 变异验证**必须先重新构建**——首次变异忘了 `electron-vite build --mode test`，对着旧产物跑出假绿；② 第一版 H-04 e2e 用「当前会话草稿」作断言，被既有断线路径兜住而**恒绿**，是变异验证把它揪出来的；③ 「可视行数变多」也曾被我误用作贴底断言（虚拟化下滚动后行数减少是正常的），改为产品级断言「自己的消息在视口内」。

**安全/数据止血批次（2026-09-11，H-12／H-11b／H-01）**

报告 P0 里剩下的三条安全/数据项已修复，均按「修 → 变异验证 → 提交」完成；三项都在 HEAD 逐条复核过现场。

- **H-12 主进程异常兜底（`de808ea`，语义经 `67dcf79` 修正）**：此前 `src/main` 全仓 **0 处**注册 `unhandledRejection`/`uncaughtException`。新增 `app/process-error-guards.ts`（按 `handleChildProcessGone` 的「纯函数 + deps 注入 + 单测」先例）。**两个处理器的存续语义故意不同**：`uncaughtException` 留痕后**主动接管 fail-safe**（弹窗 + 收尾 + 退出）；`unhandledRejection` 只留痕并继续运行——这是对 Node 默认（无监听器则升级为未捕获异常并终止）的**有意偏离**，代价（真正严重的拒绝也会被放过）已写入代码注释。另修 `pushEvent` 缺销毁守卫与 `openExternal` 的裸 `void`。
- **H-12 的一处自纠（重要，勿再犯）**：上一批我写的是「`process.on` 是追加监听，不覆盖 Electron 自带处理器，既有默认行为照旧发生」。**该论证被对照实验推翻**：不装配本模块时出现 Electron 原生弹窗「A JavaScript error occurred in the main process」，装配后该弹窗消失且进程存活——即 **Electron 在已有应用处理器时会让位**。故注册监听器**顶掉了平台默认 fail-safe**；若只留痕不接管，等于把「崩溃退出」换成「异常静默吞掉且带未定义状态继续运行」，比原来更危险。**教训：凡「纯增量/不影响既有行为」的断言都必须实测**，平台在「已有处理器时是否让位」这类语义上极易想当然。
- **同轮修掉的第二个真问题**：首轮修正后实测发现进程存活但**审计里什么都没有**、紧接着窗口关闭——`fatalRuntime` 的退出抢在 fire-and-forget 的审计写入之前，把要留的痕带走，「至少留痕」这个唯一目的落空。现 `handleUncaughtException` 为 async：日志 → **await 审计** → `onFatal`；`index.ts` 新增 `auditAsync` 供其使用。顺序保证由单测钉住（审计未 resolve 时 `onFatal` 绝不能被调用）。
- **H-11b 持久化 fail-closed（`12268f9`）**：`corrupt-isolation` 的 `rename(...).catch(() => {})` 改为上抛（ENOENT 例外）；`session-store` 新增 `SESSION_SCHEMA_VERSION` + `describeSchemaProblem`（`schemaVersion` 此前**声明了却从不读**）、降级态 `getLastError()`、以及 `writeDrafts`/`writeCache` 的 `assertWritable` 守卫——隔离失败后拒绝一切写入，原文件逐字节不动。**有意未采纳**报告「非空文件解析出空态也算损坏」的建议：合法空库写出的正是同样形状，该启发式会误报。
- **H-01 附件黑名单（`31e309b`）**：`PATH_BLACKLIST_DEFAULTS` 此前在这条链 0 次调用。现于 **validate 与 upload 两条链**、`realpath` 之后套用（upload 侧复验必要——Renderer 可跳过 validate 直接 upload），按 realpath 匹配故符号链接也拦得住。**取舍**：采用完整默认黑名单，因此 `/tmp` 与 `%TEMP%` 亦被拒（从临时目录选附件会失败）；理由与回退方式见 §5。

**方法论教训（本批又踩一次）**：变异验证不仅「必须先重新构建」，还必须确认**变异真的改变了代码路径**——本批 H-11b 首轮变异我写成恒 false 判断、原守卫仍在，跑出假绿；且发现 session-store 侧测试用的是注入替身、绕过了真实 isolation 实现，补了接缝用例后才真正变红。H-01 同款：首轮把守卫改成恒 false 而非移除。

**本批一次偶发（如实记录，不当作通过）**：H-01 的全量集成跑中 `electron-voice` 的 `9b. 断线清理（实时）` 红过一次；单跑该 spec **16/16 全绿**（含 9b 1041ms），且附件黑名单不触及语音链路，判定为偶发。此类中断与 CI 上出现过的是同一族。

**本批三次 CI 红——两次偶发、一次是我的测试缺陷（必须区分，不可一并归为偶发）**：
- 偶发①（本地）：H-01 全量集成跑中 `electron-voice` `9b. 断线清理（实时）` 红过一次；单跑该 spec **16/16 全绿**（含 9b 1041ms）。
- 偶发②（CI）：[run 34612277649](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34612277649) 的 `integration tests` 红，失败点是 `markdown-xss.spec.ts` 的 `locator.click` 等 REAL/MOCK 按钮**超时 30s** + `Execution context was destroyed`——UI 就绪超时而非安全断言失败；本地单跑 **2/2 通过**（664ms/845ms），`gh run rerun --failed` 后全绿。
- **非偶发③（CI，我的缺陷）**：[run 34614104584](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34614104584) 在**文档提交**上红，失败点是上一批我自己新增的 `message-list-follow-bottom.spec.ts` ①。根因不是产品回归：该断言要求「刚发的消息**完整落在视口内**」，而助手回复很长时会**合法地**把用户消息顶出视口——正常滚动，非缺陷。本地窗口大（1184×721）故一直绿，CI 小视口把它逼了出来。已改为承重的产品语义断言（`bottomGap ≤ 40` =「贴底跟随」+「消息确实进了列表」），并重新变异验证判别力未削弱（去掉贴底重锚仍红于 551px）。修复后 [run 34615829866](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34615829866) **5 job 首跑即绿**，反证该红确非偶发。

三次失败的日志均在重跑前取回本地副本（GitHub 不保留被覆盖的 attempt 日志）。教训：**本地门禁全绿不等于 CI 全绿**——视口尺寸/负载差异会暴露本地掩盖的测试健壮性问题；把 CI 红一律当偶发会漏掉真缺陷。

**门禁判别力批次（2026-09-11，`b51ba49`）**

`pnpm typecheck` PASS；`pnpm lint` PASS；`pnpm docs:check` PASS（19 core / 75 review / 40 superpowers / 42 archived）；`pnpm test` PASS（**221 files / 2757 passed + 6 expected-fail + 21 skipped**，较上批 +8 files／+67 passed，其中本批新增 11 条＝三面对齐 5 条 + 契约门禁 6 条）；`pnpm test:integration` PASS（**25 files / 149 passed + 2 skipped**，较上批 +1 file／+6 passed＝dev 形态 spec）；`pnpm -F @cyrene/desktop verify:sensitive` PASS（扫描 786 文件、排除 368、按规则豁免 557 行、allowlist 放行 63 行）。

**跨仓契约门禁本轮双跑（这是 P1-4 的判据，两个方向都要有）**：① 对**真实 Linux 后端**（`192.168.1.18`，HEAD `5f841510`；`contract.schema.json` + `rest.py` + 12 个 `ws-v2-*.jsonl` 经 `scp` 取回本地）→ **exit 0**：`WS v2 36/36`、**88 条真实契约帧**解析后与输入逐字段相等、`REST 16/16`，三段逐条列出已核对内容。② 本机默认路径（无后端）→ **exit 2** 且明写 NOT VERIFIED——这正是 CI 将看到的结果（CI 无后端仓库），故 CI 侧按退出码分流标注而非变红。

**两处本轮实测教训（都已写进代码注释，避免下次重犯）**：
- **变异"还原"也必须重新构建**：修完变异 F 未重建就跑变异 G，`out/main` 仍带 F，于是 ⑤ 红——看似 G 的影响，实为陈旧产物。我据此先误判过一次，重建后才得到干净的单变量结论。（此前的教训只覆盖"变异前要重建"，这次补上"还原后也要"。）
- **探测手段本身可能被豁免**：`page.evaluate` 经 CDP `Runtime.evaluate` 下发，等同 DevTools 控制台求值，**不受页面 CSP 约束**——用它探测 CSP 恒得 'allowed'（第一版实测如此）。有效判据必须是**页面自己发起**的动作（改为插入内联 `<script>` 后同步读哨兵）。同类：破坏性导航用例必须排在末位，否则"页面没了"会污染其余用例的失败签名。
- 另有一条关于**被测脚本自身**的教训：`check-backend-contract.mjs` 的 `parseModelFields` 会跳过 `_` 前缀字段（Python 私有约定），拿 `__probe__` 之类的名字当漂移探针会被静默忽略而得到假绿。

**剩余 High 修复批次（2026-09-11，`5396bae`／`6ec4941`／`da9a378`／`5d28fc8`）**

报告 H-05～H-10 六条里的四条：H-10、H-09、H-11a，以及 H-02 的**续修**（上一批漏网面，也是 CI 上次红的真因）。四项均按「修 → 变异验证 → 提交」完成，且**三项的严重性被实测修正**。

- **H-10 流式生命周期出口（`5396bae`）**：`message.store.ts` 原本零个 `setTimeout`，`activeGenerationId`/`streaming` 永不过期。新增 `utils/generation-watchdog.ts`：窗口取**静默**（任何属于当前代的事件重置，50s），到期 → interrupted + `GENERATION_STALLED`（新增文案映射）+ 释放活动代；跨代事件不得续命。取消改**乐观**（先落本地状态再通知，栅栏判定原子化）；`resetConversation` 边界补 `api.cancel`（此前清掉本地后停止按钮消失而后端继续生成）。e2e 用新增 `CYRENE_MOCK_STALL_GENERATION=1`（只发 `generation.started` 后静默）造出真卡住，判据取用户可见三件事；变异（不武装看门狗）→ 红于占位永不消失。
- **H-10 自曝缺陷（同一提交）**：`canSend` 我写成 `!hasActiveGeneration` 漏 `.value`（`<script setup>` 不自动解包）⇒ **所有用户发送按钮永久禁用**，而当时 223 个测试文件全绿——**既有用例只断言「busy 时禁用」，从无一条断言「正常时可用」**。已补两条反向断言并做变异验证。
- **H-09 写路径（`6ec4941`）**：大小校验前移到 `preReadForDiff` 开头（授权前），超限既不读旧文件也不算 diff、也不弹注定失败的授权窗；另加 `MAX_DIFF_INPUT_BYTES`（256 KiB）省略大输入预览，但**保留 isNewFile/oldHash 等安全字段**。
- **H-09 严重性实测修正**：评审称同步 diff 会让「整个应用卡住一拍、所有超时都无法触发」。实测 `computeTextDiff`：2 MiB（写入上限）→ **26 ms**、4 MiB → 61 ms、16 MiB → 209 ms、32 MiB → 485 ms。即在写入上限处约为一帧，**并非冻结**。故该项真实价值是「不做白工 + 不在授权前做事」，已按实测口径改写代码注释与题述，不再重复夸大措辞。
- **H-11a 原子写（`da9a378`）**：**成因修正**——Windows 上 20 个并发写同一路径有 5 个以 `EPERM: rename` 失败，争用在**目标文件**（MoveFile 不能替换被打开的句柄）而非临时文件，故「改 UUID 临时名」**单独不足以**修好并发（变异实测：有独立 temp 仍红）。真正修好的是**按目标路径串行化**（`atomic-write.ts` 内，覆盖 6 个生产调用点）；UUID 临时名与陈旧 temp 回收（阈值 1h）另行解决同名相撞与孤儿累积；SessionStore 的 `writeTail` 为纵深防御（非唯一防线）。
- **H-02 续修：已尝试并**回退**（`5d28fc8` → `5d04941`）**。原实现由 `atBottom`（瞬时位置）决定是否跟随，流式期间它瞬时为 false 即永久放弃 → scrollTop 冻结、缺口累积（探针实测 scrollTop 冻在 6146 而 scrollHeight 涨到 12093）。改为**意图与瞬时位置分离**（`stickToBottom`），本地全绿且新增用例 ④ 变异验证有效（改回瞬时位置 → 红于 4825px）。**但 CI 上该改动使既有 `perf-gate` ②b 由绿转红**（`top >= clientH` 红于 337 < 534：用户上翻后被拽回底部），且新增用例 ④ 自身在 CI 仍红于 565px。**本地绿、CI 红且成因未能收敛，故按纪律回退**，不留一个已被证明会破坏既有门禁的改动。详见下方"H-02 未决"。
- **本批最值得记的一处自纠**：续修里我一度加了「scrollTop 变小**且**最大可滚动量未增长才算用户上翻」这条更"聪明"的判别，**被既有 `perf-gate` ②b 本地当场抓住**——流式期间用户上翻时 maxScroll 恰在增长，该条件使意图永远清不掉，于是每次增长都把用户从正在阅读的位置**拽回底部**。那个「浏览器夹小 scrollTop」的担忧在两处实测里都没出现：为一个未证实的假设牺牲真实可用性是错的。移除后该条本地复绿，但 ②b 在 CI 上仍因续修整体而红（见上），最终整体回退。

**H-02 未决（截至本批末，需专门一轮）**：`message-list-follow-bottom.spec.ts` ① 与 `perf-gate` ②b 在 CI 上呈现一组**相互拉扯**的性质——「流式期间保持贴底」与「用户上翻后不得拽回」——本地（视口 1184×721）两者皆过，CI（较小视口 + 慢 runner）无法同时满足：不带续修时 ① 红（779px），带续修时 ②b 红（337）且 ④ 红（565）。下一轮应先在 CI 等价的视口下复现，再定判据，**不要再靠本地绿就推送**。已获得的可用事实：探针实测原实现确实存在「瞬时位置吞掉跟随意图 → 永久冻结」，故这是真缺陷而非测试问题；难的是判据与重锚时序，不是缺陷是否存在。

**本批方法论教训（第三次同族，已单列）**：我直接跑 `vitest run --config vitest.integration.config.mts` 测组件改动，而该命令**不重建 `out/`**，于是两次「修复后仍冻结」的结论其实都跑在**旧产物**上，白绕一圈。前两批的教训是「变异前要重建」「还原后要重建」，本次补第三条：**任何被测改动都要先确认它在产物里**（最终靠一个临时探针属性在 DOM 里回读为空才发现整轮都在测旧构建）。另修一处**未还原的变异残留**（上批 Mutation B 的 `void watchdog` 顶掉了 `clearGeneration` 的 `disarm()`），由 `grep MUTATION` 扫出——变异残留必须扫，不能靠记忆。

**P1-12 renderer 错误进诊断包（2026-09-11，`70c9467`）**

- 评审核实：renderer 侧 JS 错误**从不进入诊断导出**——三个错误源（Vue `errorHandler`、window `'error'`、`'unhandledrejection'`）只做 `console.error`，Main **没有**订阅 `console-message`，summary 也只含 origin/status/protocolVersion。注释把「JS 异常是独立候选」列为目标而代码从未落地。
- **修法**：订阅 `console-message` → 既有 logger → 诊断包（**不新开 IPC 通道**）。理由：logger 落盘前已做 **sanitize+redact 双净化**（正是报告要求的管道）；**不新增暴露面**（对契约零改动）；且 `console-message` 天然覆盖「没想到去插桩」的错误。
- **噪声风险按有界处理**：只转发 error 级、10s 滑窗限流 20 条、单条截断 500 字符；**被抑制的条数本身也补记**（`renderer:console-suppressed`）——静默丢弃会重演"看不见"这个原始缺陷。
- **⚠️ 实现中撞到会让整项失效的签名坑（值得单列）**：Electron 43 的 `WebContents.on('console-message')` **参数在事件对象自身**上，位置参数（`level: number` 等）是**已废弃**形态——而 d.ts **只声明了废弃形态**，故 `(_ev, details)` 会把 `details` 推成 `number`；且现代形态的 `level` 是**字符串**，沿用数字比较则 `'error' >= 3` 为 false ⇒ **一条都不会转发**，正好重演本缺陷的"静默无痕"。现两种形态都归一，并有专门用例守卫。与本仓库在 `render-process-gone`（2 参 vs 3 参）上的签名坑同族。
- **验证**：单测 13 条（两种 level 形态、默认不转发 info/warning、限流、**抑制可见性**、窗口重置、超长截断、logger 缺失不抛）；**e2e 3 条真机读 Main 日志**（`console.error(marker)` 落盘、`setTimeout(throw)` 未捕获异常同样落盘、诊断面可读）；**变异**——移除转发 → e2e 3 条全红（真机复现修复前状态）。
- **边界**：只把 renderer 错误接进日志/诊断包，不含「summary 里单列 renderer 错误计数」；也未改 `renderer/src/main.ts` 的三处 `console.error`（它们经 console-message 自然被捕获，少改一处即少一处漂移面）。

**H-08 与 P1-1 批次（2026-09-11，`64ac75d`／`03ca4e6`；CI 修复 `fcfacb8`）**

- **H-08 长会话性能（两个安全半边）**：① **估算器扫全文 → 记忆化**。`estimateMessageHeight` 代价是 **O(全文长度)**（assistant 分支 `split('\n')` 分配整段行数组 + 每段一次全局正则），而 `buildPrefix` 对**每个尚未实测的行**都调它一次 ⇒ 每次 prefix 重算重扫未渲染行全文。记忆化键**刻意不用全文哈希**（那本身就是 O(全文)、等于没省），改用 **O(段数)** 的廉价版本号。② **markdown 渲染缓存 O(N²) → 有界**：键是整段源文本，流式每个 80ms 节拍产生更长新文本 ⇒ **一条回复写入 N 个条目、总字节 O(N²)**，此前只在会话切换时清空；现限幅 300 条 FIFO 淘汰。
- H-08 **已知边界如实记录**：完全等长且段数相同的文本替换会复用旧估算（版本号不变）——影响面极小（估算只用于未实测行，实测高一到即覆盖），属**自愈误差**不累积；有专门用例名点出它是记录而非假装不存在。
- H-08 **判别力取"计数"而非"计时"**：本仓库已有外部教训——计时断言在 CI 上不稳。故判别点取**确定性可数**的量（`estimateHeightStats.computes` 真实计算次数、`markdownCacheSize()` 条目数），它们恰好就是「是否真的做了那件昂贵的事」。变异：移除记忆化 → 5 条红、实测 `expected 100 to be 20`（证明修复前 buildPrefix 多轮调用确实重复扫全文）；移除限幅 → 红于 `expected 500 to be ≤300`。
- H-08 **第三半（消息数组封顶）刻意未做**：报告自己标为需「重定 anchor/highlight 测试与 ≤60 rows 基线」的高风险项；`order`/`byId` 装的是当前会话已加载消息，封顶会改变「向上滚动能否看到已加载旧消息」的用户可见语义，并牵动 `loadOlder` 游标、锚点恢复、来源跳转三套机制。最急的 O(N²) 那处已由渲染缓存限幅解决，余下受分页约束。建议单独一轮 + 真机大会话复验。
- **P1-1 IPC 预算声明**：报告概括为「收口点是路由点而非策略点」——doc 07 声明 4 MiB 为全局不变量，但 `registry` 只校验 arity、只有 `session-store` 一处执行，而 `ipc-limit.spec` 只断言常量本身。故「谁能守住」取决于每个作者是否记得，属**无证缺口**。采纳报告推荐的低成本路线：**声明表 + 枚举断言门禁**（零运行时成本），分 `bytes`/`schema`/`none` 三类且**注明执行点或依据**，字节类常量**引用真实来源**（声明与实现不可能各写一个数而漂移）。门禁**上线首次运行即抓到 `credentials:get-status` 未登记**——证明它不是形式。变异：把预算改为 2×全局不变量 → 「局部围栏不得比全局更宽」用例红并点名。
- P1-1 **边界如实记录**：本批**不新增运行时强制**；声明表的价值是「遗漏可见」而非「已强制」，两者不可混为一谈。`enforcedAt` 由人核对，门禁只能保证其非空与预算不超全局不变量，**无法证明执行点仍存在于代码里**。真正的运行时收口（结构化遍历 + 热通道门控）仍未做。
- **⚠️ 本批一次 CI 三连红的根因是我自己的新测试（`fcfacb8` 修复）**：H-08 的「缓存有界」用例在 CI 上把 worker **打爆**——`34644547347`／`34644969632`／`34645185218` 三次红的日志里是 `Ineffective mark-compacts near heap limit` + `Worker exited unexpectedly`，而 `perf-bounds` 在日志中出现 **0 次**（连结果都没打印），单元 job 报 `228 passed (229)`、Windows 同。
- 原因：我模拟「流式文本持续变长」时用了**真实体量**（累积数 KB × 500 次 parse+sanitize），而该用例要证的性质只与**键的数量**有关、与字节数无关。改为 350 次极小且互不相同的文本后，本机 2393ms → **101ms**（1/24），并在 `--max-old-space-size=256`（模拟 CI 受限堆）下本地复现通过；判别力不变（变异仍红于 `expected 350 to be ≤300`）。
- **教训与既有条目同族但方向相反**：前面记的是「计时断言在 CI 上不稳」，这次是「用真实体量做模拟会在 CI 上爆内存」——**判别力应落在性质上，不该复刻真实规模**。
- **本批 CI 偶发族的如实记录**：`34647315773`（`fcfacb8`）的 `integration tests` 红于 3 例，全部属既有偶发族且均在我未改动的区域——`electron-live2d` B6 与「恢复默认设置」各红于 `canvas 非空 expected 0 to be > 0`（SwiftShader 像素采样，仓库早已记录该环境限制）。
- 同一次 `message-list-follow-bottom` ① 红于 **779px**（H-02 未决项，见该节）。同一提交的本地单跑全部通过（`electron-live2d` 28/28），且此前 `34643081653`（`07c71dd`）5/5 全绿。**未以"放宽断言"换取绿灯**——那正是本仓库批评过的反模式。

**H-07 mock 侧确定性缺陷批次（2026-09-11，`07c71dd`）**

只读侦察定位到两处**确定性**缺陷，本轮读码确认并各自变异验证；两者都在 mock 角色后端，且都会让公开状态卡片走向「永久读取失败」：

- **缺陷①（评审未提，更严重）**：`createCharacter`/`cloneCharacter` 把角色推进 `characters` 与 `histories`，却**从不写 `states`**；而 `getConversationBinding` 早已把自建角色绑定到 `instance-<mangled-id>`。故 mock 下**每一个用户自建角色**的公开状态卡片永久 `CHARACTER_INSTANCE_NOT_FOUND`——不是"有时"，是必然。全仓原本**没有任何** `instance-custom*` 用例（grep 0 命中），从未被发现。
- **缺陷②**：`states` 的 `characterRevision` 构造时定死、此后永不更新，而 `updateCharacter`/`rollbackCharacter` 会推进角色 revision ⇒ follow_latest 绑定到新 revision 后渲染层身份栅栏必然抛错，且**重试不自愈**（只在 Main 的 15s TTL 内取回同一个旧 revision 值）。
- **修法**：提取 `instanceIdFor()` 作唯一推导点（原推导内联在绑定里，与 `states` 键空间各自演化——正是分叉温床）；新增 `ensureStateFor(detail, statePolicy)`（无则建、有则推进 revision+`stateVersion`；`reset_evolution` 重置情绪、`preserve` 保留）；三处调用点 create/clone/update+rollback。
- **验证**：新增 `mock-character-state-coverage.spec.ts` 7 条，覆盖原先缺失的那条路径（自建/克隆可读、revision 与**绑定**对拍、reset 语义、回滚、内置回归、未创建实例仍拒绝）。变异：移除 create 的 `ensureStateFor` → 3 条红；让状态永不刷新 revision → 3 条红于 `expected 1 to be 2`。
- **评审措辞再修正**：评审称卡片「既不自愈也不报错」**不准确**——卡片会显示「读取失败 + 重试」并给出错误码，只是**不会自动恢复**（`loadState` 只有协调器元组监听与手动重试两个调用方，无轮询/重订阅）。真实症状是「报错且不自愈」，不是「静默空卡」。
- **H-07 结构性修法仍未做**：让读路径携带 revision（`getCharacterState(instanceId, expectedRevision)`）、由 Main 在单一键空间做唯一栅栏、删掉组件层第三份重复规则——需改 IPC 契约与 Real 侧，属高风险项、需真机复验。

**H-02 未决的新证据（`34642079698`）**：该次 CI 里 `message-list-follow-bottom` ① 红于 **84px**（阈值 40），而真实缺陷的实测值是 **779px**／**4825px**。即 CI 上的红色形态是**估算→实测高修正过程中的小幅未收敛**（84px 量级），不是「永久冻结」那种数百至数千像素的缺口。这对定判据很关键：40px 阈值落在噪声带内，下一轮应改为「先等收敛再断言」（或按实测把阈值定在 84 与 779 之间并写明依据），同时保留数百像素量级的判别力。同次另一个红是 `electron-live2d` B6（SwiftShader 画布像素 0），与本批改动无关：两者在本地单跑均全绿（31/31），且其后继提交 `07c71dd` 的 CI **5/5 全绿**。


- **P2-6 临时目录回收**：**实测把 L-28 的规模修正了一个数量级**——评审判定「集成套件泄漏临时 userData 目录」（本机 103 个 `cy-int-ud-*`／59.65 MB），实测 `$TEMP` 下累积 **6,720 个 `cy*` 目录／22.6 MB、最早 2026-06-23**，分布 40+ 前缀（`cy-creds-` 2576、`cy-settings-` 1430、`cy-atomic-` 762…），**大头在单元测试**。
- P2-6 根因不是「清理失败」而是**多数 spec 根本没有清理代码**（如 `credential-store.spec.ts` 每次 `mkdtempSync` 却全文件无 `rmSync`）。故修法为**集中回收 + 防漂移门禁**（`tests/helpers/temp-dirs.ts` + 两套 globalSetup），而不是逐个 spec 补 `afterEach`（22 个文件必然再漏）。安全纪律落在实现里：只处理临时目录**直接子目录**、显式允许表（**不用 `cy*` 通配**）、**被活进程引用的跳过（含子路径**——Electron 子进程写 `<dir>/Cyrene`）、太新的跳过（10 分钟，防并发套件）、单条失败不中断。防漂移用例扫描全部测试源码的 `mkdtemp` 前缀，未登记即红并点名；带退化哨兵（扫不到 >20 个前缀即判解析器失效）。
- **P2-6 验证（不是只看绿灯）**：① 接线证据——预置 3 小时前的 `cy-creds-*`／`cy-int-ud-*` 目录，跑单元/集成套件后日志出现 `[temp-dirs] 回收 N 个…` 且该目录 `True → False`；② 收敛证据——单元全套跑完后 `cy*` 由 **6,720 → 71**，其中 `>1h` 残留 **0 个**（其余 68 个是本次刚建的，按设计由年龄阈值保护）；③ 变异——从允许表**真实删除**条目 → 防漂移用例红并点名；关掉「在用跳过」→ 对应用例红。
- **M-33**：`electron-tools.spec.ts` fixture 根由硬编码 `/tmp/cyrene-fixtures` 改为 `mkdtempSync(join(tmpdir(),'cy-tools-'))`（原写法在 Windows 被解析成 `C:\tmp\...`，走不同的字符串变换路径）。另修 `corrupt-isolation.spec.ts` 的 `ci-` 命名空间笔误（7 处）；其中过宽的 `cy-` 前缀借改名一并取消，回收半径收窄。
- **H-05 契约镜像**：**实测否掉了评审建议的方案**——`z.ZodType<T>` 是**协变**的（只要求 `schema 输出 <: T`），**抓不到 schema 漏掉可选成员**，而"漏掉可选成员"正是本仓库真实发生的缺陷（本机实测 `z.ZodType<Contract> = 少了可选成员的schema` 可以编译通过）。
- H-05 实际修法三条：① 补齐真缺口 `ToolCallRecordSchema.diff`（并把 `ToolDiffSchema` 上移到其之前——原顺序正是漏掉的直接原因；该缺口是**静默 fail-closed 隐患**：`.strict()` 下携带 `diff` 的记录会让整个 `MessageSchema` 解析失败并丢弃消息）；② `BackendEventEnvelopeSchema` 加 `.strict()`，靠 `.extend()` 继承一次覆盖全部 **28** 个事件成员（此前 13 strict／15 非 strict **全靠作者记性**；实测确认 zod 4 的 extend 继承 catchall）；③ 新增**键集合相等**断言 `SameKeys<A,B>`（`keyof` 含可选成员，双向包含），补上协变锚点做不到的那一半，且不改运行时、**不擦除 `.shape`**（`z.ZodType<T>` 注解会擦掉它，本仓库 4 处测试依赖 `.shape`）。
- **H-05 变异验证**：真实删除 `ToolCallRecordSchema.diff` → `tsc` 红于 `contract-mirror.spec.ts(49,18) TS2344`（证明门禁确实抓得住评审所指缺口）；移除基座 `.strict()` → 3 条用例红并点名非 strict 成员。
- **本轮第二次「无效变异」**：第一次「从允许表移除条目」我误写成只加注释、条目仍在（跑出假绿），重做后才真正变红。这与前几批的「变异未改变代码路径」同族，已作为固定检查项：**变异后必须确认目标代码真的变了**。

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
4. 全量评审建议的 P0 批次**已基本完成**：H-02／H-03／H-04 与安全三项（H-12／H-11b／H-01 止血）均已修复并变异验证，见 §1 与 §3.1；仅 P0-7 未动（`EXT-01` 第三方资产授权、`asar` 完整性与 Windows 打包进 CI），它依赖外部授权事实与阶段 8 决策。
4.1 **建议的门禁判别力三项已完成**（`b51ba49`，报告 P1-2／P2-5／P1-4，见 §1 与 §3.1）。剩余 **H-05～H-10 六条 High 一条未动**，均属 P1：H-05 契约镜像锚点（P1-3）、H-06／H-07 角色域双缓存（P1-10，高风险、需真机复验）、H-08 长会话性能（P1-9）、H-09 写文件大小校验前移＋diff 出主线程（P1-8）、H-10 流式 watchdog／切会话取消（P1-7）、H-11a 写序列化＋唯一临时名（P1-5）。另 P1-1（`registry` 预算默认值）、P1-11（`noImplicitAny`／type-aware lint）、P1-12（renderer 报错进诊断包）亦未动。
5. **剩余 High 批次进度（2026-09-11 更新）**：H-10、H-09、H-11a、**H-05**、**P2-6**、**H-07（mock 侧确定性缺陷）**、**H-08（两个安全半边）**、**P1-1** 已完成（`5396bae`／`6ec4941`／`da9a378`／`bd065b6`／`b3c7baf`／`07c71dd`／`64ac75d`／`03ca4e6`，见 §3.1）。**H-02 续修已尝试并回退**（`5d04941`；见 §3.1「H-02 未决」，该节已有新证据）。**尚未开始**：**H-07/H-06 的结构性修法**（revision 感知读 + 单一栅栏 + 去组件层重复规则；改 IPC 契约与 Real 侧，需真机复验）、**H-08 第三半**（消息数组封顶，需重定 anchor/≤60 rows 基线）、**P1-1 的运行时收口**（结构化遍历 + 热通道门控）；以及 P1-11（`noImplicitAny`／type-aware lint）、P1-12（renderer 报错进诊断包）。
5.1 **H-06／H-07 侦察已定案（2026-09-11，只读复核）**，两处与评审措辞不符，修前须知：① 评审称公开状态卡片「既不自愈也不报错」**不准确**——实际会显示「读取失败 + 重试」并给出错误码，只是**不会自动恢复**（`loadState` 只有两个调用方，无轮询/重订阅）；② 更严重的是侦察发现的**确定性缺陷**：mock 模式下 `createCharacter`／`cloneCharacter` **从不创建 `states` 条目**，故**每一个用户自建角色**的公开状态卡片在 mock 下永久报 `CHARACTER_INSTANCE_NOT_FOUND`（全仓无 `instance-custom*` 用例，从未被覆盖）。修法方向：让读路径携带 revision（`getCharacterState(instanceId, expectedRevision)`），由 Main 在一个键空间上做唯一栅栏，并删掉组件层第三份重复规则；同时修 mock 的 state 映射。
5. **H-01 的取舍已按推荐定案**：采用完整默认黑名单，`/tmp` 与 `%TEMP%` 下的附件会被拒——理由是这两个目录的同用户临时文件同样可能含密钥，而附件链是 Renderer 唯一能用字符串指认本地文件的地方；代价明确且**改一处即可放开**。H-12 的两处取舍亦已定案：`uncaughtException` 接管 fail-safe（弹窗 + 退出），`unhandledRejection` 只留痕不终止。
6. H-01 的**结构性修法未做**：Main 签发不可猜 `fileRef`、`path` 仅由 `webUtils.getPathForFile` 铸造（需改 preload↔Main 附件契约，复杂度 L）。
7. H-11b 的降级故障只到「Main 拒绝写入 + 日志/诊断计数 + `getLastError()`」；**renderer 侧仍不会向用户显示持久化故障**（`draft.store` 的持久化失败是 fail-open 吞掉的），属 M-19 一类。
8. M-20 其余 **6 处** `--cy-accent` 文本误用（`CyConnectionPanel`×2、`CyLinkAttachment`、`CyRealtimeBar`、`CyToolCard`、`CyMessageList` hover）**未动**——属视觉设计取舍，待用户决定；本批只收口了安全授权按钮。
9. `ui/设计风格.md` 的归属待定：或收进 `docs/` 并挂到 doc 00／03，或明确标注为参考资料（像 `ref/`）。
10. 报告按仓库纪律**原样保留**（历史记录不改写其历史主张）；R-09 的更正记于 §1 与 §3.1，不回头修改报告正文。

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
