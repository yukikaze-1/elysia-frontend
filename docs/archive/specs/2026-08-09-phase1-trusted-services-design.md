# 阶段 1 块 B：主进程受信服务 —— 凭据存储与日志/审计 —— 设计

**日期：** 2026-08-09
**状态：** 决策已拍板 + 已 code-review（第 8 轮干净）
**关联：** [doc 07 §11 凭据](../07-Cyrene-Electron前端安全设计-v0.2.md#L236)、[doc 07 §12 日志](../07-Cyrene-Electron前端安全设计-v0.2.md#L262)、[doc 16 §4.0 前置决策](../16-Cyrene-前端实施任务清单与进度跟踪.md#L195)、[块 A spec](2026-08-09-phase1-loading-env-design.md)（assertSafeLeaf 纪律、IPC executor）

---

## 1. 背景与目标

块 A 建立了安全加载/环境基线。块 B 在其上落地 **Main 侧两个受信服务**：凭据存储（safeStorage 后端 Token 持有）与日志/审计（脱敏落盘）。目标：

1. **凭据存储**：后端 Token 经 Electron `safeStorage` 加密落盘（`config/credentials.json` 0600），Renderer 只经 IPC 见 `credentialStatus`（4 值），绝不明文读回；`safeStorage` 不可用即拒存（不静默明文降级）；Token 允许 Main 内存持有（供阶段 2 transport 连接）；
2. **日志/审计**：手写轻量 JSONL logger（零新增依赖），`logs/app.log` 轮转 5MB×3；审计 append-only **`audit/audit-YYYY-MM-DD.jsonl`**（dir=audit，baseName='audit' 前缀 + 日期后缀）保留 30 天；**logger 无 msg 自由文本参数（消息正文/Inner Voice 无专用日志通道）**，Token 等秘密形态由落盘 redact 兜底（不宣称单一类型保证）；结构化字段落盘前过 `sanitizePublicMessage`；
3. 两服务复用块 A 的 `assertSafeLeaf` 文件安全纪律（O_NOFOLLOW + realpath 包含性 + 0600），不重复实现。

## 2. 范围

| 项 | 内容 |
|---|---|
| 凭据存储 | `credentials/`：safeStorage 封装 + 版本化加密凭据文件 + IPC（get-status/set/clear）+ credentialStatus 4 值 |
| 日志 | `diagnostics/`：共享 file-writer + `createLogger(module)` JSONL + 5MB×3 轮转 + 级别过滤 |
| 审计 | `diagnostics/`：append-only `audit/audit-YYYY-MM-DD.jsonl` + 启动清理 30 天前 |
| 装配 | main() 初始化 logger；IPC handler 接线；日志生命周期事件 |

**非目标（后续块/阶段）：** 诊断导出（阶段 7 统一做）、模型服务密钥的 Profile UI（阶段 4，仅复用本库）、真实 Token 供给/transport 连接（阶段 2）、公开事件订阅（阶段 2）。

## 3. 决策记录（拍板）

前讨论批次已拍板 + 本批按推荐执行并记录：

| # | 决策 | 结论 |
|---|---|---|
| B-1 | 诊断导出 | **本次不做**。doc 16 §4.0「诊断导出进 P0」的 P0 = **Demo 交付范围**（阶段 7/8 安全收敛实现，含导出前二次脱敏），非「阶段 1」——本块只立机制（JSONL 结构化日志/审计），导出实现归阶段 7。**块 B 文档收尾（docs/16 §4.0 + H-09 行）同步修正措辞为「诊断导出 = 阶段 7 安全收敛（Demo P0 范围）」**——不把「复核」拖成未决 action item，避免 tracker/ reviewer 单读 doc 16 误判本块未达 P0 |
| B-2 | Token 内存持有 | **允许 Main 内存持有**（供阶段 2 transport；Renderer 永不回读；clear 双删盘+内存） |
| B-3 | credentialStatus | **4 值**：`unavailable`（safeStorage 不可用/落 basic_text）/ `locked`（keyring 锁，decrypt 失败）/ `empty`（未存）/ `available`（已存可读） |
| B-4 | 凭据载体 | `config/credentials.json`（0600）+ 版本化 schema + 每 key 独立加密块；key 白名单（`backend.token`，未来 `model.*`） |
| B-5 | IPC 形态 | 通用 `credentials:get-status`（0 参）/ `credentials:set`（{key,value}，1 参）/ `credentials:clear`（{key}，1 参）；**key 白名单拒绝任意 key**；value 一次性提交 |
| B-6 | 日志实现 | **手写轻量** JSONL（零新增运行时依赖）；`createLogger(module)` → `logs/app.log` 5MB×3 轮转（纯函数可单测）；级别 error/warn/info/debug |
| B-7 | 日志禁记 | **无消息正文/IP 原文/Token 接收参数**（logger 只有 code/msg=固定事件码/fields）+ **落盘边界 sanitize + redact 秘密形态**（Bearer/JWT/base64）+ 审计复核——多重防线；不宣称单一类型保证（fields 开放 Record 可被显式传秘密值，redact 兜底） |
| B-8 | 审计实现 | 独立 append-only `audit/audit-YYYY-MM-DD.jsonl`；启动清 30 天前；sync append（持久优先） |
| B-9 | 共用写层 | 日志/审计共用 `diagnostics/file-writer.ts`（append-only：O_NOFOLLOW + realpath 包含性 + 0600 via fchmod，复用 assertSafeLeaf 纪律）；日志批量异步 + 退出 flush，审计同步。**凭据文件不用 append 写器**（multi-key JSON 需整文件读改写）——独立 `atomicWriteFile`：同目录 temp 写 + fsync + rename 覆盖 + fsync 目录（崩溃不截断） |

**实施中新增决策**：按目标指令追加到 §10 与最终报告。

## 4. 目标结构

```text
apps/desktop/src/main/
├── credentials/
│   ├── safe-storage.ts    # isSafeStorageUsable() / encrypt / decrypt（locked 检测）
│   ├── credential-store.ts# 版本化 credentials.json 读写（纯 fs + safeStorage，可注入假 safeStorage 单测）
│   └── index.ts           # 装配 + IPC handler（key 白名单、credentialStatus）
├── diagnostics/
│   ├── file-writer.ts     # 共享 append-only 安全写器（O_NOFOLLOW/包含性/0600；轮转 or 按日）
│   ├── logger.ts          # createLogger(module) → JSONL + 级别过滤 + 轮转 + 异步 flush
│   ├── audit.ts           # audit(event, fields) → audit/audit-YYYY-MM-DD.jsonl + 30 天清理
│   └── (已有 sanitize.ts)
├── persistence/
│   └── user-data-dirs.ts  # 导出 assertSafeLeaf（供 file-writer 复用；或抽共享安全写助手）
├── ipc/channels.ts        # + credentials 通道 zod schema
└── shared/contracts/
    ├── ipc.ts             # + credentials 通道常量
    └── credentials.ts     # CredentialStatus / CredentialKey 类型（无 Electron 依赖）
```

## 5. 关键实现

### 5.1 safeStorage 封装（credentials/safe-storage.ts）

```typescript
export type CredentialStatus = 'unavailable' | 'locked' | 'empty' | 'available'
export type CredentialKey = 'backend.token' // 未来: 'model.llm.*' 等

// safeStorage 可用性：isEncryptionAvailable() 且（Linux 上）非 basic_text 后端——
// basic_text 是明文降级（硬编码 key 的弱加密），按 doc 16 §4.0「不可用即拒存」视为不可用。
export function isSafeStorageUsable(safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'>): boolean
export function encryptCredential(safeStorage, plaintext: string): Buffer
export function decryptCredential(safeStorage, encrypted: Buffer): string  // 失败（keyring 锁）→ 抛 CredentialError(LOCKED)
```

- `isSafeStorageUsable`：`isEncryptionAvailable()` 且 **仅 Linux 额外查 `getSelectedStorageBackend() !== 'basic_text'`**（Linux 无钥匙串时 Electron 回退 basic_text——视为 unavailable，拒存）；**Windows/macOS 不调用 `getSelectedStorageBackend()`**（Electron 文档标注 Linux-only，非 Linux 行为未定义）——Windows 靠 DPAPI、macOS 靠 Keychain，`isEncryptionAvailable()` 已反映可用性；`process.platform === 'linux'` 分支显式写死。
- `decryptCredential` 抛 `LOCKED`（decrypt 抛错 = keyring 锁/解密失败）→ status 归 `locked`。**诚实边界**：decrypt 抛错在 Linux 上无法可靠区分「keyring 锁」与「加密块损坏」——spec 约定：**整文件 JSON 解析失败 → 整体不可用**；**单 key base64 非法 → 跳过该 key**（该 key unavailable，其余 key 正常）；decrypt 抛错（blob 形态合法但解不开）→ 归 `locked`。**为使 unavailable 与 locked 可区分，`enc` 解码必须先做严格 base64 校验**（`/^[A-Za-z0-9+/]*={0,2}$/` 且长度 `%4===0`）——Node `Buffer.from(s,'base64')` 宽容（非法字符不抛、截断也能解出垃圾字节），不做严格校验则损坏 blob 会解密抛错误归 `locked`（用户反复「解锁钥匙串」永远修不好）。`clear` 在两种情况下都可用（损坏 → 写全新文件，见 §5.2）。
- safeStorage 接口用 `Pick<...>` 注入（纯逻辑可单测，测试传假 safeStorage）。

### 5.2 凭据库（credentials/credential-store.ts）

```typescript
export interface CredentialFileSchemaV1 {
  version: 1
  keys: Record<string, { enc: string; algo: 'safeStorage' }> // enc = base64(encryptString 结果)
}
export class CredentialStore {
  constructor(private filePath: string, private safe: SafeStorageLike, private isKeyAllowed: (key: string) => boolean) // 注入谓词（来自 shared/contracts/credentials.ts，单一表示）
  async getStatus(key: CredentialKey): Promise<CredentialStatus>
  async setCredential(key: CredentialKey, plaintext: string): Promise<void>  // 不可用时抛 UNAVAILABLE
  async getCredential(key: CredentialKey): Promise<string | null>           // 仅 Main 内部（transport 用）
  async clearCredential(key: CredentialKey): Promise<void>
}
```

- 文件读写：`config/credentials.json`（块 A 的 `config/` 目录已建）。**写 = 原子替换**（`atomicWriteFile`）：
  - 同目录 `credentials.json.tmp` **`open(tmp, O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0o600)`**——**mode 参数直接 0o600**（umask 只清位不清 0600 的 group/other 位，open 即 0600，**消除 open→fchmod 窗口**）+ 创建后 `fchmod(fd, 0o600)` 兜底 → 写 + `fsync(fd)` → `rename` 覆盖 + **POSIX 下 `fsync(目录)`**（Windows 对目录句柄 fsync 抛错——**Windows 跳过目录 fsync，记录为 Windows 平台差异**）→ multi-key JSON 整文件改写，崩溃/中断不截断。**写前父目录（`config/`）realpath 包含性复核**（O_NOFOLLOW 只拦最后一段 temp，父目录被换 symlink 时 temp/rename 会落攻击者路径——与读路径、日志/审计写器同纪律，`config/` realpath 须落在 userData 内）；
  - **陈旧 temp 恢复**：`O_EXCL` 命中 `EEXIST` 时（单实例下无并发写者，残留 = 上次崩溃遗留）→ `unlink(temp)` 重试一次（仍 EEXIST → 抛）；不留永久砖。
  - 读同样校验（O_NOFOLLOW + realpath 包含性 + 0600）。
- 每 key 独立加密块（`{enc, algo}`），版本化 `version: 1`；**未知版本 → 拒读（不回退猜测），且 set/clear 同样拒绝写入**（`UNSUPPORTED_VERSION` 抛错——不静默覆盖未来版本文件销毁其键，也不永久不可用；这是显式失败态，用户可见可修）。（§7/§8 测试须覆盖写路径的未知版本拒绝，不只读路径。）
- **内部串行队列**：`ipcMain.handle` 不串行化 async handler，两个重叠的 set/clear（双击提交/快速操作）可能交错 read-modify-write 丢更新。`CredentialStore` 内用 promise 链单飞（`this.queue = this.queue.then(op, op)`——**两个参**，任一 op reject 只影响该次，`then(op, op)` 使后续 op 正常执行，不被陈腐 reject 毒化）串行化所有变更操作（set/clear）——不依赖「单窗口即串行」假设。
- `getStatus`（**顺序：版本检查优先，unavailable 优先于 empty**——否则 basic_text 新机器返回 empty 而非 unavailable，违背 B-3「unavailable + 提示解锁」语义；未知版本若读到 available 会与 set/clear 的 UNSUPPORTED_VERSION 自相矛盾）：① key 不在 allowlist → 忽略；② **版本未知（可解析但 version≠1）→ 该 key `unavailable`**（与写路径拒绝一致——显式失败态，用户可改不可读不成立）；③ **safeStorage 不可用 → `unavailable`**（先于空判定）；④ 整文件 JSON 损坏 → 该 key `unavailable`（clear/set 可重建）；⑤ 文件无该 key → `empty`；⑥ 单 key base64 非法 → 该 key `unavailable`；⑦ decrypt 抛错 → `locked`；⑧ 可读 → `available`。
- `setCredential`：safeStorage 不可用 → 抛 `UNAVAILABLE`（Renderer 收到 credentialStatus=unavailable + 提示，绝不静默明文落盘）；**遇损坏文件（JSON 解析失败）→ 写全新文件**（丢弃损坏内容，只含本 key——**与 clear 同语义：整文件重建，可能丢其他键**；阶段 2/3 设置 UI 对「损坏态 set/clear = 重建全部凭据」都要给确认信号，不只挂 clear）；成功后内存缓存（供 transport）。
- `clearCredential`：**遇损坏文件（JSON 解析失败）→ 写全新文件**（丢弃损坏内容，原子替换；**丢失其他键的代价显式标注**——损坏态下 getStatus 对该 key 报 unavailable，但 clear 是整文件重建非单 key 删除，阶段 2/3 设置 UI 须对「清除=重建全部凭据」给确认信号，本块在 status/clear 契约中记录此语义）；文件可解析 → 正常移除该 key 重写；safeStorage 不可用但文件可解析 → 仍可移除（不需解密）。
- `getCredential`（仅 Main 内部）：**缓存一致性**——`getStatus`/`getCredential` 解密失败（keyring 锁）→ **立即清除该 key 内存缓存**；后续 `getCredential` 重解密失败 → 返回 null（不再返回陈旧明文）。缓存生命周期 = 成功 set 后 / clear 时 / **解密失败时** / 退出时（B-G2 补记）。
- 并发：见「内部串行队列」——不依赖单窗口串行假设（ipcMain.handle 不串行 async handler）。

### 5.3 IPC（credentials:get-status / set / clear）

- `shared/contracts/ipc.ts` 加通道常量：`credentialsGetStatus: 'credentials:get-status'`、`credentialsSet: 'credentials:set'`、`credentialsClear: 'credentials:clear'`。
- `ipc/channels.ts` zod schema（**allowlist 单一来源在 `shared/contracts/credentials.ts`**——纯常量无 Electron 依赖，Preload 可 import（地基 P-7：Preload 只 import 类型/常量，不 import Main 运行时）；导出 `CREDENTIAL_KEY_ALLOWLIST`（当前 `['backend.token']`，通配语义预留 `model.*`）+ `isKeyAllowed(key): boolean` 纯函数——zod schema 的 `.refine(isKeyAllowed)`、store 注入谓词、preload 固定 key、响应 schema 全派生自它，杜绝四处漂移；`model.*` 通配由 `isKeyAllowed` 表达，非 zod enum）：
  - `credentialsSetSchema = z.object({ key: z.string().refine(isKeyAllowed), value: z.string().min(1).max(4096) })`；
  - `credentialsClearSchema = z.object({ key: z.string().refine(isKeyAllowed) })`；
  - `credentialsStatusSchema = z.object({ status: z.enum(['unavailable','locked','empty','available']), key: z.string().refine(isKeyAllowed) })`。
- handler（`ipc/handlers.ts` 注册）：`credentials:get-status`（**0 参，固定查 `backend.token`**——当前唯一 key；未来 `model.*` 加入时该通道增 key 参，本块不提前加）/ `credentials:set` / `credentials:clear` 统一返回 **`{ status, key }`**（key 回显用于确认目标；value 永不回显）。全部经 `createIpcHandler`（zod 校验 + sanitize 错误信封）。
- Preload `desktopApi` 加：`getCredentialStatus(): Promise<CredentialStatus>`、`setBackendToken(token: string): Promise<CredentialStatus>`、`clearBackendToken(): Promise<CredentialStatus>`——**统一解包契约：per-channel wrapper 从 `{status, key}` 取 `.status` 返回裸 status**；key 固定 `backend.token`（**派生自 `shared/contracts/credentials.ts` 常量**，非硬编码字面量）；三个通道响应形状一致。
- **Preload 信封守卫**（承接地基 desktop-api 完整信封模式）：wrapper 必须判 `{ok:false, error:{code,message}}` 分支（UNAVAILABLE/locked 等失败路径 → `throw new Error('[CODE] message')`），`{ok:true}` 才取 `.status`——**safeStorage 不可用时 Renderer 收到明确错误，不返回 undefined status**（地基 P-4 错误信封契约）。
- **安全**：set/clear 的 value 是一次性表单输入，提交后 Main 加密落盘 + 内存持有，**永不回读给 Renderer**；clear 双删。

### 5.4 共享文件写器（diagnostics/file-writer.ts）

```typescript
export interface FileWriterOptions {
  dir: string          // 块 A userData 子目录（logs/ 或 audit/）
  baseName: string     // rotate: 'app'（logs/app.log）；daily: 固定前缀（audit → `audit-YYYY-MM-DD.jsonl`，日期由 writer 派生，构造期不固化）
  mode: 'rotate' | 'daily'
  maxSizeBytes?: number // rotate: 5MB
  maxFiles?: number      // rotate: 3
  retentionDays?: number // daily: 30
  sync?: boolean         // audit=true（持久优先）、log=false（批量异步）
}
export function createFileWriter(opts): { append(line: string): void | Promise<void>; flush(): Promise<void>; close(): Promise<void> }
```

- 复用**地基 spec**（[2026-08-08-phase1-foundation-design.md](2026-08-08-phase1-foundation-design.md) §5.2 step 5）的 `assertSafeLeaf` 纪律：目标文件路径 O_NOFOLLOW + realpath 包含性校验 + 首建 `fchmod 0600`（`user-data-dirs.ts` 的 `assertSafeLeaf` 当前是私有目录形态——**块 B 将其导出/重构为可复用安全写助手**，含 `create`/`existing` 两种模式，文件形态（O_CREAT\|O_EXCL\|O_WRONLY\|O_NOFOLLOW、0600 首建、write/read 模式规则）定义在**地基 spec §5.2 步骤 5**——注意不是块 A spec G-3（那是 electron-builder 打包限制），块 A spec 也不含该纪律）。
- `rotate`（日志）：超 5MB → **轮转发生在写循环边界**（`flush()` 排空在途批次后，检查 size → 超限才触发）→ 关当前 fd → 轮转 `app.log → app.log.1 → app.log.2`（删最旧）→ 重开新 `app.log` fd——异步批量（sync:false）下轮转不得在 append 中途触发（避免对已关 fd 写 EBADF/丢行）；否则 appends 落到被 rename 的旧 inode、新 app.log 恒 0 字节、轮转不再触发。轮转逻辑为纯函数可单测。
- `daily`（审计）：按日文件名；**每次 append 检查日期**（`todayKey()` 变化 → 关旧 fd、开新日文件）——应用跨午夜运行时事件落到正确日文件，不依赖启动时开一次。**保留期清理不是 daily 写器的职责**（见 §5.6——单一归属）。
- `sync:true`（审计）每次 append 同步写 + fsync（持久优先）；`sync:false`（日志）批量异步 + 定时 flush + 退出 flush。

### 5.5 日志（diagnostics/logger.ts）

```typescript
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export interface LogEvent { ts: string; level: LogLevel; logger: string; code: string; fields?: Record<string, string | number | boolean> }
export function createLogger(module: string, opts: { level: LogLevel; writer: FileWriter }): Logger
export interface Logger {
  error(code: string, fields?: LogFields): void   // code = 固定事件码（如 'credential_set'），无独立 msg——消除职责重叠
  warn(code: string, fields?: LogFields): void
  info(code: string, fields?: LogFields): void
  debug(code: string, fields?: LogFields): void
  flush(): Promise<void>
  close(): Promise<void>
}
```

- **禁记防线（诚实声明：多重防线，非单一类型保证）**：
  ① **无消息正文/IP 原文/Token 接收参数**——logger API 是 `(code, fields?)`，`code` 是**固定事件码**（如 `'credential_set'`，编译期可约束为枚举），`fields` 是标量；没有 `msg` 自由文本通道（结构上无「写一条消息/一个 token」的入口）；
  ② **fields 落盘边界净化**——`fields` 值经 `sanitizePublicMessage`（路径脱敏）+ **`redactSensitiveValues`**——**整个秘密形态替换为 `[REDACTED]` 占位符**（非 presence grep）：`Bearer <token>` → `Bearer [REDACTED]`、JWT（`eyJ` 三段 base64url）、`sk-`/`AKIA` 等密钥前缀、≥40 字符高熵 base64 长串——掩码覆盖整个 token 值而非前缀；正则按 verify:artifact 秘密模式扩展为替换型（presence grep 只检测不脱敏，不可直接复用为 redact）；原始秘密值不残留；
  ③ 类型层不宣称「不可能」——`fields` 是开放 Record，未来若有开发者显式传秘密值，② 的 redact 是兜底；审计/阶段 7 扫描再复核。
- **审计 `AuditEvent.summary` 同样走 sanitize+redact**（§5.6——由 **audit.ts 层**应用，非原始 file-writer；见 §5.6 归属）。
- JSONL 行（**唯一格式**，无 msg 字段）：`{"ts":"...","level":"info","logger":"main","code":"app:started","fields":{...}}`。
- 级别过滤：`level` 阈值（error<warn<info<debug）；`config.logLevel`（块 A）注入。

### 5.6 审计（diagnostics/audit.ts）

```typescript
export function createAuditor(writer: FileWriter): { audit(event: AuditEvent): Promise<void>; close(): Promise<void> }
export interface AuditEvent { ts: string; type: string; runtime?: string; toolId?: string; callId?: string; status?: string; durationMs?: number; summary?: string }
```

- append-only **`audit/audit-YYYY-MM-DD.jsonl`**（dir=audit，daily 文件名 = `${baseName}-${date}.jsonl`，baseName='audit'），sync 写；事件：工具执行（callId/toolId/runtime/status/durationMs/sanitized 摘要）、权限决策、凭据生命周期（set/clear/status 变化——**不含秘密值**）。消息正文/Inner Voice 永不进审计。
- **summary 净化归属 = audit.ts 层**：`createAuditor.audit()` 内部对 `summary` 应用 `sanitizePublicMessage` + `redactSensitiveValues` 后再写——原始 `file-writer` 是 dumb append（不做净化），净化在 logger.ts 与 audit.ts 各自调用前完成；§5.5「audit summary 同样走 sanitize」由此落到有明确所有者的模块，不依赖调用方自觉。
- **30 天清理唯一归属 audit.ts**：`createAuditor` 启动时删 `audit/audit-*.jsonl` 早于 `retentionDays`——**日期解析格式固定为 `/audit-(\d{4}-\d{2}-\d{2})\.jsonl$/`**（与 daily 文件名规范一致，杜绝解析失败分支：无日期不匹配的文件不删）；file-writer daily 只管命名/换日，不做保留清理。

### 5.7 装配（main/index.ts + ipc/handlers.ts）

- main() whenReady：`ensureUserDataDirs` 后 → 创建 file-writer（logs/ 轮转、audit/ 按日）→ `createLogger('main', ...)`（级别 = `config.logLevel`）→ 创建 auditor → 注册 credentials IPC handlers → **退出 flush**：
  ```typescript
  let flushing = false
  let allowQuit = false            // finish 完成后放行最终 quit——否则 finally(quit) 的 app.quit() 再次触发 before-quit 被 preventDefault 拦截，进程永不退出（挂死）
  app.on('before-quit', (e) => {
    if (allowQuit) return          // 最终 quit 直接放行，不再 preventDefault（此刻 flush 已完成的）
    e.preventDefault()             // 每次事件都 preventDefault（含 flushing 期间二次事件——否则 window-all-closed 的二次 quit 立即放行绕过 finish）
    if (flushing) return
    flushing = true
    const quit = (): void => { allowQuit = true; app.quit() }
    // flush→close 串成一次 finish；每个 close 独立 try/catch（logger.close 抛错不跳过 auditor.close）；
    // Promise.race 与 1.5s 超时比（防磁盘满挂起）——超时只「放弃等待」不「与在途写竞速」（病理磁盘下
    // 进程可能 close 中途退出，可接受并记录）；finally(quit) 恒执行。
    const finish = async (): Promise<void> => {
      try { await logger.close() } catch { /* 不阻断 */ }
      try { await auditor.close() } catch { /* 不阻断 */ }
    }
    void Promise.race([finish(), new Promise((r) => setTimeout(r, 1500))])
      .catch(() => {})
      .finally(quit)
  })
  ```
  （`finally` 内 close/quit 包 try/catch，flush reject/close 抛错都不阻断 `app.quit()`——窗口关了但进程残留是不接受的。）
- 生命周期日志：`app:started`、`app:user-data-ready`、`credential:set/clear/status-change`（元数据，无秘密）、`protocol:registered` 等。
- 现有 `console.error`（块 A main-window 加载失败占位）替换为 logger（`console.error` 仅 dev）。

## 6. 错误处理与安全

- 凭据：safeStorage 不可用 → `UNAVAILABLE` + 提示解锁钥匙串，**绝不静默明文降级**；key 白名单（zod enum）拒任意 key；value 永不回显；错误信封经 executor 脱敏；
- 日志/审计：文件路径经 assertSafeLeaf（O_NOFOLLOW + realpath 包含性 + 0600）；sanitize 于落盘边界；结构性禁记（类型层）；审计 sync 持久；
- 轮转/清理是纯函数（可单测）；写失败 fail-closed（logger 写失败不阻塞主流程——吞掉并 console.error，审计写失败抛给调用方）。

## 7. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单测 | vitest | `safe-storage`：isSafeStorageUsable（basic_text/unavailable/可用）、encrypt/decrypt、LOCKED 检测（假 safeStorage）；`credential-store`：set/get/clear/getStatus 4 态、key 白名单拒绝、版本化文件未知版本**拒读且拒写**（set/clear 抛 UNSUPPORTED_VERSION，写路径覆盖）、并发 set/clear 串行化不丢更新、getStatus 顺序语义（safeStorage 不可用/版本未知优先于 empty）、safeStorage 不可用拒存、**陈旧 temp EEXIST 恢复（unlink 重试后成功/仍 EEXIST 抛）、rename 原子覆盖（写中断不产生半截文件）**（假 fs 临时目录 + 假 safeStorage）；`file-writer`：rotate 5MB×3 纯函数、daily 按日、0600 首建、symlink/逃逸拒绝（复用 assertSafeLeaf）；`logger`：级别过滤、JSONL 格式、字段 sanitize、结构性禁记（类型层编译期验证——无消息正文参数）；`audit`：append-only 格式、30 天清理纯函数 |
| 静态 | typecheck/lint | 全仓 |
| 冒烟 | Playwright（块 A 复跑） | 现有 verify:artifact 不回归；credentials IPC 手动/集成验证（块 C 集成测试覆盖非法通道） |

## 8. 验收标准

1. `credentials/` + `diagnostics/` 结构符合 §4；`assertSafeLeaf` 已导出/重构可复用；
2. `credential-store` 单测覆盖：set/get/clear/getStatus 4 态、key 白名单拒绝、safeStorage 不可用拒存（UNAVAILABLE 不落盘明文）、版本化文件未知版本**拒读且拒写**（set/clear 抛 UNSUPPORTED_VERSION）、并发 set/clear 串行化不丢更新、getStatus 顺序语义（safeStorage 不可用/版本未知优先于 empty）；
3. `logger` 单测：级别过滤、JSONL 格式、字段 sanitize、轮转 5MB×3 纯函数；
4. `audit` 单测：append-only 格式、30 天清理纯函数；
5. IPC：`credentials:get-status/set/clear` 经 zod 校验 + key 白名单；set 后 Renderer 只能见 status，**读不回 value**；
6. 日志/审计文件 0600、无 symlink 逃逸、logger 无 msg 自由文本通道（消息正文/Inner Voice 无专用入口）、Token 等秘密形态落盘 redact 兜底（不宣称单一类型保证）；
7. 既有单测（块 A 92 项 + 阶段 0）不回归；`pnpm typecheck && pnpm lint && pnpm test` 全绿；
8. 块 A verify:artifact 冒烟不回归（cyrene:// 协议加载、CSP、getAppInfo）。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| safeStorage Linux 无钥匙串 → basic_text | 视为 unavailable 拒存（B-3）；阶段 4 模型密钥同库复用 |
| keyring locked（会话锁屏后 decrypt 失败） | status=locked + 提示解锁；不尝试自动重试 |
| 日志写失败阻塞主流程 | logger fail-closed：吞掉 + console.error；审计写失败抛给调用方（持久优先语义） |
| `assertSafeLeaf` 重构波及块 A | 保持现有签名导出 + 新增 create 模式；块 A 单测不回归即验证 |
| 轮转/清理边界（文件被占/权限） | 纯函数单测覆盖边界；启动清理失败记录日志不阻塞 |

## 10. 已知限制与接受项

| # | 限制 | 影响/处理 |
|---|---|---|
| B-G1 | credentialStatus 是「该 key 是否可读」而非「钥匙串整体状态」 | getStatus 按 key 查询；locked 仅在该 key 解密失败时反映（可接受，key 白名单小） |
| B-G2 | 内存持有 Token 直到 clear 或退出 | 允许（B-2 决策）；Renderer 不可见；进程内存泄露风险低（单值）；阶段 7 可加 clear-on-lock |
| B-G3 | 日志/审计仅主进程内；Renderer 无日志 IPC | 设置页日志查看属阶段 2/3；本块先立机制 |
| B-G4 | 诊断导出不做（阶段 7） | doc 16 §4.0「诊断导出进 P0」= Demo 范围非本阶段（B-1 澄清）；日志/审计 JSONL 已结构化，导出直接收集 |
| B-G5 | doc 16 §4.0/H-09「诊断导出进 P0」措辞待同步 | **块 B 文档收尾步骤**执行改为「诊断导出 = 阶段 7 安全收敛（Demo P0 范围）」（B-1）；本行跟踪防遗漏 |
| B-G6 | 未知版本凭据文件无应用内恢复入口 | getStatus=unavailable、set/clear 抛 UNSUPPORTED_VERSION；恢复 = 文档化手动删除 `config/credentials.json` 重建；阶段 4 模型密钥 UI 落地时提供显式重建入口（提示丢弃未来版本键） |
| B-G7 | `safeRoot = realpath(...)`（装配用普通 realpath，弱于块 A fd 锚点） | 接受：spec §5.2 措辞即 realpath 包含性，CredentialStore 写路径凭 safeRoot 复核（Task 12 实施新增决策） |
| B-G8 | `config.logLevel` 块 A `AppConfig` 已含（其 `LogLevel` 与 logger.ts 同构，结构可赋值） | 无需补字段；装配直接复用（Task 12 实施新增决策） |
| B-G9 | **实施期新增决策汇总**：① model.ts 占位 `CredentialStatus`(零引用)与块 B 4 值契约 barrel 重名 → 重命名 `ModelCredentialInfo`；② `openSafeFile`/`atomicWriteFile` 实参为 `opts.safeRoot`(plan 自由变量 bug 就地修)；③ `assertParentContained` 返回类型 `Promise<string>`；④ 测试未用 import 移除（`basename`/`LogFields`） | 均记录于块 B SDD ledger（D-1~D-4），折叠进最终文档提交 |

**实施中新增决策/限制**：按目标指令追加至本节并回写最终报告。
