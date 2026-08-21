# 阶段 7 批次 A（安全收敛）设计文档

> **For agentic workers:** 本文档为设计 spec（binding）。实现将按 `superpowers:writing-plans` 产出 plan 后经 subagent-driven development 执行。
>
> **状态：** 待 review（spec review 轮次 0）
> **日期：** 2026-08-22
> **Base：** `1ab4357`（阶段 6 真实联调验收 HEAD）
> **三态：** 本批次为 Mock 驱动实现——完成后标记「已开发、未联调」，真实 Windows Electron 联调归开发者批次后执行。

---

## 1. 背景与目标

阶段 6（工具/权限/Desktop P0）已于 2026-08-21 真实联调通过，阶段 3~6 全链「已真实联调」，阶段 7「安全、稳定性与性能收敛」进入条件（阶段 3~6 的 Demo 范围功能完成）已满足。

阶段 7 按四批推进：**7A 安全收敛**（本文档）→ 7B 稳定性（Renderer 崩溃恢复、缓存损坏、网络中断回归）→ 7C 性能基线（200 条混合消息/100 多分段/500 资源压测、内存增长测量）→ 7D 清理与集中修复（D-08/F-11 策略 + Blocker/Critical 修复 + 验收）。

本批次目标：**完成 doc 07 §16 安全测试面的缺口补齐与 doc 07 §17 发布安全门槛（20 项）的逐项核对**，落地「开发与诊断」设置页（日志管理/开发者模式/连接诊断/脱敏诊断导出），落地 Electron Fuses 关闭与产物级验证，建立敏感信息泄漏扫描常驻门禁。

### 1.1 范围（本批次 in-scope）

1. Markdown DOM 级净化（引入 DOMPurify）+ XSS/危险链接测试集
2. IPC 攻击面与超大输入核对测试 + CSP/导航/媒体来源测试缺口
3. 路径穿越/符号链接/重放/授权后参数变化测试缺口（大部分已有，补齐断言面）
4. 敏感信息泄漏扫描：黑名单 + `verify:sensitive` 常驻门禁脚本
5. 「开发与诊断」设置页：日志目录管理（路径/大小/保留期/打开/清理）+ 脱敏诊断导出（单 JSON）+ 连接诊断（只读）+ 开发者模式（开关+二次确认+脱敏展示项）
6. Electron Fuses：三项关闭落地（electron-builder 内置 electronFuses 配置）+ package 产物级读回验证 + ASAR 完整性评估记录
7. doc 07 §17 发布安全门槛 20 项逐项核对（产出核对表文档）+ 相关文档同步

### 1.2 不在范围（归后续批次/阶段）

- Renderer 进程崩溃恢复、缓存损坏恢复、网络中断回归（→ 7B）
- 性能基线与 200/100/500 压测、内存增长测量（→ 7C；H-08 基线机器拍板）
- D-08 资源缓存/过期清理策略、F-11 审批历史保留策略正式确认（→ 7D）
- ASAR 完整性校验（OnlyLoadAppFromAsar / EmbeddedAsarIntegrityValidation）实际启用（→ 阶段 8 打包批次，本批仅评估记录）
- 安装包/签名/发布渠道（→ 阶段 8）
- Mozilla 基线之外的安全审计引入（不做）

---

## 2. 决策

| # | 决策 | 定案 | 依据 |
|---|---|---|---|
| D7A-01 | Markdown 净化方案 | **引入 DOMPurify**（renderer 依赖，版本精确锁定 **3.4.14**——R2 已核 npm 最新稳定线）；`renderMarkdown` 改为 `marked → DOMPurify.sanitize → wrapCodeBlocks`；scoped 消毒器（`decodeEntities`/`sanitizeHtml`）移除。**仅用显式 ALLOWED_* 配置，不使用 USE_PROFILES**（与显式表互斥——DOMPurify 3.4.14 源码 `_initConfig` + happy-dom 实测铁证：html profile 整体覆盖显式表） | 用户拍板 2026-08-21；doc 07 §16/§17「Markdown/XSS 测试通过」口径最稳；消除 markdown.ts:4 已知限制注释 |
| D7A-02 | 诊断导出形态 | **单 JSON 文件**（循环依赖回避：不引入 zip 库）；含 schemaVersion/manifest/日志段/审计段/现场摘要 + 段级 sha256 | 用户拍板 2026-08-21；零新依赖、单文件易分享易校验 |
| D7A-03 | Fuses 落地时机 | **7A 落地**：三项关闭经 **electron-builder 26.15.3 内置 `electronFuses` 配置**（yml 键 `runAsNode`/`enableNodeOptionsEnvironmentVariable`/`enableNodeCliInspectArguments`——**已确认存在**，platformPackager.js:260-325 且在 pack 时翻转）；`@electron/fuses` 2.1.3 精确锁定（**ESM-only**——verify-artifact.cjs 经 `await import()`）；**读回断言**（`getCurrentFuseWire` 静态读文件）入 verify:artifact 静态阶段；**smoke 冲突解法（可行 R2-1）**：Playwright `_electron.launch` 硬依赖 `--inspect=0` 的「Debugger listening on」行（coreBundle.js:43975）——`EnableNodeCliInspectArguments=false` 下直接启动 flipped 产物必挂 → **smoke 前复制临时副本并 flipFuses 三项回 true 后启动副本**（产物本体保持 flipped，读回断言证明最终态） | 用户拍板 2026-08-21；doc 07 §17「从打包产物验证」 |
| D7A-04 | 开发者模式 | **设置页开关 + 二次确认**——**对 2026-08-08 阶段 1 前置决策（doc 16 §4.0「不进 P0 Demo：生产构建恒关 DevTools、远程调试恒关、无开启路径」）的明确修订**（动机：用户 2026-08-21 拍板选择 doc 11 §8.2 全量实现；Demo 需演示诊断能力）；会话态不持久化（重启恢复禁用）；远程调试端口恒关不变；已保存凭据不可读回不变；`devTools: true` webPreferences（开关成为 DevTools 唯一开启路径）；二道防线说明：renderer 可 invoke 直调 `diagnostics:dev-mode-set` 绕过确认——**接受**（与 M-8「renderer 本可对 pending 自动 allow_once」同档：不新增能力，二次确认仅防误触非防攻击） | 用户拍板 2026-08-21；doc 11 §8.2 |
| D7A-05 | 开发者模式持久化 | **不写 settings.json**（会话态，Main 内存 `devMode=false` 初始；重启即复位） | doc 11 §8.2「重启后恢复默认禁用状态」；同步修订 doc 07 §4「二次确认并重启后才可启用」矛盾句（→ 二次确认后可启用） |
| D7A-06 | 开发者模式展示项范围 | 六类可展示项全部落地但**只有元数据无正文**：脱敏协议事件（Main ring 200 + push，条目 `type` = 领域事件名——「Adapter 映射结果」展示由领域名本身承担（raw→domain 映射由 Adapter 完成，dev 面只展示 domain 名；**rawType 删除——BackendEvent 判别字段为 `event`，rawType 全 src 零命中且 real 兼容帧静默消费不 emit，无数据源——plan 准确性 H-3 定案**）、工具元数据（复用 tool:list）、Store 状态摘要（无消息正文，仅计数/枚举）、Live2D 性能读数（**延 7C**：未导出统计则不扩展 API，本批显示「不可用」）、详细前端日志（链接日志目录）、Renderer DevTools（开关本体） | doc 11 §8.2 七项减「Adapter 映射」（由事件条目映射对承担）与 Live2D 读数（延 7C）；「敏感面零正文」作为硬约束 |
| D7A-07 | 连接诊断 | 只读展示（status/serverUrl/protocolVersion/serverVersion/lastError），直接读 connectionStore，无新 IPC | doc 11 §8.2 连接诊断；connectionStore 字段齐备（facts §8） |
| D7A-08 | 诊断导出构成 | `schemaVersion/manifest`（appName/version/electron/chrome/node/platform/arch/os/exportedAt/packaged/mode + truncated 标志）/`summary`（连接现场：origin/状态/会话 id，无正文）/`logFiles`（每轮转文件尾 5MiB 行数组，≤3 文件）/`audit`（最近 30 天全量，超 15MiB 截尾并标 truncated）/`logSha256`+`auditSha256`。**15MiB 审计截断上限为本批次设计决策（docs 无此数，勿当文档要求）** | 对齐 doc 07 §12 敏感面；段边界与既有常量对齐（5MiB×3 轮转/30 天保留）；15MiB 为防御性上限 |
| D7A-09 | 导出前二次脱敏 | **逐行** `redactSensitiveValues(sanitize(line))`（日志行已双净化，导出时再跑——纵深，兑现 doc 11「导出前二次脱敏」）；**超长单行（>1MiB）整行丢弃并计数**（不在行中途截断——防脱敏残段）；纯函数 `buildExportPayload` 可单测 | doc 11 §8.1；doc 07 §12；安全复核 M-3 |
| D7A-10 | 导出落盘路径 | 用户 `showSaveDialog`（默认名 `cyrene-diagnose-YYYYMMDD-HHmmss.json`，filter .json）；`CYRENE_TEST_HARNESS=1` 时跳过对话框落 `dirs.temp`（集成测试可断言） | 集成测试先例（rejectForbiddenDebugSwitches harness 放行）；对话框不可自动化 |
| D7A-11 | 泄漏扫描门禁 | 新增 `verify:sensitive` 常驻门禁脚本（`git ls-files` 静态黑名单扫描 + **显式排除目录** `third_party/`（291 个 vendor 跟踪文件含 asm.js base64——必然误报，整体排除并注释理由）/`out/`（untracked 不扫）/`dist/` + 行级 allowlist，仿 check:contract/verify:artifact 的 node 入口 + 失败 exit(1)）；运行期断言归既有单测（redact/logger）与导出 payload 单测 | 仿 verify:artifact 秘密扫描先例（scripts/verify-artifact.cjs:28-56）扩展为全树；vendor 排除为必要性（安全复核 M-6） |
| D7A-12 | 日志清理语义 | `diagnostics:clear-logs`：`writer.clear()` —— **序列：flush 串行（await）→ 对当前 fd `ftruncate(0)`（fd 保持打开，append 模式不受影响）→ unlink 轮转历史文件** + 审计 `diagnostics:logs-cleared`；removedFiles/freedBytes 经 state.lastCleanup 回显（契约 R2 一致性：IPC 面收敛 z.undefined、D7A-12 措辞对齐） | 与运行中 writer 协调（facts §2：append-only fd，删文件不释放句柄——「先关 fd 再 truncate」序列矛盾，见可行性 M-3） |
| D7A-13 | IPC 超大输入口径 | **不加全局序列化守卫**；沿用 MAX_IPC_MESSAGE_BYTES=4MiB（响应装箱/入参既有）+ **无界字段直接补 maxLength**（默认值：title 200 / search query 512 / 消息发送 content 64KiB / 语音 commit text 10KiB / attachment 路径 1024——实现时按 channels.ts 实际无界字段清单逐一核对补值，清单入 plan）+ 测试断言（含 4097 token 先例、2048 URL 先例、1MiB audio 先例） | MAX_IPC_MESSAGE_BYTES 已存在（ipc.ts:90）+ IPC_MESSAGE_TOO_LARGE（errors:19）；安全复核 M-7：核对表升级为「直接补上限」而非接受风险 |
| D7A-14 | 敏感扫描黑名单 | Bearer/JWT/`sk-`/AKIA/40+ base64（复用 redact RULES）+ `AGENT_ACCESS_TOKEN=`/`ACCOUNT_TOKEN=` 赋值形态 + `-----BEGIN …PRIVATE KEY-----`；排除：**`third_party/` 整体排除**（vendor，含 228KB asm.js base64 必然误报）+ `out/`/`dist/`（未跟踪）+ 行级 allowlist（逐条注释「已人工核对无真实秘密」） | 对齐 verify:artifact 秘密扫描先例与 doc 07 §12；vendor 排除为必要性 |
| D7A-15 | 协议事件 tap 数据源 | **`BackendAdapter.subscribe` 语义升级为多处理器（Set）**（real/mock 双实现对齐——mock 现为单槽，升级防覆盖既有聊天订阅，可行性 H-4）；devTap 作为并列消费者经 deps 注入 adapter；条目字段白名单 `{ts, type, preview}`（`type` = 领域事件名；preview 仅元数据摘要：redact+sanitize 双净化 → 截断 ≤200 含尾标，禁 text/正文/arguments）；ring 200 FIFO；**推送节流 100ms**（ring 全量保留，超限丢弃并累计 dropped 计数随 state 返回） | 脱敏硬约束：原始 arguments/内容永不进 Renderer（阶段 6 批次 A 同纪律）；单槽覆盖为实测风险 |

---

## 3. Markdown/XSS（DOMPurify）

### 3.1 链路

```
renderMarkdown(text):
  html = marked.parse(text, { async: false })        // 不变
  clean = DOMPurify.sanitize(html, DOMPURIFY_CONFIG) // 新增（替代 sanitizeHtml）
  return wrapCodeBlocks(clean)                       // 不变（程序化添加 class，安全）
```

### 3.2 DOMPURIFY_CONFIG（常量导出，单测钉住）

- **不使用 USE_PROFILES**（DOMPurify 3.4.14 中与显式 ALLOWED_TAGS/ALLOWED_ATTR 互斥——显式表被 html profile 整体覆盖，实测 `javascript:` href/`onerror` 幸存——D7A-01 铁证）；仅显式：
- `ALLOWED_TAGS`：与当前渲染面持平的超集（marked 默认 GFM 输出）——`a, b, blockquote, br, code, dd, del, details, div, dl, dt, em, h1~h6, hr, img, ins, kbd, li, mark, ol, p, pre, q, s, small, span, strong, sub, summary, sup, table, tbody, td, th, thead, tr, u, ul`（**不含** input——任务列表 checkbox 由 marked 输出 `<input type="checkbox" disabled>`，渲染时将 input 剥离后任务列表标记文本残留，可接受；显式记录）
- `ALLOWED_ATTR`: `href, src, alt, title, width, height, class, start, type`（class 保留 `language-*`；**不含** `id/style/target/srcdoc/formaction/xlink:href`）
- `ALLOW_DATA_ATTR: false`
- `ALLOWED_URI_REGEXP: /^(?:[\u0000-\u0020]*)(?:(?:https?|cyrene|mailto):|(?!(?:[\u0000-\u0020]*)[a-z][a-z0-9+.\-]*:))/i`（**回溯安全形态（安全 R2-MED-1 修正）**：前导 C0/空格外层吞后，负向断言内层再吞一次——两层都吞后仍不成 scheme 才放行，消除「外层回溯让断言落空白位」逃逸；node 15 例实测含前导空格/TAB/C0/NBSP/内嵌换行变体全部拒。http/https/cyrene/mailto + 任意无 scheme 相对值（历史消息相对签名 URL 放行）。**双层机制注记**：DOMPurify 内部 `_sanitizeAttributes` 先 `ATTR_WHITESPACE` 全局剥离（purify.es.mjs:1644/:326）再测 regex——正则为第一层、库内剥离为第二层、CyMarkdown 点击层为第三层。`data:` 精确口径：**a href/object/embed 等非 img 属性全员剥**；`img src` 的 `data:` 经 DOMPurify DATA_URI_TAGS 分支保留（img 上下文无脚本执行面，且与 CSP `img-src data:` 一致——现状 sanitizeHtml 剥 data: 为更严口径，本批按 DOMPurify 默认行为记录为行为变更点）
- `SANITIZE_DOM: true`（默认）

### 3.3 保留与移除

- 保留导出：`renderMarkdown` / `wrapCodeBlocks` / `trimCodeText`（CyMarkdown.vue 消费面不变）。
- 移除：`decodeEntities` / `sanitizeHtml` / `DANGEROUS_TAGS` / `NAMED_ENTITIES`（DOM 级解析天然解码实体——`javascript&colon;` 类攻击由 DOMPurify 在解析后 URI 检查拦截，测试证明）。
- `marked` 版本（`^18.0.9`）不动；`dompurify` 加入 deps（安装实测稳定线，package.json 精确版本 + pnpm-lock 锁定）。

### 3.4 测试（两层——**安全门禁仅归第二层**）

**单元（happy-dom，markdown-sanitize.spec.ts——**文件头需 `// @vitest-environment happy-dom`**（vitest 默认 node），行为记录层，不充当安全门禁**（DOMPurify 官方 README 明确 happy-dom 非可信消毒 oracle——剥离结果随配置飘忽且与浏览器语义相悖，可行 H-2 铁证）：
- 既有 6 用例保义（基础渲染/script 与 onerror 剥离/entity 编码协议/代码块包裹/默认「代码」/代码内容含 script 被消毒）——**断言形态改为「输出不含可执行面字符串」的宽松记录**，若 happy-dom 下个别断言不成立，以「happy-dom 行为差异」记录不移除用例
- 新增：`data:` URL、`vbscript:`/`file:`、`cyrene:` 正方向、`javascript:` 大小写/混合写法/前导空白变体、svg/foreignObject/math、`style` 标签与属性、任务列表 input 剥离、编码嵌套——本层一律「记录行为」（通过/跳过记录差异）

**集成（真实 Chromium，新增 tests/integration/markdown-xss.spec.ts）——安全门禁层**：
- 负载注入机制（可行性 M-1 修复）：新增 mock env 桥 **`CYRENE_MOCK_REPLY_FIXTURE`**（mock 生成回复正文取自指定夹具文件——与既有 `CYRENE_MOCK_*` env 桥同构，经 getRuntimeInfo/装配注入，renderer 不读 env）；`launchApp` 注入载荷消息 → 渲染真实聊天 UI
- 断言（真实浏览器语义）：
  - `window.__xssFired` 哨兵未置位（script 执行检测）
  - 无 img[onerror] 触发（错误计数哨兵）
  - `javascript:` href（含前导空白变体）点击不导航（`will-navigate` 拦截 + 页面 URL 不变）
  - 无 onbegin/onload 类事件触发；无 style 注入；无 iframe/srcdoc 注入（DOM 查询不存在）
  - `data:text/html` 链接点击不注入 frame
  - **DOM 输出结构性断言**（对真实渲染后 DOM 层）：`a[href^="javascript:"]`/`a[href^="data:"]` 数量为 0（含前导空白变体）；全部元素无 `on*` 属性残留；无 `style=` 属性；无 iframe/object/embed/img[src^="data:image/svg"]——直接查 DOM 而非仅点击路径（安全 R2-MED-1：正则是否拦下对「点击不导航」断言无判别力，DOM 结构断言才是判别面）

---

## 4. IPC 上界核对与安全测试集

### 4.1 新专项单测 `tests/unit/ipc-limit.spec.ts`

以「通道上界核对表」常量（定义于测试内，逐通道注释来源）断言：
- 响应侧/入参侧既有 4MiB 先例（session-store stateBytes/chunk + cache.store chunk）行为不回退（已测，补引用断言）
- 1MiB audio 上限（已有 voice-handlers 用例，引用）
- 2048 URL 上限（openExternal，已有能力新增断言）——openExternal 超长 → 拒
- 4097 token（已有 ipc-security 集成用例，引用）
- **无界字段 maxLength 补全**（D7A-13 默认值表）：实现时核对 channels.ts 各 invoke 通道 schema 中无 `maxLength` 的字符串字段清单，补值——title 200 / search query 512 / 消息发送 content 64KiB / 语音 commit text 10KiB / attachment 路径 1024；核对清单 + 补值结果入单测断言（schema 上界存在性断言）

### 4.2 集成专项（扩展 tests/integration/ipc-security.spec.ts）

- 未知通道（`ipcMain.handle` 未注册名）invoke → 拒绝（既有能力，补断言形态：invoke 未注册 channel 报错而非成功）
- 超大对象入参（>4MiB 结构）→ 通道级 schema/上界拒（选择 1~2 个代表通道）
- 类型混淆（`{bytes: 'x'}` 等既有形态）抽样

### 4.3 导航/窗口安全缺口核对（补测试，无实现变更预期）

- `will-navigate` 对 `javascript:`/`data:` URL deny（既有实现，补集成断言）
- `setWindowOpenHandler` 非 http(s) 拒绝（既有，补断言）
- 媒体来源：`cyrene://__cyrene-media` 签名被篡改 → 拒绝（protocol-media-handler 已有测试，补「无签名/错签名」断言面）
- CSP 一致性：dev meta 与 prod 响应头关键指令一致性（dev-csp/protocol-csp 已有，补对照断言）

---

## 5. 敏感信息泄漏扫描（verify:sensitive）

### 5.1 门禁脚本 `scripts/verify-sensitive.mjs`

契约（仿 check:contract/verify:artifact 先例）：
- `pnpm -F @cyrene/desktop verify:sensitive`（package.json script；node 入口，无额外依赖）
- 扫描对象：`git ls-files` 全部跟踪文件（排除 `.playwright-mcp/` 产物目录——若跟踪则显式 allowlist）
- 黑名单（D7A-14）：`Bearer\s+[A-Za-z0-9._~+\/-]+=*` / `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+` / `sk-[A-Za-z0-9]{10,}` / `AKIA[0-9A-Z]{16}` / `AGENT_ACCESS_TOKEN\s*=\s*\S+` / `ACCOUNT_TOKEN\s*=\s*\S+` / `-----BEGIN [A-Z ]*PRIVATE KEY-----`
- **排除目录**（D7A-14）：`third_party/` 整体排除（vendor——291 个跟踪文件含 228KB asm.js base64，必然误报；排除注释写明理由）、`out/`/`dist/`（未跟踪，不扫）；其余命中走行级 allowlist
- allowlist：内嵌表，每行 `path → 正则模式或锚定段 → 理由`（预期：tests/fixtures 脱敏样例、leak-test 类夹具、docs 中说明性示例——首跑按实际命中精修，**allowlist 条目必须注明来源与「已人工核对无真实秘密」**）；**fail-loud 锚定**：锚定模式（路径+匹配段）不命中任何行时脚本报错（防行号漂移使 allowlist 静默失效——安全 LOW③采纳）
- 输出：违规清单（path:line + 命中类型），有任何违规 exit 1；全绿 exit 0 + 摘要
- 加入 CI：`.github/workflows/*` 现有 job 中加一步（与 typecheck/lint 同 job）

### 5.2 导出 payload 敏感断言（单测）

`buildExportPayload` 单测：注入含 token/密钥/IV 全文/工具敏感参数的模拟日志行与审计行 → 断言输出黑名单 0 命中 + 关键值已 `[REDACTED]`（复用 redact.spec 黑名单）。

---

## 6. 「开发与诊断」设置页

### 6.1 组件与导航

- 新建 `CyDiagnosticsPane.vue`（结构模板对齐 CySecurityPane：onMounted try/catch fail-open + data-testid 惯例 + cy-l2d-pane/group/sub 布局类）
- CySettingsView.vue NAV 映射：`diagnostics` 键 → `<CyDiagnosticsPane/>`（替换占位 div）
- 分区：① 日志管理 ② 开发者模式 ③ 连接诊断 ④ 脱敏诊断导出

### 6.2 通道（新增 6 个：5 invoke + 1 push）

| 通道 | 方向 | 请求 schema | 响应 schema | 语义 |
|---|---|---|---|---|
| `diagnostics:state` | invoke (0) | `z.undefined()` | DiagnosticsStateSchema | devMode/displayDir(已 sanitize)/logSizeBytes/保留天数/文件列表/dropped 计数 |
| `diagnostics:dev-mode-set` | invoke (1) | `z.object({enabled: z.boolean()})` | `z.undefined()` | Main 执行开关（见 6.4）；**幂等**（同值重复 no-op 不重复审计） |
| `diagnostics:open-log-dir` | invoke (0) | `z.undefined()` | `z.undefined()` | shell.openPath(dirs.logs) |
| `diagnostics:clear-logs` | invoke (0) | `z.undefined()` | `z.undefined()` | 清空（6.5） |
| `diagnostics:export` | invoke (0) | `z.undefined()` | ExportResultSchema | 导出（6.6） |
| `diagnostics:dev-event` | push | DiagnosticsDevEventSchema | — | devMode 时协议事件条目 |

> invoke 五个经 `createIpcHandler` + `registerHandler`（双向 zod）；push 一个**不是 registerOneWayHandler**——`diagnostics:dev-event` 是 Main→Renderer 下行：`PushChannels.diagnosticsDevEvent` + Main `webContents.send` + preload `ipcRenderer.on` 订阅（onToolEvent 先例，desktop-api.ts:387-395）。
> `diagnostics:state` 与日志信息合并（单一状态通道）；`diagnostics:clear-logs` 响应为 z.undefined()（结果经 state 刷新，不造第二响应形状）。

- Schema 契约（`shared/schemas/ipc-response.ts` 新增）：`DiagnosticsStateSchema {devMode: boolean; displayDir: string; logSizeBytes: number; logFiles: [{name, sizeBytes, modifiedAt}]; retentionDays: number; auditRetentionDays: number; eventDropped: number; lastCleanup: {removedFiles: number, freedBytes: number} | null}`（lastCleanup 承载 clear-logs 结果——清空后经 state 刷新回显；`DiagnosticsClearedLogs` 为对应契约类型）（`displayDir` = `createSanitizePublicMessage` 后形态——**绝对路径不上行**，安全复核 M-2；打开/清理用 Main 内部 dirs）；`DiagnosticsDevEventSchema {ts: string; type: string; preview: string}`（type maxLength 64、preview maxLength 200——**先 redact+sanitize 双净化再截断至 ≤200 且含尾标**（截 199+`…`；契约 R2-2：先截 200 再补尾标会变 201 字符 → preload 订阅侧 safeParse 静默丢弃）；preview 仅元数据：事件名/会话 id/长度字段，禁 text/正文/arguments）；`DiagnosticsExportResultSchema`（镜像命名——契约 R2-3，命名统一 `Diagnostics*Schema` ↔ `Diagnostics*`）**判别联合双分支带字面量**：`z.discriminatedUnion('cancelled', [z.object({cancelled: z.literal(false), displayPath: z.string(), sizeBytes: z.number(), truncatedLog: z.boolean(), truncatedAudit: z.boolean()}), z.object({cancelled: z.literal(true)})])`（契约 H-1 zod v4 铁证：缺字面量键直接抛错；`sizeBytes` 建议 `.nonnegative()`——仓库尺寸字段惯例）；`DiagnosticsClearedLogs` 契约类型（**响应收敛为 z.undefined()，+清空结果经 state 附带**——H-3 清理：removedFiles/freedBytes 归 state 字段或审计）
- **请求 schema 归位**：本体（state z.undefined()/devModeSet/openLogDir/clearLogs/export 请求）定义于 `main/ipc/channels.ts`（既有分层：请求 schema channels.ts、响应 schema ipc-response.ts——契约核准项）
- 类型 `DiagnosticsState`/`DiagnosticsDevEvent`/`DiagnosticsExportResult`/`DiagnosticsClearedLogs` 入**新建 `shared/contracts/diagnostics.ts`**（分组先例）；**barrel 同步**：`shared/contracts/index.ts` 补 `export * from './diagnostics'`（缺此 `@shared/contracts` 引用方不可导入——契约 L-1）；IpcChannels/PushChannels 新键按既有全表逐行 trailing 注释惯例（契约 L-2）
- **schema 镜像注解**：`DiagnosticsStateSchema`/`DiagnosticsDevEventSchema` 声明为 `z.ZodType<DiagnosticsState>`/`z.ZodType<DiagnosticsDevEvent>`（SettingsStateSchema 先例——注后 typecheck 钉镜像）并采用 `.strict()`（push 面未知键即失效载荷；契约 R2-4）
- `displayPath` 语义注记：为用户经 showSaveDialog 自选的**实际保存路径**（用户已知、回显无害）——与 `displayDir` 的「sanitize 后展示形态」语义区分（契约 R2-7）；§6.2 表首行标签统一为 `displayDir(已 sanitize)`（契约 R2-8）
- Preload 接线动 5 处（facts §8）：preload impl/d.ts、DesktopApiLike、受影响 mock 单测、集成 mirror d.ts（需要时）
- **白名单断言同步（契约 H-2）**：`tests/integration/ipc-security.spec.ts` 桌面 API 白名单键断言 67 → **73**；**键名定名（三处一致：spec/断言/plan，契约 R2-1）**——`diagnosticsState`/`diagnosticsDevModeSet`/`diagnosticsOpenLogDir`/`diagnosticsClearLogs`/`diagnosticsExport`（`export` 为 JS 保留字不可作方法名）/`onDiagnosticsDevEvent`（订阅键按先例加 `on` 前缀）；并补「push 键入 PushChannels 不入 invoke 白名单」断言
- **错误面（契约 MED）**：不新增错误码——openPath/导出/状态竞态失败以 `CyreneError(UNKNOWN...)` 错误码白名单 + 脱敏消息表达（executor 既有 ToolServiceError/CyreneError 分支）；`diagnostics:dev-mode-set` 幂等（同值 no-op）

### 6.3 新 Main 模块 `main/diagnostics/diagnostics-service.ts`（装配注入）

`createDiagnosticsService(deps: { dirs: {logs, audit, temp}; logger: Logger; auditor: Auditor; writer: FileWriter（运行日志 writer 引用——**获取路径**：`main/diagnostics/index.ts` `createDiagnostics` 扩展返回 `logWriter`（可行 R2-5：现返回 `{logger, auditor, closeAll}` 未暴露）; adapter: BackendAdapter（**事件源——非 EventEmitter**，可行性 H-4：后端事件经 BackendAdapter.subscribe，EventEmitter 不存在）; getConnectionSummary: () => {origin?, status?, protocolVersion?}; sanitize }): DiagnosticsService`

- `getState()` / `openLogDir()` / `clearLogs()` / `setDevMode(enabled)` / `exportPackage()` / `devEvents: ring buffer 200`
- **`BackendAdapter.subscribe` 语义升级为多处理器（Set）**：real/mock 双实现对齐（**MockBackend.subscribe 现为单槽**——直接并列订阅会覆盖 chat-service 既有订阅导致 mock 下聊天断流，可行性 H-4 铁证）——升级为多槽后 devTap 与既有消费者并列；adapter 为唯一事件源（dev tap 不为双路径装配引入第二入口）
- 装配：main/index.ts 在 createDiagnostics 之后构造（settingsSvc 上移先例 V-4 同款时序治理），注入 adapter 引用

### 6.4 开发者模式

- **状态**：`devMode: boolean = false`（会话态，Main 内存；不写 settings.json——D7A-05）
- **启用**（renderer 二次确认后 invoke `diagnostics:dev-mode-set {enabled:true}`）：
  - `mainWindow.webContents.openDevTools({ mode: 'detach' })`
  - devTap 激活（backend 事件 → `{ts, type, preview}` ring → pushChannel 推送；条目经 redactSensitiveValues）
  - 审计 `dev:mode-changed {enabled: true}`（无敏感字段）
- **禁用**：`closeDevTools()` + tap 停 +（renderer 清空展示）+ 审计
- **重启**：Main 初始化 devMode=false（无持久化）
- **webPreferences 调整**：`main-window.ts:50` `devTools: config.devToolsAllowed` → `devTools: true`（开关为唯一开启路径；**远程调试端口恒关不变**——rejectForbiddenDebugSwitches 不动）；F12 快捷键注册处（**main-window.ts:87-88** `before-input-event`，非 index.ts——可行 R2-4 已自查核实）门改 `config.devToolsAllowed || devMode`（打包态仅 devMode 时 F12 可用——该处读取通过**注入的 `isDevMode: () => boolean` getter**，装配于 main-window 构造调用处，避免窗口模块反向依赖服务）
- **二次确认文案**（renderer window.confirm）：明确告知「DevTools 可查看当前页面 DOM 与正在输入的内容；已保存凭据不可读回；远程调试端口始终关闭；重启后自动关闭」
- **状态标识**：pane 顶部横幅（devMode 时）+ badge
- **devTap 处理器异常隔离（可行 R2-3/安全 LOW①）**：devTap 回调体 try/catch 包全（real 侧 ws message 回调无兜底——real-backend.ts:495 emit 无 try/catch，devTap 抛错即断聊天事件流）；出错的单条事件丢弃 + logger.warn('diagnostics:dev-event-error')，不外抛
- **「直调滥用」接受档声明（安全 LOW②）**：`diagnostics:clear-logs`/`diagnostics:open-log-dir`/`diagnostics:export` 均为用户合法功能——被攻破 renderer 直调 = 骚扰级（清日志/弹对话框），无权限提升，与 dev-mode-set 同档接受；注明于决策记录
- **展示项**（devMode 时激活；全部元数据零正文）：
  - 脱敏协议事件列表（ring，时间/领域事件名/preview，无原始 arguments/frame 内容）
  - 工具 Schema 与能力（复用 tool:list/desktopApi.toolList）
  - Store 状态摘要（连接状态/origin/会话 id/消息计数/语音状态枚举——renderer 从 stores 读，无消息正文）
  - Live2D 性能读数（**确定性口径**：实现时检查 live2dStore/FrameBudget 是否已导出可读统计；未导出则不为此扩展 API——归 7C 性能批次，本批显示「不可用」并注记）
  - 详细前端日志（链接「打开日志目录」——复用 §6.2 打开通道）

### 6.5 日志管理分区

- 展示：目录（sanitize 后路径，复用 createSanitizePublicMessage）+ 当前大小（递归汇总）+ 保留期限（轮转 5MB×3 + 审计 30 天）+ 文件列表
- 操作：打开目录（`diagnostics:open-log-dir`）/ 清理日志（`diagnostics:clear-logs`——`writer.clear()` + 审计 `diagnostics:logs-cleared {removedFiles, freedBytes}`）
- **FileWriter 扩展**：`clear(): Promise<{removedFiles: number; freedBytes: number}>`——**序列（可行性 M-3 修正，与原「关 fd 再 truncate」矛盾）：① `await flush()`（batch 串行落盘）→ ② 对当前 fd `ftruncate(0)`（**fd 保持打开**，后续 append 不受影响）→ ③ unlink 轮转历史文件**；**clear 与 append 经 writer 内部同一串行队列**（可行 R2-7：勿绕过队列直接操作 fd——与 flush 同链）；单测（file-writer.spec.ts 增用例：清后 append 仍可写/轮转文件消失/大小归零/清中并发 append 不丢失）

### 6.6 脱敏诊断导出

流程（`diagnostics:export`）：
1. 收集：logs（读 `dirs/logs` 全部 `*.log`，每文件尾 5MiB **行对齐**）、audit（**直读 `audit-*.jsonl` 全量遍历——不 `readAuditEvents`**（其硬过滤 `tool:|grant:` + limit 200，与「30 天全量」矛盾，安全 M-4/可行 M-2），最近 30 天；超 15MiB **截尾并保留最新端**（按日文件从旧到新读取、超限后丢最旧——可行 R2-8）+ truncatedAudit）、summary（连接现场）
2. 每行二次脱敏（redactSensitiveValues + sanitize）；**超长行（>1MiB）整行丢弃并计数**（D7A-09）
3. `buildExportPayload(...)` 纯函数组装（manifest/truncated 标志/段 sha256）
4. `showSaveDialog`（harness 跳过落 temp；dialog 需 BrowserWindow 引用——main-window 模块已有）
5. 原子写（atomicWriteFile 先例）
6. 审计 `diagnostics:exported {sizeBytes, truncated}`（summary 无路径——F-5 同纪律）

**单测**：`buildExportPayload`（截断/行对齐/二次脱敏/黑名单零命中/sha 确定性）+ 导出服务（大目录 tail 读取）

---

## 7. Electron Fuses

### 7.1 决策

| Fuse | 值 | 理由 |
|---|---|---|
| RunAsNode | **关闭** | 打包产物不承担 node 子进程执行面（doc 07 §14 供应链/§17） |
| EnableNodeOptionsEnvironmentVariable | **关闭** | NODE_OPTIONS 注入面收口（与 rejectForbiddenDebugSwitches 双保险） |
| EnableNodeCliInspectArguments | **关闭** | 防止 `--inspect` 参数开启调试端口 |
| OnlyLoadAppFromAsar | 保持现状（false） | asar:false 现状；启用需 asar:true 全家桶，转阶段 8 打包批次评估 |
| EmbeddedAsarIntegrityValidation | 保持现状（false） | 同上；阶段 8 与签名（H-04）联动 |

### 7.2 落地（可行 R2-1/R2-2 修正——fuses 与 smoke 冲突方案定案）

- `electron-builder.yml` **内置 `electronFuses` 配置**（已确认存在，platformPackager.js:260-325，Linux 定位 executableName=Cyrene）：
  ```yaml
  electronFuses:
    runAsNode: false
    enableNodeOptionsEnvironmentVariable: false
    enableNodeCliInspectArguments: false
  ```
  （pack 时由 electron-builder 翻转三项；**无需 afterPack/自研 flip 脚本**——R2 已确认配置键形态）
- devDep 新增 `@electron/fuses`（**2.1.3 精确锁定**，**ESM-only**——`verify-artifact.cjs`（CJS）内经 `await import('@electron/fuses')`，`require` 会 ERR_REQUIRE_ESM）
- **读回断言**：`verify-artifact.cjs` 静态阶段（不启动 Electron）产物二进制存在时 `getCurrentFuseWire(binaryPath)` → 三项 DISABLE 断言，失败 exit 1（fail-closed）
- **smoke 冲突解法**（R2-1：Playwright `_electron.launch` 硬依赖 `--inspect=0` 的「Debugger listening on」行——coreBundle.js:43975/44061-66——三项关闭后直接启动 flipped 产物必挂 30s 超时）：`--smoke` 对 packagedExe 时**先复制临时副本 → `flipFuses(副本, 三项回 true)` → Playwright 启动副本**（产物本体保持 flipped——读回断言已证明最终态；smoke 断言的是 CSP/渲染/协议等不受 fuse 位影响的行为）
- `out/` 开发形态 smoke 不变（不涉及 fuse）
- 已知边界：flip-back 副本为临时文件（`os.tmpdir()`，用后删除）；若 flipFuses 对副本失败 → smoke fail-closed 拒绝启动
---

## 8. doc 07 §17 发布安全门槛 20 项核对表（交付物）

实现阶段产出 `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`，逐项表格：

| # | 门槛项 | 证据位置 | 状态 |
|---|---|---|---|
| 1 | Renderer 无 Node 直连 | webPreferences sandbox/contextIsolation/nodeIntegration（main-window.ts:44-57）+ trust-boundary 集成 | 已有 |
| 2 | Context Isolation 和 Sandbox 已启用 | 同上 + verify:artifact | 已有 |
| 3 | CSP 无通配/unsafe-eval | buildRendererCsp + dev-csp + 协议 handler + verify:artifact 断言 | 已有 |
| 4 | 受限自定义协议无 file:// | cyrene:// handler + protocol-handler 集成 | 已有 |
| 5 | 所有 IPC 校验来源与 Schema | registry isTrustedSender + 双端 zod | 已有 |
| 6 | Markdown/XSS 测试通过 | **本批**（§3，证据以真实 Chromium 集成层 markdown-xss 为准——单元层仅行为记录） | 7A 补齐 |
| 7 | Desktop 工具无通用命令入口 | 命令模板空态 F-08 + tool-registry | 已有 |
| 8 | 文件/截图权限测试通过 | 阶段 6（决策链/四执行器测试） | 已有 |
| 9 | Token 不出现普通存储/日志 | credentialStore + logger 双净化 + redact | 已有 |
| 10 | 密钥不回显；转写只引用兼容 STT Profile | 阶段 4 | 已有 |
| 11 | 自定义 Endpoint 安全测试 | 阶段 4 E-04 相关（**待核**：SSRF/重定向/Header 测试面——核对时确认，缺则补标注） | 待核 |
| 12 | 沙盒/黑名单/授权优先级 | 阶段 6 | 已有 |
| 13 | 已授权命令不能任意 Shell | 命令模板不注册（F-08 空态） | 已有 |
| 14 | 麦克风持续可见状态/清理；字幕不污染草稿 | 阶段 4 批次 B + 阶段 6 | 已有 |
| 15 | 开发者模式诊断脱敏；DevTools 边界告知 | **本批**（§6.4；无 DevTools 菜单旁路——生产菜单无 devtools 角色，F12 门单一：main-window.ts:87-88） | 7A 补齐 |
| 16 | 重放不重复副作用 | 阶段 6（幂等/paramHash/queryStatus） | 已有 |
| 17 | 生产默认关 DevTools + 远程调试恒关；显式启用仍脱敏 | **本批修订**（D7A-04：生产默认关 + 开关二次确认；远程调试恒关保持） | 7A 修订 |
| 18 | 发布包来源/完整性可验证 | verify:artifact + package 产物（完整性校验与阶段 8 签名联动） | **待核**（核对时确认现有证据面） |
| 19 | Fuses 已 Review 并从产物验证 | **本批**（§7） | 7A 补齐 |
| 20 | 高风险已知问题记录并接受 | 各阶段决策记录 + 本批已知限制（§10） | 本批补 |

> 注：doc 07 §17 实际条目数以文档原文为准（facts §10：362 行起）；核对表以「逐条原文引用 + 证据」为纲，实际张数在核对文档中确认。表中「待核」行（11/18）**结论须真实核查后给出（缺则记「证据缺口 + 影响面」而非默认通过），作为 7A 验收输入**——一致 N-5 闭合路径。

---

## 9. 测试计划汇总

- 单测（新增/重写）：markdown-sanitize（DOMPurify 层，happy-dom 文件头）、export payload（buildExportPayload）、diagnostics-service（setDevMode/ring/clear/state）、file-writer clear（含并发 append 串行）、ipc-limit 核对表（含 schema 上界存在性断言）、dev-pane 组件（happy-dom）
- 集成：markdown-xss（真实 Chromium，含 DOM 结构性断言）、diagnostics-ipc（harness 导出落 temp 断言黑名单零命中 + manifest + dev-mode 开关 webContents.isDevToolsOpened）、ipc-security 扩展（白名单 67→73 + PushChannels 归属断言）
- 门禁：verify:sensitive（含 CI 步骤）+ verify:artifact（fuse 读回断言 + smoke flip-back 副本启动）
- 既有全量回归：`pnpm test` / `pnpm test:integration`（xvfb）/ typecheck / lint / build / check:contract（应不受影响——wire 未变）

---

## 10. 已知限制与风险

1. **happy-dom 不是可信消毒 oracle**（DOMPurify 官方 README 明文「happy-dom…will likely lead to XSS」；3.4.14 + happy-dom 20.11.2 实测剥离结果随配置飘忽且与浏览器语义相悖，可行性 H-2）：**单元层仅作行为记录，安全门禁断言全归真实 Chromium 集成层**（§3.4 两层划分的根因）；单元用例若个别断言不成立按「happy-dom 行为差异」记录，不移除。
2. **任务列表 input 剥离**：GFM 任务列表 checkbox 被 DOMPurify 剥离（input 不在 ALLOWED_TAGS），选中态文本标记残留——聊天 Markdown 渲染可接受（历史消息无交互 checkbox 需求）；记录为已知行为。（前提说明：USE_PROFILES 移除后该行为由显式 ALLOWED_TAGS 保证，不再有「html profile 意外放行 input」的反向风险。）
3. **verify:sensitive 首跑误报**：repo 内说明性代码/夹具命中黑名单图案——行级 allowlist 精修逐条记录来源（D7A-14）；误报不允许「悄悄放行」；`third_party/` 整体排除由目录级注释说明理由。
4. **devTap 与既有订阅的耦合**：BackendAdapter.subscribe 多槽升级为**行为变更**（real 侧若已多槽仅 mock 单槽——以 mock 对齐为主）；升级后需回归既有订阅断言（chat-service/mock 断流场景单测）。
5. **Fuses 与 verify:artifact --smoke 的冲突（已定案）**：Playwright `_electron.launch` 硬依赖 `--inspect=0` 的「Debugger listening on」行（coreBundle.js:43975 铁证），`EnableNodeCliInspectArguments=false` 下直接启动 flipped 产物必挂——定案 = smoke 经 **flip-back 临时副本**启动（§7.2）；不在本批静默跳过 fuse 断言（读回 fail-closed）。
6. **开发者模式开关的既有口径变更**：「生产无 DevTools」旧断言面核实（verify:artifact 实无该断言——其负路径是调试门；受影响面为 webPreferences devTools 行 + 集成测试若断言 devToolsAllowed 则更新），变更处全部列出并修订 doc 07 §17 第 17 项口径。
7. **二次确认可被 renderer invoke 直调绕过——接受**：与 M-8「renderer 本可对 pending 自动 allow_once」同档（不新增能力，二次确认仅防误触非防攻击）；已写入 D7A-04。
8. **CYRENE_MOCK_REPLY_FIXTURE 测试桥**：新 mock env（集成 XSS 用例注入载荷用）——仅 mock 模式生效、renderer 不读 env（既有 CYRENE_MOCK_* 纪律）；不进生产路径。
9. **诊断导出大小**：15MiB + 30 天审计理论上限（audit 截断标志兜底）——导出操作同步阻塞主流程风险低（纯文件 IO，非网络），但实现优先流式写盘（先写临时文件再 rename）避免峰值内存。
10. **newline/TAB 内嵌控制字符向量**：`jav\tscript:`/`java\nscript:` 类变体已列入集成 DOM 结构性断言覆盖（§3.4）——真实浏览器语义下的判别面。
11. **单元测试环境注记**：新增渲染器单测必须带 `// @vitest-environment happy-dom` 文件头（vitest 默认 node——可行 R2-7）；dev-pane/markdown 两 spec 已如此标注。
12. **电子 `electronFuses` 内置配置的版本形态**：yml 三键以 electron-builder 26.15.3 实际 schema 为准（R2 已核 configuration.d.ts:235/475）；若升级 builder 版本键位变动，以 `electron-builder --help`/schema 校验兜底。

---

## 11. 三态与验收

- 本批为 Mock 驱动：完成后标记「已开发、未联调」。
- 验收（阶段级）：Blocker/Critical=0 + doc 07 §17 核对表全绿（含 7A 补齐项）+ verify:sensitive/verify:artifact/check:contract/全量测试门禁绿。

**doc 12 §9.8 验收 9 项 → 批次归属（一致性 M-8 修复）**：

| 验收项 | 归属 |
|---|---|
| Blocker/Critical 为 0 | 7A~7D 全程收口（本批产出的发现即修复或入 7D 清单） |
| 安全发布清单全部通过 | **7A**（§8 核对表） |
| 200 条混合消息滚动/操作 | 7C（压测） |
| 100 个多分段回复归组 | 7C（压测，Mock 大种子已有） |
| 500 个历史资源分页/过滤/切换 | 7C（压测） |
| 长流式/切换会话无明显持续内存增长 | 7C（内存测量） |
| Live2D 关闭后 CPU/GPU 明显下降 | 7C（已有 C2 降帧机制主体，7C 补基线记录与测量） |
| 崩溃/断线不破坏已确认消息与用户文件 | 7B（Renderer 崩溃/缓存损坏恢复） |
| 日志和诊断导出通过敏感信息扫描 | **7A**（verify:sensitive + 导出二次脱敏） |

- 真实联调（开发者批次后）：诊断导出在真实 Electron 上导出/打开/清理、开发者模式真机开关与 DevTools、XSS 载荷真实渲染面、fuse 翻转产物真机启动——通过后升「已真实联调」。

---

## 12. 文档同步清单（行为变更触达的文档）

| 文档 | 同步内容 |
|---|---|
| doc 07（v0.2） | **§4 基线句（84）**「二次确认并重启后才可按产品策略启用」→「二次确认后可启用（会话态，重启恢复禁用）」（一致性 H-1 矛盾句）；**§4 注记（91）**「阶段 8 Fuses 评估」措辞随 7A 提前（fuses 已落地，阶段 8 为产物复核）；§16 安全测试面标注「阶段 7 批次 A 已核对」；**§17 第 15/17 项口径修订**（开发者模式可经二次确认开启/远程调试恒关不变） |
| doc 01（v0.2） | **BackendAdapter.subscribe 多槽语义升级**（接口变更：单槽 → 多处理器 Set，返回取消订阅不变）——一致 N-1；doc 01 架构章节同步 |
| doc 11（v0.2） | §8 落地注记（日志管理/开发者模式/连接诊断/脱敏诊断导出实现态、会话态不持久化、二次确认文案、Adapter 映射由事件条目承担、Live2D 帧耗时读数延 7C 注记——一致 N-3） |
| doc 12（v0.1） | H-09 行（182）修订：开发者模式开放规则确认（默认关+二次确认开关）——**正式确认待产品 → 已确认**（引语归属 doc 16:166——一致 N-4） |
| doc 16（v0.1） | §2.8 H-09 行（166）升 [x] **并改写行本体**「开发者模式恒关」→「默认关 + 设置页二次确认开关（会话态）」；§4.0 决策表开发者模式行（209）修订并注记「2026-08-21 用户拍板修订」；line 232 落地项注记修订；阶段 7 §10 任务清单勾选与历史记录行 |
| doc 13（v0.1） | 安全策略变化（开发者模式）按 doc 13 规则执行**增量 cross-review——时机：批次落地后的文档同步轮**（需 doc 13 新章节记录；全量 cross-review 延至真实联调后收口；四维 spec review 不替代） |
| doc 08（v0.1） | 测试矩阵补充：markdown-xss 集成（真实 Chromium）、diagnostics-ipc 集成、verify:sensitive 门禁、fuse 读回断言 |
| doc 17 / README | verify:sensitive 命令说明 + README 命令表；fuse/打包相关命令注记 |
| README / CLAUDE.md | 门禁计数与状态（批量收口时统一更新） |
| 决策记录 | `docs/review/2026-08-22-阶段7批次A-决策记录.md`（D7A-01~15 + 拍板 + review 记录 + §验收） |
| 安全发布清单核对 | `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`（§8 表格落地为逐条核对结论） |
