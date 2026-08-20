# 阶段 6（工具、权限与 Desktop P0）批次 C：allow_scoped 目录授权 + 设置页授权管理（完整历史查看器）+ 命令模板空态 + L-1~L-8/M-1/M3 收口（F-07/08 承接 + 批次 B 复核项）

**日期：** 2026-08-20（Asia/Shanghai）
**状态：** binding spec（批次 C）
**依据：** 批次 C 预检拍板（2026-08-20，AskUserQuestion 四项：仅作代码批 / settings.json tools 子树 / 完整历史查看器 / 目录授权+有效期）+ 批次 B spec `docs/superpowers/specs/2026-08-20-phase6-tools-batchb-main-exec-ui-design.md`（binding）+ 批次 B 决策记录 `docs/review/2026-08-20-阶段6批次B-决策记录.md`（D6B-01~22、L-1~L-8、M-1/M3 留档、M-8 残余风险）+ doc 04（Desktop 工具与权限交互设计 v0.2 §7.2/§7.3/§7.4/§14）+ doc 12（F-08 命令模板待确认）+ 工具双轨统筹决策记录（2026-08-19）

---

## 0. 决策集合（本批定案；预检四项拍板 + 本批派生拍板；最终报告汇报）

| # | 决策 | 定案 |
|---|---|---|
| **D6C-01** | **批次边界**：批次 C = **仅作代码批**（mock 驱动可测，F-07/08 承接）——allow_scoped 目录授权+有效期 + 设置页「安全与权限」子页（完整历史查看器 + 授权管理 + 命令模板空态）+ settings.tools grants 子树 + L-1~L-8 复核项 + M-1/M3 留档项收口 + 评估结论（action 移除/跨页配对/M-8 原生对话框）。**真实 Windows Electron 联调由开发者批次后执行，三态批次后仍 = 已开发、未联调** | 批次 C 预检拍板①「仅作代码批」；批次 B 决策记录 §7 前置清单 |
| **D6C-02** | **授权存储 = settings.json tools 子树**：`SettingsState` 增 `tools: { grants: PermissionGrant[] }`（新 `PermissionGrant` 契约）；`ToolsSettingsSchema.default({ grants: [] })`（**version 保持 1**——新增可选字段带 default，旧文件无 tools → default 空，向后兼容，不触发损坏重建）；`SettingsService.save` 增 tools 子树 merge（对齐 voice/dictation/live2d 既有模式） | 批次 C 预检拍板②「settings.json 子树」；批次 B D6B-14（设置面不动）本批解锁 |
| **D6C-03** | **Grant 模型（权限粒度 = 目录授权 + 有效期 + 后端身份）**：`PermissionGrant { id: string, toolName: 'desktop.file.read'|'desktop.file.write', scope: { directory: string }（realpath 规范化目录）, backendIdentity: string（连接指纹，见下）, expiresAt: number（epoch ms）, createdAt: string（ISO）, source: 'directory', revokeSource?: 'user'|'expired', revokedAt?: string }`；**只授权 read/write**（capture 无 path；select 已 automatic）；**后端身份绑定（F-2 修复）**：`backendIdentity` = 授权时连接指纹（`new URL(serverUrl).origin`——`real-backend.ts:505` 以 serverUrl 为 mapper 身份的先例语义，契约 F-11；取 origin 使路径后缀变更不失效，mock 注入对齐）；`matches` 要求 `grant.backendIdentity === 当前连接指纹`，**连接目标变更（serverUrl 切换端点）→ grant 不再匹配**（fail-safe 落 prompt，doc 04 §7.2「后端身份」硬性要求本批落实，不留联调待定；**契约 F-4：token 变更不改变 origin → grant 保持匹配，记录为已知语义**——如需 token 级失效引入 token 派生指纹，注意不得明文存 token，本批不做）；**参数限制 = 目录范围**（grant 不约束 write content 参数，只约束目标路径在授权目录内） | 批次 C 预检拍板④「目录授权+有效期」；doc 04 §7.2；spec review F-2 |
| **D6C-04** | **决策链接入（step 8 前置查 grants）**：授权判定前先查 `grants.matches(toolName, realPath)`——**工具匹配 + 后端身份匹配 + realpath 段边界落在授权目录内（等于目录或以目录+分隔符开头）+ 未过期未撤销 → auto 自动执行**（无权限窗）；未命中 → 原 prompt 逻辑不变；**grant 匹配优先于 selected-set 豁免（F-8 一致：双命中 → 审计 allow_scoped + permissionGrantId；仅豁免命中 → allow_once）**；**黑名单永远压过一切**（step 5 已拒绝，命中不弹窗不受 grant 影响）；**capture 恒强确认**（无 grant 面）；**写 grant 命中时无确认窗但卡片携带只读 Diff**（F-4 修复：`rec.diff` 由 step 7 `preReadForDiff` 恒计算——命中自动执行时 `tool:event` 照常携带 diff 字段，卡片只读展示「写入内容差异」（非授权门、无确认按钮），补「写入内容摘要」（结果行数/字节），doc 04 §8.3 Diff 可见性要求以只读信息形态保留，取舍 R2 关闭） | D6C-03 承接；doc 04 §7.4 决策优先级；spec review F-4/F-8 |
| **D6C-05** | **创建流（「允许指定目录」入口）**：CyToolApproval 增第三操作「允许指定目录」（仅 read/write 且 awaiting_permission 时显示）→ Renderer 送 `tool:grant-directory {callId, ttlMs}` → **Main 侧 ttlMs 白名单校验（F-3 修复）**：`ttlMs ∈ GRANT_TTL_OPTIONS_MS`（1h/24h/7d/30d 枚举，**常量 shared/contracts/tool.ts、校验权威 Main**，schema 层 union 拒绝非法值——`SCHEMA_VALIDATION_FAILED`，防 renderer 送 `2^53` 制造事实永久 grant，「无永久 grant」由 Main 校验保证，非 UI 软约束）→ Main 目录选择器（注入 `pickDirectory`，Windows/posix 对齐 select 注入先例）→ 目录 realpath 规范化 + 黑名单复核（**命中黑名单目录 → 拒**，用户无法授权黑名单）→ grant 创建（`expiresAt = now + ttlMs`，默认 24h 常量 `GRANT_DEFAULT_TTL_MS`，绑定当前后端身份）→ 落 settings.tools.grants → 审计 `tool:decision` `permissionDecision:'allow_scoped'` + `permissionGrantId` → **当前请求经 grant 匹配自动执行**（不再二次弹窗；**F-1 修复：执行前显式 `matches()` 复核，picked 目录不覆盖请求目标 → 不执行、保持 awaiting**）；选择器取消 → grant 不创建、请求保持 awaiting 态；**竞态守卫（N-1/N-4 修复）**：pickDirectory resolve 后补 `rec.status !== 'awaiting_permission' → return`（dialog 期间 expiresAt 定时器可能已触发——已终态记录不得被 run() 复活）+ `backendIdentity()` undefined（dialog 中掉线）→ 不创建 grant（fail-closed，防 `''` 僵尸 grant）+ **L-3 守卫前移**：`run()` 入口、`rec.status = 'running'` **之前**检查状态（非 awaiting/requested → 直接 return） | doc 04 §7.3「工具支持范围授权时，显示允许指定范围，并明确目录、模板、参数和有效期」；批次 B D6B-03 grantScope 字段类型保留本批启用；spec review F-1/F-3 + 复核 N-1/N-4 |
| **D6C-06** | **撤销与过期**：设置页「授权管理」列表**活动项**「撤销」→ `tool:grant-revoke {id}` → Main `revoke(id)`（**N-5：首查 `revokedAt` 已置位 → no-op 直接返回 undefined 不审计不落盘**；再查 `expiresAt <= now` → 已过期走 expired 分支标注（`revokeSource:'expired'` + 审计 `grant:expired`）；未过期走 user 分支（`revokedAt` + `revokeSource:'user'` + 审计 `grant:revoked`），保留灰显，不物理删——历史可追溯；未知 id → `GRANT_NOT_FOUND` 结构化拒绝 F-17）→ 落盘；**过期惰性清除**：`matches`/`list` 时发现 `expiresAt <= now` → 置 `revokedAt`+`revokeSource:'expired'` + 落盘 + 审计 `grant:expired`；过期/撤销 grant 不再匹配；**已撤销/已过期灰显无按钮（F-22 措辞：revoke-expired 分支服务「渲染后、点击前过期」竞态与程序化 revoke）**；**撤销/过期只影响后续匹配（F-13 定案：已授权进入 running 的请求继续执行至终态，与 allow_once 同语义，不中断）** | doc 04 §7.2「可在设置页查看及撤销」+ §7.4；spec review F-9/N-5/F-17/F-22 |
| **D6C-07** | **设置页「安全与权限」子页落地（CySecurityPane 新建）**：NAV_ITEMS.security 从占位改真页——三个分区：**① 授权管理**（活动 grants 列表：工具/目录/来源/有效期/撤销按钮 + 已撤销/已过期灰显 + 空态「暂无长期授权」）；**② 审批历史**（完整历史查看器：只读 IPC `tool:history` 读 Main audit JSONL 的 tool:* 事件，过滤/搜索/时间排序 + allow_scoped 条目「撤销此授权」跳转按钮——permissionGrantId 对应 grant 仍活动才可撤销）；**③ 命令模板空态**（F-08 关闭：空态文案「未启用受控命令执行。桌面工具仅包括文件选择/读取/写入与屏幕捕获，不支持任意命令执行」，无任何命令模板/无注册入口） | 批次 C 预检拍板③「完整历史查看器」+ ④；doc 04 §14「审批历史应允许用户按工具、目录、命令模板、结果和时间查看，并可从相关记录跳转撤销长期授权」；doc 12 F-08 |
| **D6C-08** | **历史数据源 = Main audit JSONL 回读（主）+ settings.grants（授权管理次）**：审批历史**只读** audit 文件（`audit-YYYY-MM-DD.jsonl`，readdir 按文件名倒序取最近 N 天 + 逐行 JSON parse 过滤 `type` 以 `tool:` 或 `grant:` 开头，倒序 ts，上限 `HISTORY_MAX=200`）→ IPC `tool:history {limit?}` 返回脱敏历史条目（ts/toolId/toolName/status/permissionDecision/permissionGrantId/riskLevel/cancelSource/errorCode/summary——summary 已是审计侧脱敏产物）；**grant 生命周期审计**：`tool:decision`（allow_scoped + permissionGrantId）/ `grant:created` / `grant:revoked` / `grant:expired`；**grant:created summary 不含目录绝对路径（F-5 修复）**：`「目录授权（工具 <toolName>，有效期至 <ISO>）」`——目录路径仅存 settings.tools.grants 与 `tool:grants` 响应，不进审计/诊断导出（doc 07 §12「未脱敏的敏感路径」禁止项——工具/有效期/身份已足供历史查看）；**授权管理** = settings.tools.grants 直读（新增 `tool:grants` 只读 + `tool:grant-revoke`） | doc 04 §14 + §7.4；audit.ts 已存 tool:* 事件（批次 B D6B-18）；spec review F-5 |
| **D6C-09** | **L-1~L-8 批次 B 复核项收口**（逐项）：
| **D6C-09a** | L-1 records 终态驱逐 | `records` Map 增 `MAX_RECORDS = 200` 上限：插入超限 → 逐出最旧**终态**记录（`completed/failed/rejected/cancelled/timeout`，`startedAt` 最旧优先；**awaiting/running 永不逐出**——非终态不驱逐纪律延续批次 B §7 留档）；`byCallId` 同步清理；tool:list/reconnect 遍历不受影响 |
| **D6C-09b** | L-2 tool:list 补水合 | `toolStore.init()` 启动时调 `api.toolList()` 将 Main 现存记录**水合**（非终态 awaiting/running/requested 必水合——权限窗/卡片不丢；终态可选；**F-3 一致：`listRecent` 增 `includeNonTerminalAlways`——非终态全量返回 + 终态补足到 limit，防长会话 awaiting 头部水合不到**）→ 对齐 `voiceStore.init` 先例；`toolList` 通道既有注册（tool-handlers.ts:26）不改，仅补消费端 + **F-15：先 await 水合完毕再订阅 onToolEvent（防旧快照覆盖新事件；水合快照 = Main 权威快照）** |
| **D6C-09c** | L-3 运行中取消竞态 + N-1 终态复活 | `run()` 入口、`rec.status = 'running'` 赋值**之前**补 `if (rec.status !== 'requested' && rec.status !== 'awaiting_permission') return`（对已终态记录整体拒绝——现 L-3 复查在 `withPathLock` 后、状态已置 running，救不了「定时器过期后 pickDirectory 复活」路径；N-1） |
| **D6C-09d** | L-4 case 'tool.request' try/catch | `real-backend.handleFrame` 的 `case 'tool.request'` 包 try/catch（解析/提炼失败 → logger.warn + 丢弃该帧不崩溃；不 catch 后继续 emit——失败即协议异常，结构化拒绝已有 reject 路径） |
| **D6C-09e** | L-5 paramHash 浮点格式 | **评估记录**：四工具实参均字符串（path/content/region:null），canonical 序列化不触发浮点 `1e-07` vs `1e-7` 差异；联调引入数值参数时复核——spec §7 R5 + 决策记录留档，无代码改动 |
| **D6C-09f** | L-6 diff 行长度截断 | `text-diff.ts` 增 `MAX_DIFF_LINE_BYTES = 2000`：`computeTextDiff` 对单行 text 超限截断（`text.slice(0, MAX)` + `…（已截断）` 标记），`truncated` 置位沿用——防 2MiB 单行经 awaiting 事件压垮 Renderer |
| **D6C-09g** | L-7 confirmUpload 终态陈旧字段 | `confirmUpload()` 终态 emit **之前**清 `captureSources/capturePreview`（现清在 emit 之后——纯顺序瑕疵，completed 事件携带陈旧选择器/预览数据） |
| **D6C-09h** | L-8 decide/cancel 未捕获 rejection | `tool:decide/tool:cancel` handler `.catch`（结构化错误上提但**不产生 unhandled rejection 日志噪音**——`Promise.resolve(handler(...)).catch` 收敛）；`CyToolApproval` 允许/拒绝按钮提交期间禁用（防双击二次 decide → TOOL_STATE_INVALID 噪音） |
| **D6C-10** | **M-1/M3 留档项收口（批次 B §7）+ 新文件写 TOCTOU 守卫（facts 修正）** | **M-1（TOCTOU size 复核形态）正式确认**：现有 `readFile` open 后 `buf.byteLength !== st.size` 复核 + fstat 语义（safe-open 层）+ 写前哈希冲突保护已满足 doc 04 §8.3——记录结论，无代码改动；**M-3（临时文件随机后缀）正式否决**：固定 `.tmp` + O_EXCL + rename 原子性 + fsync + EEXIST 单次重试（atomic-write.ts 现有实现）已满足安全属性——随机后缀不增加同一授权目录内 temp 的安全收益（temp 名不可由攻击者预测控制），记录否决理由，无代码改动；**新文件写 TOCTOU 守卫（facts 修正：现实现无此防护）**：`writeFile` 在 `atomicWriteFile` 前补 `if (rec.diff?.isNewFile && fs.existsSync(p)) throw FILE_CONFLICT('文件已被创建，未覆盖')`——授权时文件不存在（preReadForDiff 置 `isNewFile:true`、无 oldHash）、执行前被创建 → 拒绝覆盖（原文件保持）；单测断言 |
| **D6C-11** | **GET /api/tools/calls/{callId} + 重连 hydration**：real-side 实现 `RealBackend.getToolCallStatus(callId)`（`GET /api/tools/calls/{callId}` → `DesktopCallStatusSchema` 解析——**repo 9 值枚举 `pending/accepted/running/succeeded/failed/rejected/cancelled/expired/offline` + 全字段 `callId/toolName/toolVersion/runtime/paramHash/createdAt/expiresAt/result?/error?`，契约 F-2：doc 02 行 530 原表述松散错误，本批修正**；缺省端点/连接断开 → `null` 降级）+ fixture 单测；`MockBackend.getToolCallStatus` → `null`（无端点，记录取舍）；tool-service `reconnect()` 对 awaiting 记录经注入 `queryStatus` 回调查询（**mock 装配不注入 → 不查**，F-20 口径）；**映射定案**：`expired→timeout`、`cancelled/rejected→cancelled`、其余/`null→保持本地态`（禁止自动执行）；**真实链路联调验证**（doc 04「归批次 C 真实联调」口径——本批实现 + 单测，联调复核）；`DesktopCallStatus` 加入 check:contract `REST_TARGET_MODELS`（REST 段 15→16，本批可验证） | 批次 B D6B-11④；doc 02 §16.2；本批派生拍板；spec review 契约 F-2/一致 F-7/F-20 |
| **D6C-12** | **IPC 面扩展**：`IpcChannels` 增 `toolGrantDirectory`（`{callId, ttlMs}`，**schema 层 `ttlMs` union 白名单** `GRANT_TTL_OPTIONS_MS` 枚举——非法值 `SCHEMA_VALIDATION_FAILED` 结构化拒绝，F-3）、`toolGrants`（`{}` → grants 列表）、`toolGrantRevoke`（`{id}`，未知 id → `GRANT_NOT_FOUND`）、`toolHistory`（`{limit?}`）；全部 `createIpcHandler` + `registerHandler` + zod 双端 + `isTrustedSender`（对齐 tool-handlers 既有纪律）；`PushChannels` 不新增（**F-12 定案：settings:load 是 invoke 非推送——grant 变更后设置页组件本地刷新；如需跨页一致可重调 `api.settingsLoad()`**） | doc 04 §6 禁止接口清单纪律延续；spec review F-3/F-12/F-17/F-23 |
| **D6C-13** | **评估结论（记录，不实现）**：**action 兼容帧移除** = 保留至阶段 8（D6B-07 延续，本批确认不做）；**跨页/跨会话归档配对** = 历史查看器设计基于 audit 事件（非完整调用对象）→ 配对语义不适用，归档配对维持 rest-mapper 每消息配对现状，记录批次 A/B 表述差异；**M-8 原生确认对话框** = 评估结论**保留 in-Renderer**（Electron 模态对话框阻塞主进程 + 双确认 UX 撕裂；缓解层 raw .strict() + Main 黑名单/风险重算 + capture 子状态机已构成纵深；记录残余风险，阶段 7 安全收敛再评估）；**renderer 可撤销 grant（F-8 记录）** = 被攻破 renderer 可对任意 grant id 调 `tool:grant-revoke`（id 可枚举自 tool:grants）——仅骚扰级（撤销合法授权 → 恢复逐次弹窗），**无权限提升**（renderer 本可对 pending 自动 allow_once，M-8 同档）；记录为接受，不设额外校验 | doc 04 §14 数据完整性范围；批次 B §7 M-8；spec review F-8 |

**范围外（本批明确不做）**：真实 Windows Electron 联调（开发者批次后，三态升「已真实联调」）；`desktop.command.run` 注册（全阶段不注册）+ local_worker；action 兼容帧移除；写文件编码转换；capture 平台扩展（Wayland portal/录屏）；grant 跨会话共享/迁移；设置页「开发与诊断」子页。

---

## 1. 目标

批次 C（allow_scoped 目录授权 + 设置页授权管理 + 复核项收口）目标（一个验收句）：**Desktop P0 四工具的 read/write 新增「允许指定目录」目录授权（有效期 + 撤销 + 后端身份绑定，settings.json tools 子树持久化），决策链 step 8 前置 grant 匹配自动执行（黑名单永不覆盖）；设置页「安全与权限」子页落地——授权管理（活动/已撤销 grants 列表 + 撤销）+ 完整审批历史查看器（Main audit JSONL 回读、过滤/搜索/跳转撤销）+ 命令模板空态（F-08 关闭）；L-1~L-8 批次 B 复核项收口（records 驱逐/hydration/取消竞态/try-catch/diff 截断/confirmUpload 顺序/decide.catch）+ M-1/M3 留档项正式确认/否决；GET tools/calls real-side 实现 + mock 降级；门禁全绿；三态仍 = 已开发、未联调。**

拆解为可验证子目标：

1. settings.tools grants 子树（`PermissionGrant` 契约含 backendIdentity + `ToolsSettingsSchema`/`ToolsSettingsPatchSchema` + voice.ts 类型层 + SettingsService.save merge + version 保持 1 向后兼容）；
2. GrantStore（Main 侧 grant 仓库：list/add/revoke/prune + 幂等 + 审计 grant:* 事件（summary 无目录路径含 backendIdentity）+ 黑名单复核 + realpath 规范化 + 装载期逐条校验）；
3. tool-service 决策链 step 8 grant 匹配（工具+后端身份+目录段边界+未过期未撤销 → auto，grant 优先于豁免；黑名单优先；capture 恒确认；写命中只读 Diff）；
4. 「允许指定目录」创建流（CyToolApproval 第三入口 → `tool:grant-directory` → pickDirectory 注入 → grant 创建 → 当前请求自动执行）；
5. CySecurityPane 子页（授权管理 + 完整审批历史查看器 + 命令模板空态）+ IPC `tool:grants/tool:grant-revoke/tool:history/tool:grant-directory`；
6. L-1~L-8 收口 + M-1/M3 确认/否决 + GET tools/calls real/mock + reconnect hydration 接线；
7. 评估结论记录（action/跨页配对/M-8）+ doc 04/02/06/07/12/16/13 + README/CLAUDE 同步 + 决策记录；
8. 门禁全绿（单测/集成/typecheck/lint/build/check:contract——**本批不改 raw wire → manifest 不刷新**）；
9. 三态 = **已开发、未联调**（真实 Windows Electron 联调归开发者批次后）。

## 2. 分层架构

```text
settings.json（Main 持久化边界）
└─ tools: { grants: PermissionGrant[] }          ← D6C-02 子树（SettingsService 读写）

Main（受信边界）
  GrantStore（grant 仓库）───────────────────────┐
  ├─ list/add/revoke/prune（settings.tools 读写）│
  ├─ matches(toolName, realPath)                │
  └─ audit grant:created/revoked/expired        │
tool-service 决策链 step 8：先查 GrantStore.matches → auto（无窗）│
  ├─ run() L-3 入口守卫 + L-1 records 驱逐        │
  └─ tool:event 推送 → toolStore（L-2 init 水合）│
tool-history（审计回读）← audit JSONL（tool:* + grant:*）│
IPC：tool:grant-directory / tool:grants /        │
     tool:grant-revoke / tool:history            │
real-backend：GET /api/tools/calls/{callId}（D6C-11）│
audit JSONL（tool:* + grant:* 事件）← 审批历史只读回读（tool:history）

Renderer（非受信）
  CyToolApproval 增「允许指定目录」（read/write awaiting）
  CySecurityPane（NAV security 真页）
  ├─ 授权管理（grants 列表 + 撤销）
  ├─ 审批历史（tool:history 过滤/搜索/跳转撤销）
  └─ 命令模板空态（F-08）
  toolStore.init() L-2 水合
```

## 3. 详细设计

### 3.1 settings.tools 子树 + PermissionGrant 契约（D6C-02/03）

**`shared/contracts/tool.ts` 增（PermissionGrant 领域契约）**：

```typescript
export interface PermissionGrant {
  id: string                    // 'grant-' + crypto.randomUUID()（无状态跨重启唯一，不需持久化计数器——一致性 F-5 钉死）
  toolName: 'desktop.file.read' | 'desktop.file.write'
  scope: { directory: string }  // realpath 规范化目录（D6C-04 匹配基准）
  backendIdentity: string       // 授权时连接指纹 = new URL(serverUrl).origin（F-2/契约 F-11：对齐 real-backend.ts:505 以 serverUrl 为 mapper 身份的先例语义，取 origin 使路径后缀变更不失效；mock 注入固定值）
  expiresAt: number             // epoch ms
  createdAt: string             // ISO
  source: 'directory'
  revokeSource?: 'user' | 'expired'
  revokedAt?: string            // 置位后不再匹配（灰显保留）
}
export interface ToolsSettings { grants: PermissionGrant[] }
```

**`shared/contracts/voice.ts` 类型层（契约 F-6）**：`SettingsState` 增 `tools: ToolsSettings`（import 自 `shared/contracts/tool.ts`）+ `SettingsPatch` 增 `tools?: Partial<ToolsSettings>`——只改 schema 不改类型会 typecheck 失败（`SettingsStateSchema: z.ZodType<SettingsState>` 强约束）。

**`shared/schemas/ipc-response.ts`**：`PermissionGrantSchema`（zod strict，`toolName` 二值枚举、`backendIdentity` 必填 string、`revokeSource` 二值可选、`revokedAt` 可选）+ `ToolsSettingsSchema = z.object({ grants: z.array(PermissionGrantSchema) }).default({ grants: [] })` + **`ToolsSettingsPatchSchema = z.object({ grants: z.array(PermissionGrantSchema).optional() })`（无 default——IP-1 先例：patch 子 schema 不得带 `.default()`，且 zod 4 中 `.default()` 包装后无 `.partial()` 方法，必须独立新建）** + `SettingsStateSchema` 增 `tools: ToolsSettingsSchema`（**version 保持 literal(1)**——default 兜底向后兼容）+ `SettingsPatchSchema` 增 `tools: ToolsSettingsPatchSchema.optional()`（IP-1：patch 用无默认子 schema，防单字段 patch clobber）+ `DEFAULT_TOOLS = { grants: [] }` + `DEFAULT_SETTINGS` 增 `tools: DEFAULT_TOOLS`。

**TTL 常量（契约 F-8 定案）**：`GRANT_TTL_OPTIONS_MS = [3600_000, 86_400_000, 604_800_000, 2_592_000_000] as const` + `GRANT_DEFAULT_TTL_MS = 86_400_000` 放 **`shared/contracts/tool.ts`**（renderer 读展示枚举、schema union 引用同一常量）；**校验权威在 Main**（schema union 拒枚举外值 → `SCHEMA_VALIDATION_FAILED` + tool-service 侧 `includes` 双保险 → `INVALID_ARGUMENTS`）；与批次 B 工具常量（`tool-service.ts:60-68` Main 侧）位置的差异记入决策记录。

**`main/settings/settings-service.ts`**：`save(patch)` 的 merge 表达式增 `tools: { ...this.state.tools, ...patch.tools }`（对齐 voice/live2d 既有模式）。

**旧文件兼容验证**：settings.json 无 `tools` 字段 → `SettingsStateSchema.parse` 走 `.default()` 填充空 grants → 不触发 `.corrupt` 备份（既有损坏路径仅在 parse 失败触发——default 兜底保证成功）。**版本不回退**：version 仍 1，无迁移脚本。

### 3.2 GrantStore（新建 `main/tools/grant-store.ts`，D6C-03/06）

```typescript
export interface GrantStoreDeps {
  settings: SettingsService             // load/save（settings.tools.grants 读写）
  audit: (ev: AuditEvent) => void
  normalizeDirectory: (raw: string) => string   // realpath 规范化（黑名单复核前调用，抛 PATH_UNSAFE）
  isBlacklisted: (real: string) => boolean      // 黑名单复核闭包（F-3：钉死调用方放宽形态——`isPathBlacklisted(real) && !(allowRoots ?? []).some(r => real === r || real.startsWith(r + '/'))`，对齐 tool-service.ts:403 同款；裸注入 isPathBlacklisted 会让 /tmp fixture 被误拒）
  backendIdentity: () => string | undefined     // 当前连接指纹（F-2：serverUrl origin；断连 undefined → 不匹配）
  now?: () => number                            // 注入（测试）
}
export function createGrantStore(deps: GrantStoreDeps): {
  list(): PermissionGrant[]                     // prune 过期后返回全量（活动 + 灰显）
  add(g: Omit<PermissionGrant, 'id' | 'createdAt'>): PermissionGrant   // id=crypto.randomUUID + createdAt + 审计 grant:created（F-5：summary 不含目录路径）；**V-1：内部 `normalizeDirectory(picked.path)` 后存储归一化值**（黑名单复核与 N-6 幂等键均基于归一化值，防 raw-vs-normalized 恒 miss）；N-6 幂等：同 toolName+目录+身份+未撤销未过期 → 返回既有
  revoke(id: string): PermissionGrant | undefined                      // N-5：首查 revokedAt 已置位 → 直接 undefined（no-op 不审计不落盘）；再查已过期 → expired 分支；否则 user 分支 + 审计
  matches(toolName: string, realPath: string): PermissionGrant | undefined   // prune + 工具 + 后端身份 + 目录段边界 + 未撤销未过期
  prune(): void                                 // 惰性过期处理（matches/list 触发）+ 审计 grant:expired
}
```

- **matches 目录段边界**：`realPath === dir || realPath.startsWith(dir + '/')`（对齐 `isPathBlacklisted` 段边界语义——防 `/granted` 误配 `/granted2`）；Windows 大小写不敏感比较（`toLowerCase` 对齐 policy 先例）。
- **matches 后端身份（F-2）**：`grant.backendIdentity === deps.backendIdentity()`；`backendIdentity()` 返回 undefined（未连接/连接目标未定）→ **不匹配任何 grant**（fail-safe 落 prompt，不存在「无身份宽松匹配」）。
- **黑名单复核**：`add` 时（创建流 Main 侧选择目录后）`isBlacklisted(normalizeDirectory(dir))` 命中 → 抛 `ToolServiceError('PATH_BLOCKLISTED')`（用户无法授权黑名单目录，D6C-05）；`matches` 不做黑名单复核（决策链 step 5 已先拒——黑名单优先，grant 匹配发生在 step 8）。
- **幂等（N-6）**：`add` 对「同 toolName + 同目录（归一化后）+ 同身份 + 未撤销未过期」返回既有 grant（不重复创建）——防同一 awaiting 请求重复「允许指定目录」堆积重复条目。
- **双 backendIdentity 同源（V-3）**：`GrantStoreDeps.backendIdentity`（matches 读）与 `ToolServiceDeps.backendIdentity`（grantDirectory 捕获）注入**同一闭包实例**——index.ts 单一定义 `() => { const u = connConfig.getEndpoint(); return u ? new URL(u.origin) : undefined }`，两处引用同一引用；分叉会导致 grant 恒不匹配（fail-closed 但功能静默失效）。
- **持久化**：`add/revoke/prune` 改动后 `settings.save({ tools: { grants } })`（全量 tools 子树提交，patch merge 不 clobber voice/live2d）；save 失败 fail-open（grant 内存生效 + 审计，落盘失败记录日志——对齐 fail-open 纪律）。
- **装载期校验（N-8 留档 + 轻量校验）**：settings.json 装载后对 grants 逐条复核（`expiresAt` 为有限正数、`scope.directory` 非空、`toolName`/`backendIdentity` 形状合法），越界条目静默剔除并记日志（`settings:grant-invalid`）；**不**做黑名单装载复核（黑名单在 step 5 恒先拒，注入 `/etc` 无效果）；整文件 schema 单条坏 grant 触发全部设置 corrupt 重建与 voice/live2d 同款风险——决策记录注记「settings.json 属本机受信面，篡改即全量失守」+ doc 07 注记。
- **审计（F-10 定案）**：`grant:created/revoked/expired` 经 **`deps.audit` 直调**（不进 `auditToolEvent`——`ToolAuditInput.type` 是闭合 5 值 union，无 `grant:*` 成员；`AuditEvent.type` 为自由 string，直调合法）；`grant:created { toolId, permissionGrantId, backendIdentity, summary:'目录授权（工具 <toolName>，有效期至 <ISO>）' }`（**F-5/N-2：不含目录绝对路径，含 backendIdentity**——目录仅存 settings.tools.grants 与 `tool:grants`，不进审计/诊断导出）；`grant:revoked { cancelSource:'user' }`；`grant:expired`。

**tool-service 接线（D6C-04/05）**：`ToolServiceDeps` 增 `grants?: GrantStore 接口`（createGrantStore 注入；缺省 undefined → 无 grant 面，决策链跳过匹配）+ `pickDirectory?: (opts) => Promise<{ canceled: boolean; path?: string }>`（创建流注入，集成测试替换）+ `backendIdentity?: () => string | undefined`（F-2：grant 创建时绑定当前连接指纹；index.ts 装配 `() => connConfig.getEndpoint()?.origin`——**懒绑定闭包**：connConfig 创建晚于 toolSvc 无妨，仅 grant 创建时求值）。

**装配时序定案（V-4，HIGH）**：`index.ts` 现状顺序为 `createToolService`（:211）→ `new ConnectionConfig`（:246）→ `new SettingsService`（:269）。GrantStore 依赖 settingsSvc、tool-service 依赖 GrantStore——**settingsSvc 创建 + `load()` 上移至 `createToolService` 之前**（settingsSvc 不依赖 toolSvc，无环；load 需在 grant 读取前完成，正好满足 GrantStore 构造时 settings 已装载）；随后 `const grantStore = createGrantStore({ settings: settingsSvc, ... })` → `createToolService({ grants: grantStore, ... })`。**`backendIdentity` 仍为懒绑定闭包**（connConfig 晚创建无妨，仅 grant 创建时求值）。§8 验收清单补「装配顺序：settingsSvc 先于 toolSvc（V-4）」。**决策链 step 8**（`handleRequest` 授权判定段）改造：

```typescript
// 8 授权判定（D6C-04）：grant 匹配前置（read/write，内部含后端身份+目录段边界+未过期未撤销）；capture 恒强确认；黑名单优先（step 5 已拒）
// F-8：grant 匹配优先于 selected-set 豁免（双命中 → allow_scoped 审计）
const grant = (req.toolName === 'desktop.file.read' || req.toolName === 'desktop.file.write') && realPath
  ? deps.grants?.matches(req.toolName, realPath) : undefined
const decision = tool.permissionMode === 'automatic' ? 'auto'
  : grant ? 'auto'                                    // F-10/N-7：捕获 grant 引用——审计 permissionGrantId 有来源
  : (req.toolName === 'desktop.file.read' && realPath && isExempt(realPath)) ? 'auto'
  : 'prompt'
```

**grant 匹配执行路径**：匹配命中 → `run(rec, tool)`（与 auto 同路径；**F-4：write 命中时 `rec.diff` 已在 step 7 计算，`tool:event` 照常下发 → 卡片只读展示 Diff + 写入内容摘要，无确认按钮**）；**审计授权来源**：`run()` 前对 grant 匹配命中情况审计 `tool:decision { permissionDecision:'allow_scoped', permissionGrantId: grant.id }`（区分 allow_once——历史查看器跳转撤销数据源；`grant.id` 来自上面捕获的引用）。

### 3.3 创建流 + CyToolApproval「允许指定目录」（D6C-05）

**CyToolApproval 改造**（仅 `record.toolName ∈ read/write && status==='awaiting_permission'`）：
- 按钮区增「允许指定目录」`data-testid="approval-grant-dir"`（对等权重，与拒绝/允许一次同级，doc 04 §7.3「允许指定范围」）；
- 点击 → 展开有效期选择（`select` 1 小时/24 小时/7 天/30 天，默认 24h）→「确认授权」→ `toolStore.grantDirectory(callId, ttlMs)` → 提交期间禁用（L-8 防抖）；
- 提交后窗口关闭（当前请求经 grant 匹配自动执行，卡片转 running）；
- 取消选择器/授权失败 → 请求保持 awaiting 态不误判。

**IPC `tool:grant-directory`**（`tool-handlers.ts` 增 handler）→ tool-service `grantDirectory(callId, ttlMs)`：

```typescript
async function grantDirectory(callId: string, ttlMs: number): Promise<void> {
  if (!deps.grants) throw new ToolServiceError('TOOL_STATE_INVALID', '目录授权不可用')   // F-14：grants 缺省装配显式降级而非崩溃
  const id = idOf(callId); const rec = id ? records.get(id) : undefined
  if (!rec || rec.status !== 'awaiting_permission') throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 不在等待授权态')
  const tool = deps.registry.get(rec.toolName)!
  if (tool.toolName !== 'desktop.file.read' && tool.toolName !== 'desktop.file.write') throw new ToolServiceError('TOOL_STATE_INVALID', '该工具不支持目录授权')
  if (!rec.realPath) throw new ToolServiceError('PATH_UNSAFE', '目标路径不可用')
  if (!GRANT_TTL_OPTIONS_MS.includes(ttlMs)) throw new ToolServiceError('INVALID_ARGUMENTS', 'ttl 不在授权选项内')   // F-3：Main 侧白名单（schema 层已 union 拒，此处双保险）
  const identity = deps.backendIdentity?.()   // N-4：先取身份——undefined（断连）不创建僵尸 grant
  if (!identity) return   // 断连 → 不创建（保持 awaiting；fail-closed）
  const picked = deps.pickDirectory ? await deps.pickDirectory({ title: '选择授权目录' }) : { canceled: true }
  if (picked.canceled || !picked.path) return   // 取消 → 保持 awaiting 态
  if (rec.status !== 'awaiting_permission') return   // N-1：dialog 期间 expiresAt 定时器可能已触发——已终态不得复活（grant 不建、不 run）
  if (deps.backendIdentity?.() !== identity) return   // V-5：dialog 期间连接切换 → 身份复核失败 → grant 不建（保持 awaiting，防「已授权却静默不执行」）
  const grant = deps.grants.add({ toolName: rec.toolName, scope: { directory: picked.path }, backendIdentity: identity, expiresAt: Date.now() + ttlMs, source: 'directory' })  // add 内含 blacklist 复核 + N-6 幂等 + V-1 归一化存储
  if (!(rec.realPath && deps.grants.matches(rec.toolName, rec.realPath))) return   // F-1：picked 目录不覆盖请求目标 → grant 已建但不执行，保持 awaiting（不二次弹窗）
  audit('tool:decision', rec, { permissionDecision: 'allow_scoped', permissionGrantId: grant.id })
  const t = timers.get(rec.id); if (t) { clearTimeout(t); timers.delete(rec.id) }   // F-6：run 前清 expiresAt 定时器（对齐 decide 先例，防执行完成后被翻转 timeout 双终态）
  try { await run(rec, tool) } finally { promoteQueue(rec.id) }   // F-16：promoteQueue 与 run 结果无关、恒执行（防 run 抛错队列卡死；decide() 同步确认）
}
```

**L-3 守卫前移（N-1 补充）**：`run()` 入口、`rec.status = 'running'` 赋值**之前**补 `if (rec.status !== 'requested' && rec.status !== 'awaiting_permission') return`——对已终态记录整体拒绝（现 L-3 复查看在 `withPathLock` 后、状态已置 running——救不了「定时器过期后复活」路径）。

**pickDirectory 默认实现** = `dialog.showOpenDialog({ properties: ['openDirectory'], title })` 封装（Main，注入对齐 `pickFile` 先例）；mock 模式注入 fake（集成测试 fixture 目录）。**TTL 白名单常量（校验权威 Main，F-3）**：`GRANT_TTL_OPTIONS_MS = [3600_000, 86_400_000, 604_800_000, 2_592_000_000] as const`（1h/24h/7d/30d）+ `GRANT_DEFAULT_TTL_MS = 86_400_000`（24h）——放 `shared/contracts/tool.ts`（UI 展示枚举与 Main 校验共用**同一常量**，renderer 可读选项值但 Main 侧校验以同一枚举为唯一权威——schema union 校验拒绝枚举外值）。**F-18 定案**：`GRANT_DEFAULT_TTL_MS` 仅供 UI 默认选中（renderer 消费）；Main 不接受缺省 ttlMs（schema 必填），无默认应用路径。

### 3.4 CySecurityPane（新建 `renderer/src/components/CySecurityPane.vue`，D6C-07）

**CySettingsView 接线**：`NAV_ITEMS.security` 的 placeholder 移除，`CySecurityPane v-else-if="activeNav === 'security'"`（对齐 CyLive2DPane 先例）。

**页面结构**（三分区，内部滚动不溢出——CyLive2DPane 布局纪律）：

```
授权管理（grants 直读 tool:grants，改动后 toolStore/组件本地刷新）
├─ 活动 grants：卡片列表（工具名/目录（展示摘要，全路径来自 tool:grants——F-7 记录：授权目录非秘密、设置页可见、TTL 有限，doc 07 注记）/后端（serverUrl origin，N-2：切换后端后用户可见 grant 绑定旧端点）/有效期/「撤销」按钮 data-testid="grant-revoke"）
├─ 已撤销/已过期：灰显（revokeSource 标注），无按钮
└─ 空态：「暂无长期授权。在工具权限确认时选择「允许指定目录」可添加。授权存储在本机，可随时撤销。」
审批历史（tool:history 只读，HISTORY_MAX=200）
├─ 过滤行：工具（select：全部/read/write/capture）+ 结果（select：全部/允许/拒绝/执行成功/执行失败/已取消）+ 搜索框（text，匹配 summary/toolId）
├─ 列表：每项 ts（本地时间）/toolId/toolName/status 徽标/permissionDecision/summary（脱敏，grant:created 摘要不含目录路径——F-5）/errorCode
│   ├─ permissionDecision='allow_scoped' → 「撤销此授权」按钮（permissionGrantId → tool:grants 查活动 → 有则 tool:grant-revoke）
│   └─ 全部只读（不渲染原始参数——历史不落安全数据）
└─ 空态：「暂无审批历史。桌面工具执行记录将在此显示。」
命令模板（F-08 关闭）
└─ 空态：「未启用受控命令执行。桌面工具仅包括文件选择/读取/写入与屏幕捕获，不支持任意命令执行。」（无列表无注册入口）
```

**IPC 消费（renderer store 层）**：`toolStore` 增 `grantDirectory(callId, ttlMs)` / `listGrants()` / `revokeGrant(id)` / `listHistory(limit?)`（对齐 `decide/cancel` 调用 `api.toolGrantDirectory(...)` 等——preload 具名窄 API）。**命名映射钉死（F-23）**：IpcChannels 键 `toolGrantDirectory` / `toolGrants` / `toolGrantRevoke` / `toolHistory` ↔ preload 方法 `toolGrantDirectory(input)` / `toolListGrants()` / `toolRevokeGrant(id)` / `toolListHistory(limit?)` ↔ store 方法 `grantDirectory` / `listGrants` / `revokeGrant` / `listHistory`——键名（wire）与调用名（动词+名）方向可辨，一一映射如上，实现/测试不得混用。

**preload（`desktop-api.ts`）** 增：`toolGrantDirectory(input)`、`toolListGrants()`、`toolRevokeGrant(id)`、`toolListHistory(limit?)`——全部 zod 校验 + 具名窄 API 无通用通道。**ipc-security 白名单 63→67 + 类型镜像（可行性 F-5）**：`tests/integration/ipc-security.spec.ts` 逐键清单补 4 键（R-B11 先例延续）+ `preload/index.d.ts` desktopApi 类型 + renderer `stores/desktop-api.types.ts` DesktopApiLike 镜像同步。

**schemas（`shared/schemas/ipc-response.ts`）**：`grantDirectorySchema { callId: string, ttlMs: z.union([z.literal(3600_000), z.literal(86_400_000), z.literal(604_800_000), z.literal(2_592_000_000)]) }`（F-3：union 白名单，枚举外值 → `SCHEMA_VALIDATION_FAILED`）、`grantListResponseSchema = PermissionGrantSchema.array()`、`grantRevokeSchema { id }`、`historyEntrySchema`（ts/toolId/toolName/status/permissionDecision/permissionGrantId/backendIdentity/riskLevel/cancelSource/errorCode/summary 全可选）+ `historyResponseSchema = historyEntrySchema.array()` + `toolHistoryQuerySchema { limit?: number }`。

**`main/ipc/tool-handlers.ts`** 增 4 handler（`toolGrantDirectory` / `toolGrants` / `toolGrantRevoke` / `toolHistory`）；**deps 扩展钉死（可行性 F-6）**：`registerToolHandlers` deps 从 `{ tools, sanitize }` 扩为 `{ tools, sanitize, grants, history }`（`history` = audit 回读器，见 §3.4 下段；`index.ts` 装配传 `dirs.audit`）。`toolGrantRevoke` 未知 id → `ToolServiceError('GRANT_NOT_FOUND')` 结构化拒绝（F-17 钉死）；**区分机制（V-28）**：`revoke(id)` 对已撤销（`revokedAt` 已置位）与未知 id **均返回 undefined**——handler 先查 `grants.list().some(g => g.id === id)` 区分「未知 id → GRANT_NOT_FOUND」与「已撤销/已过期 → no-op 幂等成功（不报错，防双撤骚扰）」。**`toolHistory` 回读器钉死为独立模块 `main/tools/tool-history.ts`**（与 grant-store 解耦：grant-store 管 grants 状态，tool-history 管审计回读）——`readAuditEvents(dir, opts: { limit?, days? })`：readdir 按文件名倒序（`audit-YYYY-MM-DD.jsonl`）取最近 `HISTORY_DAYS = 7` 天（F-4 钉死天数常量），逐行 JSON parse 过滤 `type.startsWith('tool:')||type.startsWith('grant:')`，合并后 ts 倒序 `slice(0, Math.min(limit ?? 200, HISTORY_MAX))`（**200 为合并结果总量上限；逐文件流式读满即停，不整文件 parse**——R8）；损坏行跳过不崩溃（logger.warn）。**注记（F-11 一致性）**：`settings:load` 为 invoke 非推送通道（F-12）——grant 变更后设置页组件本地刷新（工具服务无推送）；`settings:load` 响应将含 `tools` 子树（F-11 可行注记），渲染面以 `tool:grants` 为权威刷新源，settings.store 不消费 tools（与现状一致，无新接线）。

### 3.5 L-1~L-8 收口（D6C-09a~h）

**tool-service.ts**：
- L-1：`MAX_RECORDS = 200` 常量 + `handleRequest` 创建记录后 `evictIfNeeded()`（超限 → 找 `startedAt` 最旧终态逐出 + `byCallId` 清 + timers/captureTimers 清）；
- L-3（N-1 前移）：`run()` 入口、`rec.status = 'running'` 赋值**之前**补 `if (rec.status !== 'requested' && rec.status !== 'awaiting_permission') return`（对已终态记录整体拒绝）；`withPathLock`/`executors.execute` 前既有复查保留；
- L-7：`confirmUpload()` 终态 `emit(rec)` 前清 `captureSources/capturePreview`（对齐 `terminal()` L3 先例）；
- L-8：`decide/cancel` 内部无需改（handler 层 `.catch`）。

**real-backend.ts**：
- L-4：`case 'tool.request'` 包 try/catch（fail → logger.warn + 不 emit 不崩溃）。

**text-diff.ts**：
- L-6：`MAX_DIFF_LINE_BYTES = 2000` + `computeTextDiff` 行截断。

**tool-handlers.ts**：
- L-8：`tool:decide/tool:cancel` handler 包 `Promise.resolve(...).catch(logger.warn)`（不产生 unhandled rejection）。

**tool.store.ts / CyToolApproval.vue**：
- L-2：`init()` 增 `api.toolList()` 水合——**先 `await toolList` 水合完毕、再订阅 `onToolEvent`（F-15 定序：防旧快照覆盖新事件；水合快照 = Main 权威快照，后到事件增量覆盖，D6B-21 规则对水合不适用——水合只是冷启动补齐，事件永远新于快照）**；**tool:list 非终态不设 20 条上限（F-3 一致性）**：`listRecent` 增 `includeNonTerminalAlways` 语义——非终态（awaiting/running/requested）全量返回 + 终态补足到 limit，防长会话中头部 awaiting 水合不到；
- L-8：允许/拒绝/授权按钮提交期间 `disabled`。

### 3.6 GET /api/tools/calls/{callId}（D6C-11）

**`DesktopCallStatus` 类型 + schema 钉死（契约 F-2 / 可行 F-8 / 一致 F-7）**：全新类型（仓库现无）——`shared/contracts/backend.ts` 增 `DesktopCallStatus` + `shared/schemas/ipc-response.ts` 增 `DesktopCallStatusSchema`（`.strict()` 镜像后端契约 `frontend_contract/contract.raw.ts:1586-1610`）**并在 `apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts` 导出（V-12：check:contract REST 段解析目标文件 `mod[path[0]]`——rest-schemas.ts 可复导出 shared 定义，否则 `mod['DesktopCallStatusSchema']` 为 undefined 导致 REST 段检查失败、「REST 15/16」目标不可达）**：

```typescript
export type RepoCallStatus = 'pending' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'expired' | 'offline'
export interface DesktopCallStatus {
  callId: string; toolName: string; toolVersion: string; runtime: string; paramHash: string
  status: RepoCallStatus              // repo 9 值枚举（非 ToolWireStatus 六态！result→succeeded、error→failed 为后端固定翻译）
  createdAt: string; expiresAt: string    // UTC ISO（必填）
  result?: Record<string, unknown>; error?: Record<string, unknown>   // 可缺省
}
```

**映射定案（D6C-11/reconnect 三分支扩展）**：`expired` → `terminal(rec,'timeout')`；`cancelled`/`rejected` → `terminal(rec,'cancelled')`；`succeeded`/`failed`/`pending`/`accepted`/`running`/`offline` → **保持本地状态**（禁止自动执行，doc 02 §16.2 纪律——`succeeded` 后端已完成但本地无 result 帧，不重投、不伪造结果）。

**`real-backend.ts`**：`getToolCallStatus(callId): Promise<DesktopCallStatus | null>`——`GET ${serverUrl}/api/tools/calls/${callId}`（复用 `restFetch` 既有 GET 模式）+ Bearer + `DesktopCallStatusSchema.safeParse`；连接断开/缺端点/非 2xx/解析失败 → `null`（降级）。**`mock-backend.ts`**：返回 `null`（无端点，注释记录取舍）。

**`tool-service.ts` reconnect 接线**：`ToolServiceDeps` 增 `queryStatus?: (callId: string) => Promise<DesktopCallStatus | null>`（real 注入；mock 装配**不注入** → `undefined` 不查——D6C-11「mock 恒 null」表述以本句为准，F-20）；`reconnect()` 对 awaiting_permission 记录（非终态、连接刚恢复）调用 `queryStatus`——按上表三分支映射。**单测**：注入 fake queryStatus 断言 expired/cancelled/null 三分支。

### 3.7 M-1/M3 收口 + 评估结论（D6C-10/13）

见 §0 决策表（M-1 确认 / M-3 否决 / action 保留 / 跨页配对不适用 / M-8 保留 in-Renderer）——实现期无代码改动（M-1/M3），仅决策记录落文。**新文件写 TOCTOU 守卫（facts 修正，一致性 F-2）**：`writeFile` 在 `atomicWriteFile` 前补 `if (rec.diff?.isNewFile && fs.existsSync(p)) throw FILE_CONFLICT`——授权时不存在（`preReadForDiff` 置 `isNewFile:true`、无 `oldHash`）→ 执行前被创建 → 拒绝覆盖（原文件保持）；**补单测断言**（见 §3.8 tool-executors.spec.ts 行）。

### 3.8 测试（单测 + 集成）

**单测（`tests/unit/`）**：

| 文件 | 用例 |
|---|---|
| `grant-store.spec.ts`（新） | list/add/revoke/prune 全分支；matches 目录段边界（等于/子目录/`/granted2` 不误配/Windows 大小写）；**matches 后端身份（F-2：身份匹配/身份变更不匹配/backendIdentity() undefined 不匹配/**origin 归一：同 origin 不同路径后缀 → 仍匹配（F-11 正方向，V-13）**）**；**V-1：picked 路径带尾斜杠/symlink → add 存储归一化值 + matches 命中**；**revoke 已过期 grant → expired 分支标注（F-9）；revoke 已撤销 grant → no-op 不覆写不重复审计（N-5）**；**add 幂等（同 toolName+目录+身份+未撤销未过期 → 返回既有，N-6）**；过期惰性清除 + grant:expired 审计；黑名单复核拒（PATH_BLOCKLISTED）；save 落盘（settings mock）+ fail-open；id 生成（`grant-` + randomUUID 前缀断言，F-5）；**grant:created 审计 summary 不含目录路径但含 backendIdentity（F-5/N-2）**；**装载期逐条校验剔除畸形 grant（N-8）** |
| `settings-tools.spec.ts`（新） | ToolsSettingsSchema default（无 tools → 空 grants）；SettingsStateSchema 兼容（version 1 + tools 可选）；ToolsSettingsPatchSchema 无 default 不 clobber（IP-1）；settings-service.save tools merge 不丢 voice/live2d |
| `tool-service.spec.ts` 增 | 决策链 step 8 grant 匹配（write 命中 → auto 执行无窗；read 命中；capture 恒确认；未命中 → prompt；黑名单优先——step 5 先拒不触 grant；**exempt 与 grant 双命中 → 审计 allow_scoped（F-8 一致：grant 匹配优先于豁免）**；**auto 路径事件携带 rec.diff（F-11 一致 b）**；**grant 匹配命中审计 permissionGrantId = 匹配 grant.id（N-7 一致）**）；grantDirectory 创建流（pickDirectory 注入 fake/取消保持 awaiting/黑名单目录拒/授权后自动执行/审计 allow_scoped+permissionGrantId/**F-1 picked 目录 ≠ 请求目标 → 不执行保持 awaiting**/**F-3 ttl 非白名单值 → INVALID_ARGUMENTS**/**F-6 授权流超 expiresAt → 仅一次终态**/**N-1 dialog 挂起期间 expire → 不执行仅一次终态**/**N-4 断连 → 不创建 grant**/**V-5 dialog 期间连接切换 → 不创建 grant**/**F-14 grants 缺省 → TOOL_STATE_INVALID 不崩溃**/**F-16 run 抛错 → promoteQueue 恒执行**）；L-1 records 驱逐（>200 逐最旧终态、awaiting/running 不逐）；L-3 执行器进入前 status 复查（**含 run() 入口守卫：已终态记录直接拒绝，N-1**）；L-7 confirmUpload emit 无陈旧 capture 字段；reconnect queryStatus expired/cancelled/null 三分支 |
| `ipc-tool-handlers.spec.ts` 增（F-7 可行：文件名为既有 ipc-tool-handlers.spec.ts，非 tool-handlers.spec.ts） | 四新通道 handler 接线 + **既有注册顺序断言扩展为九通道** + SCHEMA_VALIDATION_FAILED + isTrustedSender + decide/cancel `.catch` 无 unhandled rejection + **grant-revoke 未知 id → GRANT_NOT_FOUND（F-17）** |
| `tool-history.spec.ts`（新） | audit JSONL 回读（readdir 倒序/HISTORY_DAYS=7 天边界/逐行 parse/filter tool:*+grant:*/ts 倒序/HISTORY_MAX=200 合并总量上限/逐文件流式读满即停）；损坏行跳过不崩溃；**historyEntry 含 toolName/backendIdentity（N-2）** |
| `text-diff.spec.ts` 增 | L-6 单行超 MAX_DIFF_LINE_BYTES 截断 + truncated 置位 |
| `real-backend-tools.spec.ts` 增 | `getToolCallStatus` GET 组装 + DesktopCallStatusSchema 解析（**repo 9 值 status 全分支 + 缺字段拒收，契约 F-2**）+ 断线/非 2xx → null（夹具扩展） |
| `tool.store.spec.ts` 增（happy-dom） | L-2 init 水合（toolList 返回记录 → records 归位；**先水合后订阅事件、快照不覆盖事件，F-15**）；grantDirectory/listGrants/revokeGrant/listHistory 调 api |
| `cy-security-pane.spec.ts`（新，happy-dom） | 三分区渲染；授权管理撤销按钮 → revokeGrant；**已撤销/已过期灰显 + 无撤销按钮 + revokeSource 标注（F-25）**；审批历史过滤/搜索；allow_scoped 条目「撤销此授权」跳转 → **跳转后调用 revokeGrant(permissionGrantId)（F-21 一致）**；命令模板空态文案；**授权管理卡片显示后端身份（N-2）** |
| `cy-tool-approval.spec.ts` 增（happy-dom） | 「允许指定目录」仅 read/write 显示；TTL select 默认 24h（消费 GRANT_DEFAULT_TTL_MS）；提交禁用防抖（L-8）；grantDirectory 调用；**写 grant 命中卡片只读 Diff 渲染（无确认按钮，F-11 一致 c）** |
| `tool-executors.spec.ts` 增 | **新文件写 TOCTOU 守卫（facts 修正/一致性 F-2）：rec.diff.isNewFile + 执行前文件被创建 → FILE_CONFLICT（原文件不变）** |

**集成（`tests/integration/electron-tools.spec.ts` 增，xvfb-run）**：

| 用例 | 路径 |
|---|---|
| 目录授权闭环（read） | `CYRENE_MOCK_TOOL_FLOW` read fixture + mock `pickDirectory` 注入 fixture 目录 → 发送 → 权限窗 → 「允许指定目录」→ 确认（默认 24h）→ 卡片「执行完成」+ audit 断言 allow_scoped；再次触发同目录 read → **无权限窗自动执行**（grant 命中）|
| 目录授权闭环（write + 只读 Diff，F-11 一致 a） | write fixture → 「允许指定目录」授权写目录 → 再次触发同目录 write → 无权限窗自动执行 + **卡片只读 Diff 出现（无确认按钮）** |
| 授权撤销 | 上述建立 grant → 打开设置 → 「安全与权限」→ 授权管理 → 「撤销」→ 再次触发 read → 权限窗重新出现（grant 失效）+ mock lastToolStatus 断言 |
| 审批历史查看器（含历史跳转撤销，F-21 一致） | 若干工具事件后 → 设置「安全与权限」→ 审批历史 → 事件出现 + 过滤按工具 + allow_scoped 条目「撤销此授权」**点击 → grant 失效 → 再次触发 read → 权限窗重新出现** |
| 命令模板空态 | 设置「安全与权限」→ 命令模板分区空态文案出现（F-08 关闭） |
| 黑名单目录拒 | mock pickDirectory 返回 `/etc`（黑名单）→ 「允许指定目录」确认 → 卡片保持 awaiting + 无 grant 落盘（软断言，SwiftShader 风险同 capture 条款） |
| 后端身份不匹配（N-3/F-1 一致） | mock `backendIdentity()` 派生自 serverUrl origin + `CYRENE_MOCK_GRANT_BACKEND_IDENTITY` env（useMock 门控）→ 授权后翻转身份 env → 再次触发 read → 权限窗重新出现（grant 失效）|

**门禁（F-6-25 延续）**：typecheck / lint / test / xvfb-run test:integration / build / check:contract（**WS 32/32 + 8 未纳 warn；REST 15/16（V-14：与 §8 对齐——DesktopCallStatus 入 REST_TARGET_MODELS 后 15→16）；本批不改 raw wire → `rawSchemasFingerprint()` 不变 → 13 组 manifest 不刷新**；唯一例外：若实现期必须修改服务端帧 shape → `refresh-wire-manifests.mjs`）。

### 3.9 承载项

- **AuditEvent 扩展**（`main/diagnostics/audit.ts`）：`permissionGrantId?: string` + **`toolName?: string`（契约 F-5：审批历史按工具过滤/展示的数据源——AuditEvent 现无 toolName，tool-service 内部 audit 闭包与 tool-audit.ts 映射需补写；doc 04 §14 ToolAuditRecord 既有该字段）+ `backendIdentity?: string`（N-2：grant:created 携带）** + `cancelSource` 已有；`grant:created/revoked/expired` 事件类型（`AuditEvent.type` 自由 string，无需 schema 枚举；**经 `deps.audit` 直调，不进 `auditToolEvent`——`ToolAuditInput.type` 为闭合 5 值 union，F-10 契约**）；
- **`tool:decision` 审计扩展**：`permissionDecision` 加 `'allow_scoped'` 值（`ToolAuditInput.permissionDecision` 类型 + `audit.ts` AuditEvent 字段扩展，D6C-06 历史跳转数据源）；
- **`toolList` 水合不破坏既有**：`init()` 内 await toolList + upsertLocal（仅非终态必需，终态可选——工具服务已有记录不重复弹窗，幂等）；
- **mock `pickDirectory` 注入**：`CYRENE_MOCK_GRANT_DIRECTORY` env（**单个 JSON 字符串路径**，非法/空 → undefined 不注入——F-9 可行：目录是单值不是数组；useMock 门控：真实模式误设不注入，M-2 批次最终 review 纪律延续）；**mock 后端身份（N-3 定案）**：`useMock` 装配注入 `backendIdentity: () => (process.env.CYRENE_MOCK_GRANT_BACKEND_IDENTITY ?? new URL(mockServerUrl).origin)`——**env 在闭包内每次调用实时读取（V-2：供集成测试中途翻转 env 断言身份不匹配，装配期捕获会持旧值假失败）**；MockBackend 本身无 backendIdentity 方法（该指纹属装配层语义，非 transport 方法）；**集成测试隔离（V-2）**：身份翻转用例测试末复位 env + 清理本用例创建的 grant（或 fixture 目录逐用例唯一），防残留 grant 命中后续用例权限窗断言。

## 4. 安全设计

- **信任边界延续**（doc 07 三层）：grant 创建/撤销/匹配全在 Main；Renderer 只收脱敏历史条目 + grants 列表（无原始参数/无文件内容/无 token）；`tool:grant-directory` 只送 `{callId, ttlMs}`（目录选择在 Main，renderer 无法指定黑名单目录——**黑名单复核在 Main add 时强制**，D6C-05）；
- **黑名单优先**（D6C-04）：grant 匹配发生在决策链 step 8（黑名单 step 5 已拒）；用户无法授权黑名单目录（add 复核 PATH_BLOCKLISTED）；`/tmp` 黑名单测试放宽经 `CYRENE_MOCK_TOOL_ALLOW_ROOT`（生产不注入）；
- **grant 安全属性**（D6C-03/04）：只授权 read/write；目录段边界匹配（防 `/granted2` 误配）；**有效期强制——无永久 grant：`ttlMs` 白名单在 schema 层 + Main 侧双重校验（F-3：renderer 送枚举外值 → `SCHEMA_VALIDATION_FAILED`/`INVALID_ARGUMENTS` 拒绝，`expiresAt` 必填且派生自白名单 ttl）**；**后端身份绑定（F-2）：grant 绑定授权时连接指纹（serverUrl origin），切换端点 → 不再匹配（fail-safe 落 prompt）；token 变更不失效（契约 F-4 记录为已知语义）**；撤销后立即失效（matches 检查 `revokedAt`）；**撤销/过期只影响后续匹配（F-13：in-flight running 请求继续至终态，不中断）**；**黑名单目录不可授权**；**capture 无 grant 面恒强确认**；**写 grant 命中无确认窗但卡片只读展示 Diff + 写入摘要（F-4：diff 数据 step 7 恒计算，`tool:event` 照常携带，可见性不丢）**；
- **历史只读脱敏**（D6C-08）：审批历史只读 audit 产物（summary 已脱敏 `redactSensitiveValues`）；不落文件内容/截图/token/未脱敏参数；**grant:created 摘要不含目录绝对路径（F-5：目录仅存 settings.tools.grants 与 `tool:grants`，审计/诊断导出不落敏感路径——doc 07 §12 纪律）；`tool:grants` 下发目录全路径为授权管理功能必需（F-7 记录：授权目录非秘密、设置页可见、撤销即时生效、TTL 有限——doc 07 注记该暴露面）**；`permissionGrantId` 仅 id（非敏感）；
- **IPC 面**（D6C-12）：四新通道全 zod 双端 + `SCHEMA_VALIDATION_FAILED` + `isTrustedSender`；`tool:history` 只读不写；`tool:grant-revoke` 只接受 `{id}`（grant id 不可控为任意路径）；
- **残余风险（M-8 评估结论，D6C-13）**：保留 in-Renderer 权限 UI；缓解层（raw .strict() + Main 黑名单/风险重算 + capture 子状态机）延续；**新增缓解**：grant 创建黑名单复核在 Main（renderer 无法授权黑名单路径）+ 撤销操作 Main 校验 id 存在性；**F-8 记录**：被攻破 renderer 可任意撤销 grant（仅骚扰级、无权限提升——与 M-8 同档接受）。阶段 7 安全收敛再评估原生对话框。
- **fail-open**：grant save 落盘失败不阻塞操作（内存生效 + 审计 + 日志）；历史读取失败 → 空态（不阻塞设置页）。

## 5. 文档同步（代码批落地时一并更新）

| 文档 | 更新点 |
|---|---|
| `docs/02` §16.2 | GET tools/calls 前端实现注记（real 已实现 + mock 降级，联调复核）；**repo 枚举 9 值表述修正（契约 F-2：原「repo 枚举比前端 ToolCall.status 多 expired/offline」松散错误——repo 枚举非前端 8 态超集）**；`DesktopCallStatusSchema` 经 rest-schemas.ts 导出（V-12） |
| `docs/03` | **新增（F-10 一致）**：CySecurityPane 三分区布局 + CyToolApproval 第三入口「允许指定目录」+ TTL 选择 + 写 grant 命中只读 Diff 卡 |
| `docs/04` | §7.2/§7.3 授权范围落地（目录授权+有效期+撤销+**后端身份绑定**）；**§7.4 PermissionGrant 形状改写对照（契约 F-7：spec 形状 `{id, toolName, scope:{directory}, backendIdentity, expiresAt:number, source, revokeSource?}` vs doc 04 原 `{subject, subjectId, toolNames[], argumentConstraints?, expiresAt?:string}`——字段对照表 + 「参数限制」降级为「目录范围约束」决策记录）**；§7.4 授权记录（settings.tools.grants + grant 生命周期审计）；§14 历史查看器落地（audit 回读 + 过滤/搜索/跳转撤销）+ AuditEvent `permissionGrantId`/`toolName`/`backendIdentity`；**§8.3 补注（F-19 一致）：grant 命中自动执行时 Diff 以只读形态随 tool:event 下发（无确认按钮），Diff 可见性保留** |
| `docs/06` §14 | settings.tools 子树 + GrantStore 边界注记 |
| `docs/07` | §9 目录授权安全（**F-9 一致补两要素：后端身份绑定（切换端点 → grant 失效）+ `tool:grants` 全路径暴露面注记（F-7）**；黑名单优先/grant 匹配 step 8/目录段边界/有效期强制/历史脱敏 + settings.json 篡改即全量失守注记 N-8 + **backendIdentity（origin）进入 audit JSONL/tool:history 暴露注记（V-4：用户已知配置数据、可接受；诊断导出随审计携带时同口径）**）|
| `docs/11` | **新增（F-10 一致）**：「安全与权限」子树改写为授权管理（grants）/审批历史/命令模板空态——沙盒/黑名单 UI 明确不落地（D6B-14 常量化注记） |
| `docs/12` | **F-08 关闭**（命令模板空态确认，受控命令不进入 Demo）；§9.7 批次 C 状态 |
| `docs/16` | F-6 批次 C 状态 + changelog 行 |
| `docs/13` | 本批决策交叉 review 结论 |
| `README` / `CLAUDE.md` | 阶段 6 批次 C 状态与测试计数（三态 = 已开发、未联调）|
| `docs/review/2026-08-20-阶段6批次C-决策记录.md`（新） | D6C-01~13 + 预检拍板 + Rulings + 执行偏离 + 门禁 + 验收结论 |

## 6. 范围外（明确不做）

- 真实 Windows Electron 联调（开发者批次后，三态升「已真实联调」）；`GET` 真实链路联调验证归此；
- `desktop.command.run` 注册（全阶段不注册）+ local_worker 工具；
- action 兼容帧移除（保留至阶段 8）；跨页/跨会话归档配对（历史查看器基于 audit 事件不适用）；
- M-8 原生确认对话框实现（本批只记录评估结论）；
- 写文件编码转换能力（仅格式保留，批次 B 现状）；capture 平台扩展（Wayland portal/录屏/定时捕获）；
- grant 跨会话共享/迁移/导入导出；设置页「开发与诊断」子页。

## 7. 前置动作与风险

- **前置**：后端 `03a6e882` 未 push（纪律：永不代 push）；本批不依赖新后端端点——`GET /api/tools/calls/{callId}` 契约来自 doc 02 已确认映射，real 先行 + mock 降级，联调复核。
- **R1（目录路径入审计）【已关闭，F-5 定案】**:grant:created 摘要**不含**目录绝对路径（「目录授权（工具 X，有效期至 ISO）」）——目录仅存 settings.tools.grants 与 `tool:grants`，审计/诊断导出不落敏感路径（doc 07 §12）。原「目录可入审计」方案因 review F-5 否决。
- **R2（目录授权写 Diff 取舍）【已关闭，F-4 定案】**：grant 命中自动执行**无确认窗**，但 `tool:event` 照常携带 `rec.diff`（step 7 恒计算）+ 写入内容摘要 → 卡片**只读展示 Diff**（非授权门、无确认按钮）——doc 04 §8.3 Diff 可见性以只读信息形态保留。原「完全不展示」方案因 review F-4 否决。
- **R3（mock pickDirectory 注入）**：`CYRENE_MOCK_GRANT_DIRECTORY`（**单个 JSON 字符串路径**，F-9 可行：目录是单值非数组）useMock 门控；集成测试 fixture 目录注入。
- **R4（grant 后端身份对齐）【已关闭，F-2 定案】**：`PermissionGrant.backendIdentity` = 授权时连接指纹（`new URL(serverUrl).origin`；real-backend mapper 身份先例 `real-backend.ts:505`；mock 派生自 mock serverUrl origin + `CYRENE_MOCK_GRANT_BACKEND_IDENTITY` env 可切换，N-3）；`matches` 要求身份一致——**切换端点 → grant 不匹配（fail-safe 落 prompt，doc 04 §7.2「后端身份」硬性要求本批落实）**；**token 变更不失效（契约 F-4 已知语义，如需失效引入 token 派生指纹——不得明文存 token，本批不做）**。原「不存后端身份 + 联调待定」方案因 review F-2（HIGH）否决。
- **R5（paramHash 浮点，L-5）**：四工具实参均字符串不触发；联调引入数值参数时复核（决策记录留档）。
- **R6（GET tools/calls mock 降级）**：mock 无端点 → `null`；**mock 装配不注入 `queryStatus` → 不查（F-20）**；集成测试断言 mock 路径不崩 + 单测覆盖 real 组装；真实链路联调验证。
- **R7（records 驱逐对 pending 影响）**：L-1 只逐终态；awaiting/running/requested 永不逐出（权限窗不消失）；极端并发超 200 非终态时 liveOrder 短暂超长（批次 B 既有取舍延续，L-1 注记）。
- **R8（历史读取性能）**：audit 逐行 parse 最近 `HISTORY_DAYS = 7` 天文件（F-4 钉死天数常量；readdir 倒序 + `HISTORY_MAX = 200` 为**合并结果总量上限**，逐文件流式读满即停）；设置页打开频率低，无性能敏感。
- **R9（F-7 记录）**：`tool:grants` 向 renderer 下发授权目录全路径 = 功能必需（设置页展示/撤销）；授权目录非秘密、TTL 有限、撤销即时——doc 07 注记该暴露面，不额外脱敏（展示形态与权限窗 pathSummary 的差异留档）。
- **R10（F-8 记录）**：被攻破 renderer 可任意撤销 grant（id 可枚举自 tool:grants）——仅骚扰级、无权限提升（renderer 本可对 pending 自动 allow_once），与 M-8 同档接受，不设额外校验。
- **R11（N-8 记录）**：settings.json 属本机受信面，被篡改（形状合法）可注入非黑名单敏感目录 grant——防护：黑名单 step 5 恒先拒（`/etc` 注入无效）+ schema strict 枚举只允 read/write + 装载期逐条校验剔除畸形条目 + 形状失败 → corrupt 隔离回默认（grant 全清，fail-safe）。「无永久 grant」保证仅在创建流成立（装载期不复查 expiresAt 上限）——记录为接受，doc 07 注记。
- **R12（F-14/F-16 代码纪律）**：grantDirectory 入口 `if (!deps.grants) throw`（缺省装配显式降级非崩溃）；`run` 后 `promoteQueue` 恒执行（try/finally，decide() 同步确认）。
- **R13（V-27 维度编号映射）**：四轮 review 各自编号 F-1~F-11/F-1~F-25/N-1~N-9/V-1~V-28 跨维度重复——执行期决策记录 Rulings 以「维度:编号」登记引用（如 可行:F-4、契约:F-2），spec 正文已标注维度来源。
- **R14（V-28 revoke 双 undefined 区分）**：`revoke` 对「未知 id」与「已撤销」均返回 undefined——handler 先 `grants.list().some(id)` 区分：未知 → `GRANT_NOT_FOUND`；已撤销/已过期 → no-op 幂等成功（不报错，防双撤骚扰）。
- **R15（安全轮次 3 V-1~V-5）**：V-1 add 内部归一化存储（黑名单复核与幂等键均基于归一化值）；V-2 mock 身份 env 闭包惰性读取 + 集成测试末复位/清理；V-3 双 backendIdentity 同源单闭包实例；V-4 doc 07 补 origin 审计暴露注记；V-5 dialog 后身份复核（切换 → 不创建 grant）——全部已并入本 spec。

## 8. 验收清单与执行纪律

- [ ] settings.tools grants 子树（PermissionGrant 契约含 backendIdentity + ToolsSettingsSchema default + ToolsSettingsPatchSchema 无默认 + SettingsService.save merge + voice.ts 类型层 + version 1 向后兼容）
- [ ] GrantStore（list/add/revoke/prune + grant:* 审计（summary 无目录路径含 backendIdentity）+ 黑名单复核 + realpath 规范化 + matches 目录段边界 + 后端身份匹配 + add 幂等 + revoke 幂等 + 装载期逐条校验）
- [ ] tool-service 决策链 step 8 grant 匹配（read/write 命中 auto；grant 优先于豁免；capture 恒确认；黑名单优先；grantDirectory 创建流 + pickDirectory 注入 + 授权后自动执行 + ttl 白名单 + picked≠目标不执行 + 定时器清理 + 断连不创建 + 缺省显式降级 + run 入口守卫 + promoteQueue 恒执行）
- [ ] CySecurityPane（授权管理撤销+后端身份显示/审批历史过滤搜索跳转撤销/命令模板空态）+ IPC 四通道（grant-directory/grants/grant-revoke/history）zod 双端 + ipc-security 白名单 63→67 + 类型镜像
- [ ] L-1 records 驱逐（非终态不逐出）/ L-2 init 水合（先水合后订阅 + 非终态不设上限）/ L-3 run 入口守卫 / L-4 case try-catch / L-6 diff 截断 / L-7 confirmUpload 顺序 / L-8 decide.catch+按钮防抖
- [ ] M-1 确认 + M-3 否决（决策记录落文）+ 新文件写 TOCTOU 复核单测
- [ ] GET tools/calls real 实现（DesktopCallStatusSchema repo 9 值 + rest-schemas.ts 导出）+ mock 降级 + reconnect queryStatus 三分支单测 + REST_TARGET_MODELS 15→16
- [ ] 装配顺序：settingsSvc 创建 + load 上移至 createToolService 之前（V-4）
- [ ] 门禁全绿：typecheck / lint / test（新增单测全绿）/ xvfb-run test:integration（electron-tools 增目录授权 read+write/撤销/历史跳转撤销/空态/黑名单拒/身份不匹配用例）/ build / check:contract（WS 32/32 + 8 未纳 warn；REST 15/16；**manifest 不刷新**）
- [ ] 文档同步（§5 表含 doc 02/03/04/06/07/11/12/16/13）+ 决策记录 `docs/review/2026-08-20-阶段6批次C-决策记录.md` + doc13 交叉 review 结论
- [ ] 三态 = 已开发、未联调（真实 Windows Electron 联调归开发者批次后）

**执行纪律**：执行中若出现对 §0 决策的偏离，按既定流程处理——按推荐执行 → 记入决策记录（`docs/review/2026-08-20-阶段6批次C-决策记录.md`）→ 最终报告汇报。**spec/plan 各轮 code-review 上限 20 轮**（F-24 一致：本批体积 ≈ 批次 B，review 上限已放宽），超限未达 APPROVE 回主会话裁定并记录。**plan 分组建议（F-24）**：按「授权子系统（settings 子树+GrantStore+决策链+创建流）→ L/M 收口 → GET/reconnect → 设置页 UI（CySecurityPane+store+组件）→ 文档」五段拆 task。**最终报告必报项**：预检拍板四项（仅代码批/settings 子树/完整历史查看器/目录授权+有效期）、派生拍板（GET tools/calls 归属 / 历史数据源 / M-8 评估结论 / M-3 否决理由）、本 spec 全部 review 修复记录（安全 F-1~F-9 + 复核 N-1~N-9 + 可行 F-1~F-11 + 契约 F-1~F-11 + 一致 F-1~F-25）、执行期 Rulings、门禁结果、三态结论与批次 C 联调承接。
