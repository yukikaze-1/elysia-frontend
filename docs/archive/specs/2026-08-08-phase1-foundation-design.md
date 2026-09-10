# 阶段 1 第一块：安全骨架地基 —— 设计

**日期：** 2026-08-08
**状态：** 已呈现设计 / 按用户常驻指令（决策按推荐执行并记录）采用推荐方案 / **已 code-review 39 轮并逐轮修复；剩余缺口见 §10（用户拍板接受，进入实施）**
**关联：** [doc 01 §5 目录结构](../01-Cyrene-Electron-前端总体架构设计-v0.2.md#L154)、[doc 07 §11 凭据与本地数据](../07-Cyrene-Electron前端安全设计-v0.2.md#L228)、[doc 16 §4.0 前置决策](../16-Cyrene-前端实施任务清单与进度跟踪.md#L191)

---

## 1. 背景与目标

阶段 1（Electron 安全骨架）把 CLAUDE.md 的三层信任边界变成可验证工程实现。第一块（本 spec 范围）是**地基**：重构目录结构、确立应用身份与 userData 目录、建立具名 Schema 校验 IPC 骨架。后续块（凭据存储、日志审计、CSP/协议、环境/打包、安全测试）均挂在本次结构之上。

目标：

1. `src/main/` 按 doc 01 §5 落地 9 个子目录，职责单一、可独立测试；
2. 应用身份稳定（`app.setName('Cyrene')` → userData=`~/.config/Cyrene`），userData 下创建 `config/app-cache/logs/audit/temp/models/sandbox` 七个目录（含 doc 16 §4.0 F-06 拍板的沙盒根），带 symlink/realpath 逃逸检查；权限 POSIX 下 0700（Windows 依赖用户级隔离，记录在案）；**缓存目录用 `app-cache` 而非 `cache`**——macOS 大小写不敏感文件系统上 `<userData>/Cache` 是 Chromium 自建的（0o755、会被 Chromium 清空），同名冲突且触发严格权限拒启；
3. Preload 从占位 stub 升级为真实 IPC：具名通道 + zod 校验 + 统一错误信封，Renderer 永远拿不到原始 `ipcRenderer`。

## 2. 范围

| 项 | 内容 |
|---|---|
| 目录重组 | `src/main/` 拆 `app/ windows/ ipc/ transport/ persistence/ credentials/ diagnostics/ tools/ permissions/`；空目录以 README 占位 |
| App 身份/userData | `app.setName('Cyrene')`、`setAppUserModelId('com.cyrene.desktop')`、单实例锁、`ensureUserDataDirs`（纯函数） |
| IPC 骨架 | 通道常量 + 请求/响应 zod schema + `createIpcHandler`（纯）+ `registerHandler`（Electron 绑定）+ `desktopApi` 真实化 |

**非目标（后续块）：** safeStorage 凭据实现、logger/audit 实现、**CSP / 自定义协议 / frame-src 收紧**（`will-navigate` 导航拦截属本块范围，见 §5.5——它是 `isTrustedSender` 锚点成立的前提，已在本次实现）、环境配置与 forge 打包、其余 IPC 通道。

## 3. 决策记录

沿用 [doc 16 §4.0](../16-Cyrene-前端实施任务清单与进度跟踪.md) 已拍板决策；本批新增：

| # | 决策 | 结论 |
|---|---|---|
| P-1 | 目录激进程度 | 9 子目录一次建齐，空目录 README 占位说明用途与填充阶段 |
| P-2 | 主入口位置 | `src/main/index.ts` 保留为薄入口，零 electron.vite.config 改动 |
| P-3 | IPC 骨架规模 | 通道注册表 + zod 校验 + 错误信封机制 + 1 个参考通道 `app:get-info`（YAGNI） |
| P-4 | IPC 错误返回 | 结构化结果 `{ok:true,data}|{ok:false,error:{code,message}}`，不向 Renderer 泄漏堆栈 |
| P-5 | 可测性 | `ensureUserDataDirs` 不依赖 Electron；`createIpcHandler` 与 Electron 解耦——路径脱敏经**必填**的 `options.sanitize` 注入（生产 wiring 传基于 `app.getPath` 的实现，测试传 fake），executor 保持纯函数可单测，类型层强制接线脱敏 |
| P-6 | 测试工具链 | 前端 JS 测试走 pnpm（vitest/vue-tsc/eslint）；conda Elysia 为后端 Python 环境，本批不适用（记录在案） |

## 4. 目标结构

```text
apps/desktop/src/main/
├── index.ts              # 薄入口：main() 装配（installAppIdentity→单实例→whenReady，见 §5.5）
├── app/
│   ├── lifecycle.ts      # installAppIdentity()：setName/setPath/baseCreated（pre-ready，**不含单实例**——单实例在 main() 流程，见 §5.5 ②）；setAppUserModelId 由 whenReady 调用（见 §5.5）
│   └── app-info.ts       # getAppInfo()：version 用 app.getVersion()——electron-vite dev 加载项目根 package.json（version 0.1.0 存在），dev/打包均返回 0.1.0（**不回退 Electron 版本**）；验收可做 dev version 断言 |
├── windows/
│   └── main-window.ts    # createMainWindow：webPreferences、window-open 拦截（从 index.ts 迁出）
├── ipc/
│   ├── channels.ts       # zod schema（AppInfoSchema 等；通道常量在 shared/contracts/ipc.ts）
│   ├── executor.ts       # createIpcHandler(requestSchema, responseSchema, fn)：纯，返回 IpcResult
│   ├── registry.ts       # registerHandler(channel, executor)：绑定 ipcMain.handle
│   └── handlers.ts       # 装配：register app:get-info
├── transport/            # (已有) backend-adapter + mock-backend
├── fixtures/             # (已有) streaming-reply.jsonl（Mock 事件夹具；transport 经相对路径 `../fixtures/` 引用）
├── persistence/
│   └── user-data-dirs.ts # ensureUserDataDirs(base)：建 7 子目录（app-cache/sandbox 等），symlink/realpath 逃逸拒绝 + POSIX 0700
├── credentials/          # README 占位（safeStorage，后续块）
├── diagnostics/          # sanitize.ts（公开消息路径脱敏，本块实现，handlers 接线）+ README（logger/audit 后续块）
├── tools/                # README 占位（阶段 6）
└── permissions/          # README 占位（阶段 6）
```

`shared/contracts/app.ts` 的 `AppInfo` 保持；IPC 契约（通道名/schema）放 `shared` 还是 `main/ipc`？

**决策 P-7：** 通道名与 schema 放 `main/ipc/`（Main 侧权威）；Preload 只 import 类型与通道常量，不 import schema 运行时（避免 schema 进 Preload 包）。通道常量需被 Preload/共享 → 放 `src/shared/contracts/ipc.ts`（仅常量 + 类型，无 Electron 依赖），schema 放 `main/ipc/channels.ts`。**`shared/contracts/index.ts` barrel 需 `export * from './ipc'`**（否则 Preload 的 `import { IpcChannels } from '@shared/contracts'` 失败）。

**决策 P-8：** userData 下缓存目录用 **`app-cache`**（非 `cache`）——macOS/Windows 均为大小写不敏感文件系统，`<userData>/Cache` 是 Chromium 自建（0o755、会被 Chromium 清空），同名冲突且触发严格权限拒启；doc 16 §4.0 的 `cache` 表述同步更正为 `app-cache`。

## 5. 关键实现

### 5.1 App 身份与生命周期（app/lifecycle.ts）

- `installAppIdentity()`（**必须在 `whenReady` 前调用**）：`app.setName('Cyrene')` + **确保父目录（`mkdirSync(dirname(base), {recursive:true, mode:0o700})`——全新 Linux 账号 `~/.config` 可能不存在，XDG 不保证创建）再 `mkdirSync(base, {mode:0o700})`（**非 recursive，原子判定 `baseCreated`**：成功 → true；`EEXIST` → 已存在 → false——`recursive:true` 对既有目录静默成功，会把既有/窗口内落入的外来目录误判为新建后静默 fchmod 收紧）再 `app.setPath('userData', base)`**（`base = join(app.getPath('appData'), 'Cyrene')`）——Electron 的 userData 在 C++ 启动期由 package.json 名（`@cyrene/desktop`）决定，JS `setName` **不会可靠迁移**；且 **`app.setPath('userData', ...)` 在目标目录不存在时会抛错**（Electron 契约），故必须先建 base 再 setPath；**pre-ready 只做宽松 mkdir + setPath**（原因：① 单实例锁键取 userData，须在 setPath 后加锁；② 二次实例在锁前只跑宽松 mkdir（已存在即 no-op）+ setPath，**不触发严格校验的对话框+exit(1)**——非 0700 **目录** userData 下二次启动仍正常聚焦已有实例，不砖死；**诚实边界**：base 为**普通文件/悬空 symlink** 时 mkdir+setPath 均抛（吞掉），userData 回退默认 `@cyrene/desktop` → **若 base 从首启即破损：两实例都用同一默认锁键，二次实例被锁拒正常 exit(0)，仅首实例（whenReady 严格校验）弹框**；若 base 在首启后才破损：**锁键/检测行为因破损形态而异——file/悬空 symlink → setPath 抛 → 回退默认键 → 二次实例弹框；symlink→既有目录 → `setPath` 不抛（仅"目录不存在"才抛）→ 同键 → 二次实例静默 exit(0)**；**运行期把 base 换为 symlink→dir**：**在后续叶子校验/写入层 `assertSafeLeaf` 复核时被检出并拒绝**（realpath 解析到新目标 → `path.relative(safeRoot, leafReal)` 出界 `..`）——**非"整个会话不可检测"**；准确表述是**无主动后台重检**：首实例若无新写入则不被发现，每次写前复核会拒；缓解 = 后续块写入层复用 `assertSafeLeaf`，记录在案；**已知限制（记录在案）**：① **baseCreated 不跨崩溃持久**——首启在 whenReady 前崩溃时标志丢失，下次启动 0600 新 base 被严格规则拒，走 chmod 700 对话框（窗口极小，可接受）；② **base 破损时单实例锁退化为默认域**——首实例运行中 base 被换为文件后，二次实例 mkdir 抛、setPath 跳过 → 锁键回退默认 @ 域 → 不被锁拒、短暂并存至 whenReady 断言退出（破损 base 是需修复的异常态，对话框引导，可接受）；③ 严格 0700/symlink 检查放 `whenReady` 的 `ensureUserDataDirs`，before 建窗、`showErrorBox` 仍可用）；**userData 迁移记录**：phase-0 曾以默认名运行可能留下 `~/.config/@cyrene/desktop`——首次切到 `appData/Cyrene` 后旧目录被搁置，Demo 阶段无用户数据、**不自动迁移、不清理**，仅记录在案（阶段 8 打包前复核）；显式 setPath 保证 userData 恒为 `appData/Cyrene`（Linux `~/.config/Cyrene`、Windows `%APPDATA%\Cyrene`，不带 `@` 前缀）；
- **`app.setAppUserModelId('com.cyrene.desktop')` 留在 `whenReady` 内**（Windows 通知/任务栏身份在 ready 后建立更稳——pre-ready 调用可能不生效，避免回归现有 index.ts:52 的正常路径）；
- 单实例：`app.requestSingleInstanceLock()`，拿不到锁 → **`app.exit(0)`**（与 §5.5 一致——pre-ready `app.quit()` 可能 no-op 残留僵尸）；二次启动事件聚焦已有窗口；
- `activate`（macOS）无窗口时重建；`window-all-closed` 非 darwin 退出。

### 5.2 userData 目录（persistence/user-data-dirs.ts）

```typescript
export interface UserDataDirs {
  config: string
  appCache: string
  logs: string
  audit: string
  temp: string
  models: string
  sandbox: string
}
export function ensureUserDataDirs(base: string, options?: { baseCreated?: boolean }): Promise<UserDataDirs>
// options.baseCreated：installAppIdentity 宽松 mkdir 实际创建 base 时置 true（经 main() 接线传递），
// 使 step 2 对新 base 走 fchmod 修正 umask；未传时 step 1 自判（本次 mkdir 创建）
```

- 相对路径：`config/ app-cache/ logs/ audit/ temp/ models/ sandbox/`（`sandbox` 为 doc 16 §4.0 F-06 已拍板：Desktop 工具读写根，随应用数据走；**`app-cache` 避开 Chromium 的 `<userData>/Cache`**——macOS 大小写不敏感文件系统上 `cache` 与 Chromium 自建 `Cache` 同名冲突）；
- 执行序：
  1. `ensureBaseDir(base)`（幂等复核，`installAppIdentity` 已预建；**内部判定 `createdThisRun = options.baseCreated || 本次 mkdir 实际创建`**——installAppIdentity 预建与 step1 自建都算"本次新建"，供 step 2 的 fchmod 分支用，与叶子的 Set 判定同信号）：`lstat(base)` → **`!stats.isDirectory()` → 抛 `UserDataDirError`（否定判定，与叶子同款——一网打尽符号链接/连接点/普通文件/FIFO/socket/设备节点，base 本身强制非符号链接）**；`lstat` 抛 **ENOENT** → 不存在 → `mkdirSync(base, {mode:0o700})`（**非 recursive，与 installAppIdentity 同**——`recursive:true` 对 lstat→mkdir 窗口内落入的既有目录静默成功、createdThisRun 误置；非 recursive 抛 EEXIST → 重新 lstat 判定，该归一分支才可达；**mode 受 umask 掩码，最终权限由步骤 2 的 `fchmod` 修正**）；**`lstat` 抛 `EACCES`/`EIO` 等非 ENOENT 错误（父目录不可搜索/文件系统错误）→ 一律归一 `UserDataDirError`**（保住 chmod/修复对话框，不裸抛）；**已存在 base 的权限核实（`fs.stat` 严格规则）受 `createdThisRun` 门控**——`createdThisRun` 时跳过（step 2 的 `fchmod` 修正 umask，否则 installAppIdentity 预建的 0600 新 base 在 step 1 就被严格规则拒掉、fchmod 修正路径不可达）；非 `createdThisRun` 才执行严格规则；**`mkdir` 抛 `EEXIST`/`ENOENT`/`EACCES` 等任一错误 → 重新 `lstat` 判定归一**（symlink/破损/文件 → `UserDataDirError`；真不存在 → 重试一次，**重试仍失败 → 一律归一 `UserDataDirError`（有终态，不无限重试、不裸抛）**；目录 → 继续），**不得原样传播**；已存在 base 的权限核实用 `fs.stat`；
  2. **原子复核 base**（与叶子同规，收窄 base 的 TOCTOU——base 是"主威胁"）：POSIX 下 `fs.open(base, O_RDONLY | O_NOFOLLOW | O_DIRECTORY)` + `fs.fstat(fd)` + **按步骤 1 的 `createdThisRun` 区分**——**`createdThisRun` → `fchmod(fd, 0o700)` 修正 umask 掩码**（`fchmod` 抛错如 EPERM（owner 不匹配）→ **归一 `UserDataDirError`**，与 open/fstat 同纪律）；**非 `createdThisRun`（既有）→ 完整规则 `(mode & 0o700) === 0o700 && (mode & 0o077) === 0`，否则抛 `UserDataDirError`（拒 0300/0400/0600，不静默改写）**；**`safeRoot` 从已校验的 fd 推导**——**Linux/macOS 用 `realpath('/proc/self/fd/' + fd)` 或 `realpath('/dev/fd/' + fd)`**（open 时点的真实路径，后续 base 被换为 symlink 不影响锚点——若安全根仍从路径 `realpath(base)` 重读，open→realpath 窗口内 base 换链会把整套叶子包含性校验重新锚定到攻击者目录）；**仅 Windows 无 fd 锚点 → 安全根取 `realpath(base)`**（base 已 lstat 拒绝 symlink + O_NOFOLLOW 复核过，open→realpath 窗口残余记录在案）；**`fd.close()` 用 try/finally（与 assertSafeLeaf 同纪律，防每启泄漏 fd）**；**`open`/`fstat` 抛 `ELOOP`/`ENOTDIR`/`EACCES`/`EIO` 等任一错误 → 一律归一为 `UserDataDirError`**（symlink 竞态、owner 不匹配的 0700 目录（restored backup/多用户）等都在此归一，保住 chmod/修复对话框，不裸抛）；Windows 下 `lstat` + `realpath`（无 `/proc`，安全根取 `realpath(base)`，残余窗口记录在案）。
  3. 每个叶子：`lstat` → 若**不是目录**（符号链接/连接点/普通文件）→ 抛 `UserDataDirError`；不存在 → **先校验父目录 `realpath` 落在 safeRoot 内**（缩小 mkdir 落点窗口）→ `mkdir({recursive:true, mode:0o700})`（**最终权限由步骤 5 的 `fchmod` 修正，不在 mkdir 后 `chmod(path)`——后者会跟随 planted symlink**；**`mkdir` 抛 EEXIST/ENOENT/EACCES 等 → 归一 `UserDataDirError`（与 base 步骤 1 同纪律，不裸抛）**）；已存在 → 权限核实（见下）；
  4. 每个叶子 `realpath(leaf)`，`path.relative(safeRoot, leafReal)` 必须为**非绝对路径且不以 `..` 开头**（拒绝 `<safeRoot>Evil` 字符串前缀陷阱与任何逃逸），否则抛——**mkdir 后立刻复核**，若 mkdir 副作用落在逃逸位置（竞态 planted symlink），拒绝并 **best-effort 回滚删除刚创建的目录**；
  5. **POSIX 原子复核（收窄启动期 TOCTOU）**：仅 POSIX 用 `fs.open(path, O_RDONLY | O_NOFOLLOW | [O_DIRECTORY])` 原子验证——**`assertSafeLeaf` 须支持目录与文件两种形态**（目录带 `O_DIRECTORY`，文件去掉它；否则后续块对日志/审计文件路径的复用会因 `O_DIRECTORY` 抛 ENOTDIR）；**`assertSafeLeaf` 提供 `existing | create` 两种模式**——`existing` 用 `O_RDONLY|O_NOFOLLOW`（本块用）；`create`（文件）用 **`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`**——**`EEXIST` 是回退信号而非缺陷**：已存在 → 关 fd 回退 `existing` 模式重开（严格规则），首次创建成功 → 标记 new + `fchmod(fd, 0o600)`（供 logger/audit 首写/追加复用；`O_CREAT` 不带 `O_EXCL` 时 fstat 无法区分新建与既有，0644 首建文件会被当既有严格规则误拒）；注意 `O_NOFOLLOW` **只拦最后一段**，中间父组件若被换为符号链接仍会跟随；故 **open 后再次 `realpath(path)` 复核包含性**（把步骤 4 的校验折入步骤 5 的 open 之后）；**`fs.fstat(fd)` 判别 + 复核 mode，区分「既有」与「本次新建」**：**既有目录** → 完整规则 `(mode & 0o700) === 0o700 && (mode & 0o077) === 0` 否则抛（拒 0300/0400/0600，不静默改写）；**既有文件** → 按用途分子模式——**write（logger/audit 追加）`(mode & 0o600) === 0o600 && (mode & 0o077) === 0`**（owner 读+写——0400 只读文件可过现有规则但追加会裸 EACCES）/ **read（只读归档）`(mode & 0o400) === 0o400 && (mode & 0o077) === 0`**；**本次新建**（`createdThisRun` 或 create 模式刚创建）→ 目录 `fchmod(fd, 0o700)`、**文件 `fchmod(fd, 0o600)`**（修正 umask——默认 umask 022 下新建文件 0644 世界可读且被下次 existing 严格规则拒掉）；把检查间窗口压到 open→realpath→fstat 之间极小间隙（**显著收窄**，非绝对消除）；**`fd.close()` 必须用 `try/finally`**；Windows 无 `O_NOFOLLOW` 跳过该步（Node `lstat` 对 Windows 符号链接/连接点仍返回 `isSymbolicLink`，残余窗口记录在案）；此复核只收窄**启动期**窗口——`assertSafeLeaf` 在后续块被**所有 persistence 写入层复用**（阶段 6 sandbox 写入、logger/audit 落盘前都复查目标路径，拦截启动后被 planted 的 symlink）；
- **信任边界（诚实声明）**：`base` 来自 `app.getPath('userData')`（Electron per-user，创建于用户私有配置目录）；若攻击者已能写用户配置目录则本机安全已失效。强制点有两层：**① base 本身必须是非符号链接的真实目录**（`lstat` 拒绝——否则 base 被换为 symlink 会把 safeRoot 引到攻击者目录，叶子包含性校验锚定错误位置）；② **叶子**必须是非符号链接的真实目录且 realpath 落在安全根内。祖先目录（如 `~/.config`）为符号链接属合法部署，由 `realpath` 归一，不影响上述两层保证；
- 权限：**POSIX** 下新建目录 `mode 0o700`；**既有目录（base 用 `stat`、叶子用 `lstat`，权限规则同）须满足 `(mode & 0o700) === 0o700 && (mode & 0o077) === 0`（owner rwx 齐全 + 无 group/other 位）→ 否则抛 `UserDataDirError`**——只查 `(mode & 0o077) === 0` 会放行 0300/0400/0600 等**不可用 mode**（stat 通过但步骤 2 的 `open(O_RDONLY)` 抛裸 EACCES，绕过设计的 `UserDataDirError` + chmod 修复对话框）；统一实现「0700」语义，覆盖 doc 16 §4.0 F-06 对 sandbox 的 0700 要求（0755 世界可读同样拒绝）；**注意运算符优先级必须加括号**；**错误对话框必须指明违规路径与修复方法（`chmod 700 <path>`）**——无修复提示会让任何 pre-existing 非 0700 目录永久砖死启动；**Windows 下跳过既有目录严格权限校验**——Node `stat().mode` 在 NTFS 上是合成值，强校验会在第二启时误拒既有目录；`mkdir` mode 亦为 no-op，均依赖 userData 用户级隔离（NTFS ACL），不宣称 0700（记录在案）；
- 纯函数：不 import electron，`base` 由调用方传**预期路径 `join(app.getPath('appData'), 'Cyrene')`**（**非 `app.getPath('userData')`**——setPath 失败被吞时后者回退默认 `@cyrene/desktop`，会掩盖破损 base）。

### 5.3 IPC 骨架

```typescript
// shared/contracts/ipc.ts（无 Electron 依赖）
export const IpcChannels = { appGetInfo: 'app:get-info' } as const
export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]
export interface IpcErrorBody { code: string; message: string }
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorBody }
```

```typescript
// main/ipc/executor.ts（纯，不 import electron）
export function createIpcHandler<TReq, TRes>(
  requestSchema: z.ZodType<TReq>,
  responseSchema: z.ZodType<TRes>,
  fn: (req: TReq) => Promise<TRes> | TRes,
  options: { sanitize: (message: string) => string }   // **必填**：类型层强制所有 handler 为「错误信封 message」接线脱敏（防遗忘导致本地路径泄漏）；**成功 payload 的路径脱敏是各 handler 职责**——本块 app:get-info 的 data 无路径，阶段 6 工具结果等含路径的 data 须在 handler 内脱敏，spec 不宣称 sanitize 覆盖成功 data
): (raw: unknown) => Promise<IpcResult<TRes>>
```

- 入参 `safeParse` 失败 → `{ok:false, error:{code:'SCHEMA_VALIDATION_FAILED', message:'参数校验失败'}}`——code 取自共享层 `CyreneErrorCode` 枚举（**不新增码**，zod 校验失败正是该码语义）；不泄漏字段细节到 Renderer；
- `fn` 抛错 → **兜底保护**：仅当 `err instanceof CyreneError`（已知枚举码）时取 `err.code`（`CyreneErrorCode`）+ `err.message`——**处理序：① `err.message.length > 65536`（UTF-16 code unit 长度，便宜）→ 整体替换为 `<message-too-long>`（**上限实现在 executor**，不调 sanitize——`sanitizePublicMessage` 自身无长度门，逐 token 正则扫描超大消息恰是设计要防的 DoS 路径）② 否则经必填的 `options.sanitize` 脱敏 ③ 截断 500 码点**（**先脱敏再截断**：脱敏的路径匹配需要完整路径，先截断会切断根串导致 userData/home 替换失效、路径尾部泄漏）；截断用**惰性迭代**（`for..of` 取前 500 个码点提前 `break`，勿 `Array.from` 物化整串——物化在 500 限前发生，超大消息反而放大峰值内存）；生产 wiring 传基于 `app.getPath('home'/'userData')` 的脱敏器，executor 不 import electron 保持纯；**其余一律 `{code:'UNKNOWN', message:'内部错误'}`**——`new Error('disk full')`（无枚举码）与 Node/Chromium 底层错误（ENOENT/EACCES 等，message 常含**绝对路径**）都不得透传。错误路径只构造纯对象字面量，保证 `{ok:false,...}` 恒可结构化克隆（不被 Symbol/循环引用/`DataCloneError` 绕过）——Renderer 恒收到结构化结果，而非泄漏堆栈或裸异常；
- 响应过 `responseSchema`，失败 → `UNKNOWN`（防御性）。

```typescript
// main/ipc/registry.ts（Electron 绑定）
let mainWindow: BrowserWindow | null = null
const registered = new Set<IpcChannelName>()
export function setMainWindow(win: BrowserWindow | null): void { mainWindow = win }
export function getMainWindow(): BrowserWindow | null { return mainWindow }   // 窗口单一锚点：index.ts/activate/second-instance 统一从这里读
export function registerHandler(channel: IpcChannelName, executor: (raw: unknown) => Promise<IpcResult<unknown>>, arity: 0 | 1 = 0): void
// arity 类型限 `0 | 1`（TS 字面量——arity=2 编译报错，杜绝静默丢弃第二参数的损坏通道；executor 只转发 args[0]）
// 默认 0（零参通道，本块参考通道 app:get-info 用之）；单参通道注册时传 1
// 内部：
// if (registered.has(channel)) throw new CyreneError(CyreneErrorCode.UNKNOWN, '重复注册 IPC 通道')   // 程序员错误用 UNKNOWN（非用户输入码 INVALID_INPUT），真重复暴露不静默替换
// registered.add(channel)
// ipcMain.handle(channel, (event, ...args) => {
//   if (!isTrustedSender(event)) return { ok:false, error:{ code:'UNKNOWN', message:'拒绝' } }
//   if (args.length !== arity) return { ok:false, error:{ code:'SCHEMA_VALIDATION_FAILED', message:'参数校验失败' } }   // 按通道 arity（注册时声明，默认 0——零参通道用；单参传 1）拒超参/缺参；executor 当前只转发 args[0]（单参签名），多参通道需阶段 3+ 扩展 executor 接收整个 args 数组，本块不承诺
//   return executor(args.length > 0 ? args[0] : undefined)   // 显式零参派生：无参 invoke → raw=undefined（不依赖隐式 args[0]）
// })
// isTrustedSender：以**主窗口 WebContents 身份为锚点**（setMainWindow 由 createMainWindow 内部注入，含 macOS activate 重建路径）：
//   mainWindow 判空 + `!mainWindow.isDestroyed()`（窗口销毁后读 .webContents 抛 Object has been destroyed——unload 期迟到调用/竞态窗口）→ 不满足直接拒绝；
//   event.senderFrame 判空（帧销毁/崩溃期迟到调用）→ null 拒绝；
//   event.sender === mainWindow?.webContents
//   ——只比 webContents 身份（reload/导航会替换 mainFrame 对象，若比 senderFrame 身份会误拒良性 reload）；
//     能拒绝不同 webContents（第二窗口/devtools）；**诚实边界：同窗口 iframe 的 sender 就是主 webContents，本检查不区分**（§6 口径）
```

```typescript
// main/ipc/handlers.ts —— 只导出 registerHandlers()，不在模块顶层做注册副作用（避免 import 时即注册、
// 早于 ensureUserDataDirs；由 main() 在 whenReady 内调用）
import { getAppInfo } from '../app/app-info'
import { appInfoSchema } from './channels'
import { registerHandler } from './registry'
import { createIpcHandler } from './executor'
import { sanitizePublicMessage } from '../diagnostics/sanitize'
import { IpcChannels } from '@shared/contracts'
import { z } from 'zod'

export function registerHandlers(): void {
  registerHandler(
    IpcChannels.appGetInfo,
    createIpcHandler(z.undefined(), appInfoSchema, () => getAppInfo(), { sanitize: sanitizePublicMessage })
  )
}
```
> `sanitizePublicMessage`：处理序 **① `file://` 绝对路径形态 → `<path>` ② `app.getPath('userData')` → `<userData>` ③ `app.getPath('home')` → `~` ④ 兜底「其他绝对路径形态」→ `<path>`**——**②③ 的根替换与 ④ 的形态匹配都用「分隔符不敏感」正则（`\` 与 `/` 等价，模式侧与 message 侧都不做全局改写）**——全局把 `\d`→`/d` 会破坏正则/转义内容（Linux 上 `\` 不是路径分隔符，message 里的 `无法匹配 \\d+` 不应被改），分隔符不敏感只让路径匹配容忍两种分隔符，不改写 message；只替换 home/userData 两根不够：阶段 6 工具路径（`/mnt/usb0/x`、`/tmp/cache`、`C:\Windows\Temp\`、UNC `\\server\share`）不在两根下会原样泄漏；④ 的兜底含：**POSIX 已知系统根清单**（`/tmp/ /etc/ /var/ /home/ /usr/ /opt/ /srv/ /mnt/ /media/` 前缀）+ **≥2 段绝对路径**（`/a/b`）+ 盘符 + UNC + `file://`；**每个形态匹配「完整路径 token」**（盘符 `(?<![\w])[A-Za-z]:[\\/][^\s"'<>]+`；**UNC = 以两个反斜杠开头的 `\\server\share\...` 完整 token（`(?<![\w:])[\\\\]{2}[^\\\\\\s"'<>]+[\\\\][^\\s"'<>]+`，掩到空白/引号/`<>` 边界）**——写反斜杠+斜杠（`\\/`）的形式匹配不到任何真实 UNC 路径）；**单段 `/tmp`、`/d+` 之类与正则/转义内容不可区分，属 best-effort 漏掩**（记录在案，主保证是 ②③ 的 userData/home 根替换）；**替换带路径边界**（前缀后须是**任一路径分隔符 `[\\/]`** 或串尾——**分隔符不敏感匹配下边界也要容忍 `\`**，否则 win32 上 `C:\Users\...\Cyrene\logs\x.log` 的 userData/home 根替换因后随 `\` 而失配、主保证失效；防 `/home/alice2` 被 `/home/alice` 误替换）；**win32 大小写不敏感**；**`app.getPath` 懒解析**（每调用再取，不缓存模块级）；**sanitize 为必填参数**（类型层强制），后续所有 handler 照此模板接线。

### 5.4 Preload 真实化（preload/desktop-api.ts）

```typescript
import { IpcChannels, type IpcResult, type IpcChannelName } from '@shared/contracts'
import type { AppInfo } from '@shared/contracts'
import { ipcRenderer } from 'electron'

const invoke = <T>(channel: IpcChannelName, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

export const desktopApi = {
  getAppInfo: async (): Promise<AppInfo> => {
    let res: IpcResult<AppInfo>
    try {
      res = (await invoke(IpcChannels.appGetInfo)) as IpcResult<AppInfo>
    } catch {
      // ipcMain.handle 拒绝（handler 层异常）时 invoke 以包装错误拒绝——兜底归一，不外泄 Main 侧文本
      throw new Error('[IPC_ERROR] IPC 调用失败')
    }
    // 完整信封守卫：ok:true 必须有 data（非 undefined/null、非数组、且为对象）；ok:false 必须有 error{code,message}（均 string）——防止残缺信封让错误分支崩掉。
    // getAppInfo 的 data 形状（name/version/platform 为 string）也在此校验，防 {ok:true,data:[]} 之类残缺值进入 Renderer。
    // 注：本守卫针对 getAppInfo；未来 void/ack 通道由各自的 per-channel wrapper 处理（可抽通用 unwrap 助手，本块 YAGNI 不抽）
    const isAppInfo =
      res && typeof res === 'object' && res.ok === true && res.data !== undefined && res.data !== null &&
      typeof res.data === 'object' && !Array.isArray(res.data) &&
      typeof (res.data as AppInfo).name === 'string' && typeof (res.data as AppInfo).version === 'string' &&
      typeof (res.data as AppInfo).platform === 'string'
    if (isAppInfo) return res.data
    if (
      res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string'
    ) {
      // 错误码经 message 前缀传递——contextBridge 克隆 Error 时自定义属性（Object.assign 的 code）不保证保留，
      // 渲染层统一按 `[CODE] message` 前缀解析（或 err.code ?? 解析 message）
      throw new Error(`[${res.error.code}] ${res.error.message}`)
    }
    throw new Error('[IPC_ERROR] IPC 返回格式异常')
  }
}
```

- Preload 不暴露原始 `ipcRenderer`（`ipcRenderer` 仅在 preload 内部 import）；`index.d.ts` 全局声明 `window.desktopApi` 保持；
- 通道名与 `IpcResult` 来自 `shared/contracts/ipc.ts`（仅常量 + 类型，无 Electron 依赖），Preload 与 Main 共用。

### 5.5 主窗口与薄入口

- `windows/main-window.ts` 承接现有 `createWindow` 逻辑（webPreferences: sandbox/contextIsolation/nodeIntegration false/webSecurity true、**`ready-to-show → show()`（与 `show:false` 配对——遗漏会使首启窗口永不显示）+ 兜底超时（5s 未触发 → `show()`，防渲染失败时窗口永不出现；**计时器须在 `ready-to-show`/`closed` 时 `clearTimeout`，回调判 `!win.isDestroyed()`**——窗口关闭后到点 show() 抛 `Object has been destroyed`）**、window-open 拦截、loadURL/loadFile）；
- `main/index.ts`：**顶层只调用 `main()`**；`main()` 内顺序：
  ① **`installAppIdentity()`** 包 try/catch——`mkdirSync(dirname(base), {recursive:true, mode:0o700})`（父目录，全新账号 `~/.config` 可能不存在）+ `mkdirSync(base, {mode:0o700})`（**非 recursive，原子判定 `baseCreated`**：成功 → 创建 → true；**`EEXIST` → 已存在 → false**——`{recursive:true}` 对既有目录静默成功、lstat→mkdir 窗口内出现的外来目录都会被误判为新建后静默 fchmod 收紧）+ `setName('Cyrene')` + `setPath('userData', base)`（**必须在单实例锁之前**——锁键取 userData，若在 setPath 前加锁，锁落在默认 `~/.config/@cyrene/desktop`，与真实目录解耦）；**返回 `{ baseCreated: boolean }`**——**吞掉异常时也返回默认 `{ baseCreated: false }`**（③ 的解构不因 undefined 抛 TypeError）；**`setPath` 失败吞掉**（二次实例正常 exit(0)；首实例由 ③ 的统一校验处理）；
  ② **单实例守卫**——`requestSingleInstanceLock()`，拿不到锁 → **`app.exit(0)`** + return（二次实例只跑过 ① 的宽松 mkdir（已存在即 no-op）+ setPath，**无严格校验对话框**，非 0700/破损 userData 下仍正常聚焦已有实例）；
  ③ `whenReady` 内按序（**整个体包 try/catch**——`registerHandlers` 重复注册抛 `CyreneError`、`ensureMainWindow` 异常都要用户可见 + quit）：`setAppUserModelId('com.cyrene.desktop')` → **`const { baseCreated } = installAppIdentityResult`（① 的返回值）；**运行时断言 `app.getPath('userData') === 预期路径`**（setPath 失败被吞后 userData 回退默认——若实际 ≠ 预期，按破损 base 处理：对话框 + exit(1)，**不静默跑在 @ 目录**）；`ensureUserDataDirs(预期路径, { baseCreated })`——base 传**预期路径** `join(app.getPath('appData'), 'Cyrene')` 而非 `app.getPath('userData')`**（传预期路径使破损 `appData/Cyrene` 在严格校验中被 `UserDataDirError` + 对话框 + exit(1) 拦截）** → `registerHandlers()` → **`ensureMainWindow()`** → 生命周期事件（`window-all-closed` 非 darwin 退出；`activate` 调 `focusOrDefer()`）。
- **窗口单一锚点 + 两个入口**：`createMainWindow()` 是唯一创建点（`new BrowserWindow` 后**立即 `setMainWindow(win)`**，`index.ts` 不自持 `let win`）。
  - **`ensureMainWindow()`（whenReady 首建专用）**：**仅当 `getMainWindow()` 为 null 或已销毁 → `createMainWindow()`**——首建路径锚点恒为 null，无有效分支；restore/show/focus 逻辑**只存在于 `focusOrDefer()`**（避免死代码）；**建窗后消费「待聚焦」标志**（`focusOrDefer` null 分支所置）——**消费时用 `restore+show+focus`（同 focusOrDefer）**：`show:false` 窗口上仅 `focus()` 不显现也不置顶，pre-ready 到达的二次启动/activate 聚焦意图必须真正拉起到前台。
  - **`focusOrDefer()`（`activate`/`second-instance` 专用，防与 whenReady 双建）**：`getMainWindow()` 有效 → **restore（若最小化）+ show（若不可见——show:false 建窗在 ready-to-show 前 focus 不显现）+ focus**；已销毁（macOS `window-all-closed` 后进程存活）→ `createMainWindow()` 重建；**null（`whenReady` 的 async 间隙，窗口尚未建）→ 置「待聚焦」标志**——whenReady 的 `ensureMainWindow()` 建窗后消费并 focus，不双建、不丢弃聚焦意图。
- **单实例二次启动**：`second-instance` 监听在锁成功后注册——**不依赖"只在 ready 后触发"的假定**（Electron 不保证该时序；pre-ready 触发时窗口未建）；处理器 = `focusOrDefer()`：
  - `getMainWindow()` 有效 → **restore（若最小化）+ show（若不可见——show:false 建窗在 ready-to-show 前 focus 不显现）+ focus**；
  - 已销毁（macOS `window-all-closed` 后进程存活）→ `createMainWindow()` 重建；
  - **null（`whenReady` 的 async 间隙/未建窗）→ 置「待聚焦」标志**，`whenReady` 的 `ensureMainWindow()` 建窗后消费标志并 focus——**不 no-op 丢弃二次启动的聚焦意图**。
> **`createMainWindow` 内**：`setMainWindow(win)` 必须在 `new BrowserWindow(...)` 之后、`loadURL/loadFile` 之前立即注入（否则首启 Renderer 加载期调用 `app:get-info` 锚点 null 被拒；macOS 重建时锚点指向已销毁窗口抛 `Object has been destroyed`）。`will-navigate` **处理器体整体包 try/catch**——`new URL(target)` 解析（畸形/非绝对 URL 抛 TypeError）、`fileURLToPath`（`ERR_INVALID_FILE_URL_HOST`/`ERR_INVALID_URL_SCHEME`）、`decodeURIComponent`（孤立 `%` 抛 URIError）**任一失败 → 一律 `preventDefault`（fail-closed，绝不因未捕获异常而放行导航）**。分流：① **应用自身 URL**——**dev 判定用 `!app.isPackaged`**（与 index.ts 的 loadURL 分支一致；**勿用 `ELECTRON_RENDERER_URL` 存在与否**——打包构建被外部导出该 env 会误入 dev 分支）：`!app.isPackaged` 下仅放行 dev 同源（`protocol+host+port` 一致）http(s) 且 pathname **不在 `/@fs/`/`/@vite/` 等 Vite 文件代理前缀下**（防经 `@fs` 读工作区任意文件——dev 分支是开发便利，非安全控制，安全边界以打包分支为准），其余协议（含 `file:`，如 `file:///etc/passwd`）一律 ③ 拒绝；**打包下仅 `file:` 协议**：`fileURLToPath(new URL(target))` 转文件路径，与构建期渲染根常量（`join(__dirname, '../renderer')`）都 `path.resolve` + **`realpath` 解析符号链接**（`path.resolve` 不解析 symlink——渲染根内 planted symlink（便携/用户目录安装产物可写）会越过字符串前缀读到任意文件，须 `realpath` 复核后同规比较）+ **win32 大小写不敏感（lowercase）**，再**带路径边界**比对（`targetPath === rootPath || targetPath.startsWith(rootPath + path.sep)`——防 `renderer2/` 共享前缀误判）；**不从 `webContents.getURL()` 实时推导**（Vue history 路由 pathname 漂移；**不能用 origin**——file:// 下所有 origin 恒 `'null'`）→ 放行；② 外部 `http/https` → `shell.openExternal` + `preventDefault`；③ 其余一律 `preventDefault`。**诚实边界**：Vue hash 同文档路由不触发 `will-navigate`（天然安全）；**若未来采用 history-mode 路由，整页导航到 `file://.../renderer/<route>` 目标文件不存在 → realpath 抛 ENOENT → preventDefault 拦截，需在阶段 3 引入路由时同步放行渲染根内已知路由路径**（本块假定渲染器为静态四区壳、无 history-mode 整页导航，记录在案）；

## 6. 错误处理与安全

- Renderer 只见公开 `IpcErrorBody`，Main 内部错误堆栈不上行；
- IPC 错误复用共享层 `CyreneError`（`code/message`）约定，非 `CyreneError` 一律 `UNKNOWN`（见 §5.3 executor）；
- **IPC 调用方校验**：`registerHandler` 内置 `isTrustedSender`——以 `setMainWindow` 注入的主窗口 **WebContents 身份**为锚点（`mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents`），**能拒绝**第二个窗口/devtools 等不同 webContents 的调用；**诚实边界：同窗口内 iframe 的 `event.sender` 就是主 webContents**（Electron 契约），本检查**不能区分同窗口 iframe**——本块仅暴露非敏感通道（`app:get-info`），iframe 区分与 `frame-src`/CSP 加固在后续块收口，不在此过度宣称；**配合 `will-navigate` 同窗口导航拦截**（见 §5.5）——webContents 身份锚点只有在同窗口导航被封死后才成立；不做 URL/origin 比对（`file://` 下 origin 恒 `'null'`）；
- symlink/连接点逃逸拒绝（userData 子目录）；
- 通道白名单：只注册 `IpcChannels` 内通道，`ipcMain.handle` 无通配注册；
- 未识别入参/超大输入由 zod 上限（字符串长度等）兜底（本批为 `app:get-info` 无参，机制先立）。

## 7. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单测 | vitest（node env） | `user-data-dirs`：base 缺失自动创建（**fd fchmod 防 umask，非按路径 chmod**——与 §5.2 纪律一致）/ base 文件·破损·符号链接拒绝 / base 与叶子同规原子复核（open EACCES/ENOTDIR 归一 UserDataDirError + fd close）/ 建 7 目录（app-cache/sandbox）/ POSIX 0700（目录）/ 0600 文件形态 / 叶子 symlink·非目录拒绝 / 既有目录非 0700 拒绝 / realpath 逃逸（含前缀陷阱）拒绝 / 已存在复用；`executor`：合法通过、非法入参→`SCHEMA_VALIDATION_FAILED`、`CyreneError` 提取（fake sanitize 验脱敏）、`new Error()`→`UNKNOWN`、非对象→`UNKNOWN`、响应 schema 失败→`UNKNOWN`、截断按码点、64KB 上限；`diagnostics/sanitize`：**①file://→②userData→③home→④其他绝对路径（已知系统根/≥2段/盘符带左边界/UNC）→`<path>`（分隔符不敏感匹配,不改写 message）**、路径边界、win32 大小写不敏感、懒解析 |
| 静态 | `vue-tsc`/`eslint` | 全仓类型与 lint |
| 构建 | `electron-vite build` | main/preload/renderer 产物 |
| 冒烟 | 本机 GUI | 窗口启动、`window.desktopApi.getAppInfo()` 返回（由用户确认） |

## 8. 验收标准

1. `src/main/` 结构符合 §4，空目录均有 README 占位；
2. `installAppIdentity()` 生效：userData 恒为 `appData/Cyrene`（显式 `app.setPath`），不含 `@` 前缀；
3. `ensureUserDataDirs` 单测覆盖：base 缺失自动创建、base 为普通文件/破损符号链接/符号链接拒绝、叶子 symlink/非目录拒绝（`lstat`）、叶子 realpath 逃逸（含 `<safeRoot>Evil` 前缀陷阱）拒绝、既有目录（base·叶子）非 0700（owner rwx 齐全 + 无 group/other 位，拒 0300/0400 不可用 mode）拒绝、**base 与叶子同规原子复核（O_NOFOLLOW + fstat）**、`app-cache`/`sandbox` 目录创建、POSIX 0700 新建（Windows 记录在案不宣称 0700）；
4. `executor` 单测覆盖：合法通过、非法入参→`SCHEMA_VALIDATION_FAILED`、`CyreneError` 提取（注入 fake sanitize 验脱敏）、`new Error()`→`UNKNOWN`、非对象 throw→`UNKNOWN`、响应 schema 失败→`UNKNOWN`、message 截断（按码点不裂代理对）；
5. `pnpm typecheck && pnpm lint && pnpm test` 全绿；`pnpm build`（electron-vite build）产物正常——`build` 非 doc-09 标准命令集成员，为本地构建命令，已注明；
6. Renderer 只能经 `window.desktopApi.*` 访问，拿不到原始 `ipcRenderer`；
7. 已有单测（schemas/stream-accumulator/mock-replay）不回归。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| Preload 打包引入 Electron 依赖 | 通道常量放 `shared/contracts/ipc.ts`（无依赖）；`ipcRenderer` 仅在 preload 内 `import { ipcRenderer } from 'electron'` |
| `app.setName` 后测试环境 userData 变化 | 单测不依赖真实 userData，`ensureUserDataDirs(base)` 传临时目录 |
| 目录重组破坏 vite/tsconfig 路径 | `tsconfig.node.json` include `src/main/**/*` 已覆盖子目录；构建回归兜底 |

---

## 10. 已知限制与接受项（第 39 轮 review 后，用户拍板接受）

以下为本 spec 经 39 轮 code-review 后仍存在的已知限制/诚实边界。**已全部记录，接受为当前范围的一部分**；实施时按此处理，不因追求"零缺陷"阻塞后续阶段。

| # | 限制 | 影响/处理 |
|---|---|---|
| G-1 | **安全根 fd 锚点仅 Linux/macOS 可用**（`/proc/self/fd`/`/dev/fd`）；Windows 无 → `safeRoot = realpath(base)` | open→realpath 窗口内 base 换链残余；base 已 lstat 拒 symlink + O_NOFOLLOW 复核过，概率低，记录在案 |
| G-2 | **Windows 无 `O_NOFOLLOW` 原子复核**，仅 lstat + realpath | TOCTOU 窗口残余；不宣称 0700（NTFS `stat().mode` 为合成值），依赖 userData 用户级隔离 |
| G-3 | **运行期 base→symlink 换链无主动后台重检** | 每次写前 `assertSafeLeaf` 复核会拒（后续块写入层复用）；无写入则不发现——缓解靠写入层，非启动期 |
| G-4 | **`baseCreated` 不跨崩溃持久** | 首启在 whenReady 前崩溃时标志丢失，下次启动 0600 新 base 走 chmod 对话框（窗口极小，可接受） |
| G-5 | **base 破损时单实例锁退化为默认域** | 首实例运行中 base 被换为文件后，二次实例不被锁拒、短暂并存至 whenReady 断言退出（破损 base 是需修复的异常态，对话框引导） |
| G-6 | **`isTrustedSender` 不能区分同窗口 iframe** | 需后续块 CSP/`frame-src` 收口；本块仅暴露非敏感通道 `app:get-info` |
| G-7 | **sanitize 单段绝对路径（`/tmp`、`/d+`）与正则/转义不可区分，best-effort 漏掩** | 主保证是 userData/home 根替换（②③），④ 兜底为防御纵深；记录在案 |
| G-8 | **Vue history-mode 路由与 `will-navigate` 冲突** | 本块假定渲染器为静态四区壳（hash 路由天然安全）；阶段 3 引入路由时需放行渲染根内已知路由路径 |
| G-9 | **executor 单参签名**，arity 类型限 `0 \| 1` | 多参通道需阶段 3+ 扩展 executor 接收整个 args 数组；本块不承诺 |
| G-10 | **dev 模式 `will-navigate` 是开发便利非安全控制** | 安全边界以打包分支为准（`!app.isPackaged` 判定） |
| G-11 | **userData 迁移**：旧 `~/.config/@cyrene/desktop` 不自动迁移/清理 | Demo 阶段无用户数据，阶段 8 打包前复核 |

**接受理由：** 以上均为安全纵深/边缘时序的已知权衡，非本块主路径缺陷；主保证（userData 0700 + symlink 拒绝、IPC 白名单 + zod 校验 + sender 锚点、外部链接走系统浏览器）在 39 轮内已充分加固并经多轮交叉验证。
