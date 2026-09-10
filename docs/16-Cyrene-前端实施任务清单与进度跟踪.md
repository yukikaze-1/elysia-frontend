# Cyrene 前端实施任务清单与进度跟踪

**文档状态：** 维护中（项目当前状态的唯一事实源）
**最后核验：** 2026-09-10
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

| 门禁 | 命令 | 2026-09-10 整改批次（`4971053`） | 2026-09-10 缺陷修复批次（`cf217eb`） | 2026-09-10 测试陈旧性审查批次（本地，未推送） | 2026-09-10 多套 UI 基础批次（`98efd5d`） |
|---|---|---|---|---|---|
| 类型检查 | `pnpm typecheck` | PASS | PASS | PASS | PASS |
| Lint | `pnpm lint` | PASS | PASS | PASS | PASS |
| 文档结构 | `pnpm docs:check` | PASS | PASS（19 core / 67 review / 40 superpowers / 42 archived） | PASS（19 core / 68 review / 40 superpowers / 42 archived） | PASS（19 core / 69 review / 40 superpowers / 42 archived） |
| 敏感信息扫描 | `pnpm -F @cyrene/desktop verify:sensitive` | PASS（扫描 715 文件、按规则豁免 557 行、allowlist 放行 63 行） | PASS（扫描 735 文件、排除 368、按规则豁免 557 行、allowlist 放行 63 行） | PASS（未触碰扫描面；仅测试文件与文档变更） | PASS（扫描 736 文件、排除 368、按规则豁免 557 行、allowlist 放行 63 行） |
| 单元测试 | `pnpm test` | PASS（207 files / 2596 passed + 7 expected-fail + 21 skipped） | PASS（208 files / 2622 passed + 7 expected-fail + 21 skipped） | PASS（208 files / 2622 passed + 7 expected-fail + 21 skipped；本轮仅换断言写法，用例数不变） | PASS（**212 files / 2653 passed + 6 expected-fail + 21 skipped**；新增 3 条门禁 + `cy-code-block`，详见下） |
| 集成测试 | `pnpm test:integration` | PASS（22 files；本机存在 Live2D 资源竞争型偶发，单文件运行稳定 27/27，见评估记录 §8.2） | PASS（22 files / 136 passed + 2 skipped，连续三轮全绿；孤儿根因已消除，见下） | PASS（22 files / 136 passed + 2 skipped；`electron-live2d` 27/27、`perf-gate` 实测 `found=500`） | PASS（22 files / 136 passed + 2 skipped；`markdown-xss` 2/2、`electron-live2d` 27/27、`electron-voice` 16/16 均复绿） |
| 跨仓契约 | `pnpm -F @cyrene/desktop check:contract` | **NOT VERIFIED（exit 2）**：本机未挂载后端仓库；该状态不得读作通过 | **NOT VERIFIED（exit 2）**：同上，未重跑 | **NOT VERIFIED（exit 2）**：同上，未重跑 | **NOT VERIFIED（exit 2）**：同上，未重跑 |
| 产物校验 | `pnpm verify:artifact` | 静态部分 PASS；fuse 读回与启动冒烟因无 `dist/` 未执行 | **未执行**：本轮未触碰打包链 | **未执行**：同上 | **未执行**：同上 |
| GitHub CI | `.github/workflows/ci.yml` | **PASS**（`b498c59` / [run 34484192232](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34484192232)：5 个 job 全绿；自 2026-08-16 以来首次） | **PASS**（`79e4ba9` / [run 34494572138](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34494572138)：5 个 job 全绿） | **PASS**（`5e9039a` / [run 34502757096](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34502757096)：5 个 job 全绿；含此前两批 `58008a8`／`91e399f`） | 待推送后补记（本地门禁已全绿） | **PASS**（`98efd5d` / [run 34508128478](https://github.com/yukikaze-1/elysia-frontend/actions/runs/34508128478)：5 个 job 全绿——typecheck + lint、unit tests、integration tests、windows build-level、packaged artifact smoke） |

多套 UI 基础批次（本地）落地了「换 UI 风格不必改功能层」的基础设施，并立起**三条此前完全缺失的门禁**：`token-contract.spec.ts`（组件引用的 `--cy-*` 必须已定义、不得私自定义、不得带兜底值）、`store-graph.spec.ts`（store 间循环依赖，Tarjan SCC）、`error-message.spec.ts`（错误文案回退链 + 全部本地码有映射）。三条门禁均做过**变异测试**（注入缺陷确认变红），而非只看绿灯。本轮同时把 46 条用户可见文案、代码块 HTML 模板、markdown 渲染缓存控制、Live2D 面板可见性与 TTS DOM 宿主四处功能层对 UI 的反向依赖全部反转。完整审计结论、规模与残余风险见[多套 UI 基础与模块耦合整改](review/2026-09-10-多套UI基础与模块耦合整改-决策记录.md)。

`expected-fail` 由 7 降至 6 的原因：`markdown-sanitize.spec.ts` 中一条「代码块包裹」canary 所测的 `wrapCodeBlocks` 已删除（其职责拆为 `splitCodeBlocks` 纯函数 + `CyCodeBlock.vue`），原 canary 改为确定性用例。**其余 6 条 happy-dom canary 仍必要**，升级 happy-dom 时必须复跑该文件。

缺陷修复批次（`f462edd`／`2c1f34c`／`cf217eb`）另外消除了一条**集成偶发的真实根因**：套件被中断时 `launchApp` 拉起的测试应用不会退出，带着 `cy-int-ud-` 临时 userData 跨运行驻留并争抢 CPU/GPU。现已由 `globalSetup` 在套件启动时按进程树回收（真机端到端 20 → 0 进程），因此上面「集成测试」一行的偶发注记不再适用。证据见[修复决策记录](review/2026-09-10-三项产品缺陷与集成孤儿进程修复-决策记录.md)。

测试陈旧性审查（本批次）另外核实：`markdown-sanitize.spec.ts` 的 7 个 `it.fails` canary **仍然必要**——升级 happy-dom 至最新（20.14.3）后输出逐字节不变，根因为 happy-dom 在 `Node.prototype` 上自带硬编码返回 `''` 的 `nodeName` getter，而 DOMPurify 的 `lookupGetter` 遇首个自有描述符即返回，永久锁定该空值。**每次升级 happy-dom 必须复跑该文件**（升级会让 canary 反向失效）。详见[测试陈旧性审查](review/2026-09-10-前端测试陈旧性审查.md)。

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
