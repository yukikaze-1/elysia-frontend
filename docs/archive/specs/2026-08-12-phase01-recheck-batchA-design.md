# Cyrene 阶段 0/1 整改·批次 A：跨平台文件与退出地基设计

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 A（FE-S1-P0-01 / FE-S1-P1-02 / FE-S1-P2-02 / FE-S1-P1-03）
**审查对象基线：** `main@84a6a9d`（阶段 2 批次 C 落地后 HEAD）
**范围：** Electron 阶段 1 安全骨架的跨平台文件打开与退出流程（safe-open / credential-store / shutdown / main 装配）
**目的：** 关闭首次真实联调前的两个 P0/P1 阻断项（Windows 首建安全文件、FIFO/device 阻塞），并补齐凭据退出落盘与 EMPTY_FILE 工厂化。本批完成后仍标「已开发、未联调」。
**决策：** 本批决策已定案——A1（可注入平台层）为用户拍板；A2（非普通文件全拒 + POSIX `O_NONBLOCK` + drain 超时 1.5s 命名常量）为推荐项。
**文档状态：** v3 定稿（经 code-review 两轮闭环：事实核验 8 条全属实 + 覆盖 7 缺口 + 设计 2 中危缺陷（fatal 无超时兜底 / 超时标记落空）+ 合规 2 建议 + 复核 2 建议级补充，全部整合）

---

## 1. 背景与目标

阶段 2 真实联调整改三批次（A/B/C）已落地，433 单测 + 22 集成 + typecheck/lint/build 全绿，第三方验收 3/3。但阶段 0/1 首次联调前复核清单（2026-08-11）仍留有未解决项，其中两项是**首次真实联调前必须修**的 P0/P1：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-S1-P0-01 | P0 | Windows `openSafeFile()` 创建前无条件 `lstat`，ENOENT 被提前转错误 | Windows 首次保存 Token / 创建日志与审计文件成功；ENOENT 按模式正确保留 |
| FE-S1-P1-02 | P1 | 安全文件层不要求普通文件，FIFO 可阻塞 | 非普通文件（FIFO/socket/目录/device）立即拒绝；POSIX 加 `O_NONBLOCK` 防挂 |
| FE-S1-P2-02 | P2 | `EMPTY_FILE` 是可变模块级单例 | 工厂化每次返回全新对象，损坏重建不污染其他 Store |
| FE-S1-P1-03 | P1 | 退出只等 diagnostics，不等 CredentialStore | 凭据队列 drain + 有序退出 + 超时诚实标记 + 统一 fatal 路径 |

**完成标准**（对照 review §4.1/§6.2/§6.3/§7.2）：
- Windows 分支可注入平台层在 Linux 单测中全量覆盖（create+ENOENT / existing+ENOENT 保留 / symlink 拒 / 目录拒）；
- POSIX 打开既有文件一律 `fd.stat().isFile()` 复核，FIFO/socket/目录/device 立即失败不阻塞；
- `EMPTY_FILE` 工厂化，两个 Store / 损坏重建互不污染；
- CredentialStore 提供 `drain()/close()`：等待已接纳操作结束、拒绝新写、清除明文 cache；
- 退出顺序为 凭据 → adapter → diagnostics；硬超时保留且结果标记 timed out；正常完成后无残留计时器；
- 启动失败若 diagnostics 已创建则统一 fatal 路径 flush 后退出，不绕过 close；
- typecheck、lint、433+ 单测、22+ 集成测试、build 全绿；`check:contract` 不回归；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续）

**本批做：** FE-S1-P0-01（Windows create/ENOENT + 可注入平台层）、FE-S1-P1-02（普通文件/`O_NONBLOCK`）、FE-S1-P2-02（`EMPTY_FILE` 工厂）、FE-S1-P1-03（凭据 drain + 退出顺序 + fatal 路径）。

**本批不做**：
- 真实 Windows CI / Linux packaged artifact job（批次 C FE-S1-P1-04 落地）；
- Renderer 信任边界（批次 B FE-S1-P0-02 / FE-S1-P2-01）；
- 审计业务接线（批次 C FE-S1-P1-01）；
- Mock 隔离 / Node engines / 占位命令 / 文档漂移（批次 D FE-S0-P1-03 / FE-S0-P2-01 / FE-S0-P2-02 / FE-S0-P1-01）；
- RealBackend 断线重连/在途请求编排本身（已有批次 B 处理）；本批仅把 `adapter.disconnect()` 纳入退出顺序；
- FE-S0-P1-02（wire fixture 契约基线）已由阶段 2 批次 C 解决，本批不触碰 fixtures/契约。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/main/persistence/safe-open.ts:19` | `const isPosix = process.platform !== 'win32'` 模块级常量，分支硬编码 | Windows 语义无法在 Linux 单测覆盖（整改 FE-S1-P0-01 要求） |
| `src/main/persistence/safe-open.ts:79` | Windows 分支 `lstat(filePath).catch(() => throw SafeOpenError)` 无条件 | `create+ENOENT` 永远转错误，`O_CREAT|O_EXCL` 不可达；`existing+ENOENT` 丢失原始 ENOENT |
| `src/main/persistence/safe-open.ts:36-70` | POSIX 打开既有文件只查权限位，不查 `st.isFile()` | 0600 FIFO 打开即阻塞（`fstat` 前挂住）；目录/socket/device 可被接受 |
| `src/main/credentials/credential-store.ts:12` | `const EMPTY_FILE = { version: 1, keys: {} }` 模块级可变单例 | set/clear 损坏重建时直接 mutate 单例，未来多 key 会带旧 key 回写（FE-S1-P2-02） |
| `src/main/credentials/credential-store.ts:24` | 私有串行 `queue`，无 `drain()/close()` | 关窗时刚提交凭据可能仍在队列，退出不等它（FE-S1-P1-03） |
| `src/main/shutdown.ts:13-29` | `createShutdownHandler({ closeAll, quit })`，`Promise.race([finish, timeout])` | 只关 diagnostics；超时说明「只放弃等待」在进程退出语义下不成立；timeout timer 不清理；无 timed-out 标记 |
| `src/main/index.ts:155` | `app.on('before-quit', createShutdownHandler({ closeAll: diagnostics.closeAll, quit }))` | 凭据队列与 adapter 不在退出顺序中 |
| `src/main/index.ts:28-31` | `failStart()` 直接 `app.exit(1)` | 若 diagnostics 已创建，退出绕过 close → 缓冲日志丢失（FE-S1-P1-03 第 5 条） |

### 3.2 技术约束

- **`O_NONBLOCK` 对普通文件是无操作**（Linux 忽略之），安全追加到全部 POSIX 打开，不影响 app.log/audit/credentials 正常读写。
- **`open()` 对目录的行为**：Linux 下 `open(dir, O_RDONLY)` 成功，但 `read()` 抛 EISDIR——因此**必须在打开后 `fd.stat()` 判定 `isFile()`**，不能只靠 open 失败。
- **socket 路径**：`open()` 一个 Unix domain socket 路径返回 `ENXIO`（Linux），走「打开失败」转 `SafeOpenError`，不阻塞——同样满足「立即失败」。
- **Windows junction**：Node `lstat().isSymbolicLink()` 对 junction（reparse point）返回 true，可在 open 前拒绝。
- **zod v4 / shared 契约**：本批不新增共享 Schema；`CyreneErrorCode` 新增 `CREDENTIAL_STORE_CLOSED`（避开 CLAUDE.md「Pinia store」术语歧义）仅为主进程内部防御（IPC 已停止，错误码不会被 schema 枚举校验，无漂移风险——已核 `shared/schemas` 无 `errorCode` z.enum）。
- **测试环境**：vitest node 环境（`tests/unit/*.spec.ts` 使用 `fs` 同步 API，如 safe-open.spec.ts 的 `mkdtempSync/writeFileSync/chmodSync/symlinkSync`），FIFO 用 `child_process.spawnSync('mkfifo', [path])` 创建，Unix socket 用 `net.createServer().listen(path)`。

## 4. 设计

### 4.1 FE-S1-P0-01 + FE-S1-P1-02：safe-open 平台层 + 普通文件不变量（决策 A1/A2）

**`SafeOpenPlatform` 接口**（`safe-open.ts` 内新增，导出供测试注入）：

```ts
export interface SafeOpenPlatform {
  readonly kind: 'posix' | 'windows'
  readonly createFlags: number        // O_CREAT|O_EXCL|O_WRONLY；posix 追加 O_NOFOLLOW
  readonly existingReadFlags: number  // O_RDONLY；posix 追加 O_NOFOLLOW|O_NONBLOCK
  readonly existingWriteFlags: number // O_WRONLY|O_APPEND；posix 追加 O_NOFOLLOW|O_NONBLOCK
  readonly preOpenLstat: boolean      // windows=true：open 前 lstat 拒 symlink（无 O_NOFOLLOW）
  readonly checkModeMask: boolean     // posix=true：existing 校验 0400/0600 权限位；windows=false（NTFS 合成值）
}
export const posixPlatform: SafeOpenPlatform = { ... }
export const windowsPlatform: SafeOpenPlatform = { ... }
export function defaultSafeOpenPlatform(): SafeOpenPlatform // process.platform === 'win32' ? windows : posix
```

**统一算法**（`openSafeFile(filePath, opts, platform = defaultSafeOpenPlatform())`）：

1. **pre-open**：`platform.preOpenLstat` 时 `lstat(filePath)`——
   - `ENOENT`：`mode==='create'` → 放行进入 `O_CREAT|O_EXCL`；`mode==='existing'` → **原样抛原始 ENOENT（errno 错误，保留 `code:'ENOENT'`，不得包成 SafeOpenError）**——`CredentialStore.readFile` 据此判「文件不存在」→ `getStatus` 得 `empty`；
   - `isSymbolicLink()` → 抛 `SafeOpenError`（拒 symlink/junction）；
   - 其他错误 → `SafeOpenError`。
2. **open**：按 mode/purpose 选 `platform.createFlags / existingReadFlags / existingWriteFlags`；`create` 遇 `EEXIST` 按 `onConflict` 走 fallback（重开 existing flags）或抛 `SafeOpenConflictError`。
3. **post-open 统一不变量**（`fd` 为准）：
   - `created` → `fd.chmod(0o600)` 兜底 umask；
   - 一律 `const st = await fd.stat()`；
   - **`if (!st.isFile())` → close + 抛 `SafeOpenError`（非普通文件拒绝）**——覆盖 FIFO（POSIX `O_NONBLOCK` 下 open 不阻塞）/目录（open 成功但 isFile false）/socket（open 已 ENXIO）/device；
   - `platform.checkModeMask` 时校验权限位（read `0400`、write `0600`、无 group/other），与现状一致；
   - `assertContained(filePath, safeRoot)` realpath 包含性复核不变。
4. 返回 `{ fd, created }`；任一步失败 close fd 后抛。

**调用方默认**：atomic-write / file-writer 不传 platform，走默认（file-writer/audit 首建自动获得 Windows create+ENOENT 修复，机制共享）；`isPosix` 模块常量删除。CredentialStore 可选注入 platform 供端到端 Windows 单测（见 §4.3）。

**验收测试**（`tests/unit/safe-open.spec.ts` 扩展）：
- 既有测试全部保持通过（create 0600 / fallback / conflict / 权限位 / symlink / 逃逸）；
- POSIX：0600 FIFO `existing+read` 与 `existing+append` **立即拒绝不阻塞**；Unix socket 拒绝；目录拒绝；`/dev/null` 拒绝；
- POSIX `create` 遇既有 FIFO：EEXIST → fallback 重开 existing → `isFile()` 拒（**不阻塞**，P1-02 必须修改第 3 条显式回归）；
- 注入 `windowsPlatform`：`create+ENOENT` 成功首建 0600；`existing+ENOENT` 抛原始 `ENOENT`（`e.code==='ENOENT'`）；symlink 被 lstat 拒；目录被拒；`create` 遇既有文件 fallback 返回 `created:false`；
- Windows 设备边界由统一 `isFile()` 不变量覆盖（注入平台下任意非普通文件即拒）；真 Windows 设备边界测试归批次 C 真 Windows CI（本批不冒充）。

### 4.2 FE-S1-P2-02：`EMPTY_FILE` 工厂化

- 删除模块级 `const EMPTY_FILE`，新增 `function createEmptyFile(): CredentialFileSchemaV1 { return { version: 1, keys: {} } }`；
- `setCredential` / `clearCredential` 中 `?? EMPTY_FILE` 改 `?? createEmptyFile()`；
- `createEmptyFile` 导出（`credential-store.ts` 导出）供单测断言每次返回全新对象。

**验收测试**（`tests/unit/credential-store.spec.ts` 扩展）：
- `createEmptyFile()` 每次返回不同对象（`not.toBe`），mutate 一个不影响下一个；
- 回归守卫：同一文件两个 Store 实例，A set → 损坏文件 → B set → 落盘文件 `keys` 恰为 `{backend.token}` 且值为 B 的（无陈旧残留）；A set → 损坏 → B clear → 落盘文件 `{version:1, keys:{}}`；
- **多 key 互不污染**（整改 FE-S1-P2-02 点名场景，允许用自定义 allowlist 构造）：测试 Store 用 `(k)=>k==='backend.token'||k.startsWith('model.')` 作谓词，两个 Store 同文件——A set `backend.token` + `model.llm.key` → 损坏文件 → B set `model.stt.key` → 落盘文件仅含 `model.stt.key` 与本次写，A 的旧 key 不残留。

### 4.3 FE-S1-P1-03：CredentialStore drain + 有序退出 + fatal 路径

**CredentialStore**：
- 新增 `private closed = false` 与 `private closePromise: Promise<void> | null = null`；
- 构造签名追加可选 `platform?: SafeOpenPlatform`（默认 `defaultSafeOpenPlatform()`），`readFile()` 内 `openSafeFile` 透传——使 Windows 语义可端到端注入（P0-01 验收 #1/#2 在 Linux 单测可验证）；
- `setCredential` / `clearCredential` 顶部：`if (this.closed) throw new CyreneError(CREDENTIAL_STORE_CLOSED, '凭据存储已关闭')`（拒绝新写，先于 enqueue）；
- `getCredential` / `getStatus` 顶部：`if (this.closed) return null / 'unavailable'`（防御，缓存已清）；
- `close(): Promise<void>`（幂等，共享 `closePromise`）：置 `closed = true` → `await this.queue`（等待已接纳操作落盘）→ `this.cache.clear()`；
- `CyreneErrorCode` 新增 `CREDENTIAL_STORE_CLOSED = 'CREDENTIAL_STORE_CLOSED'`（避开 CLAUDE.md「Pinia store」术语歧义）。

**shutdown.ts 重构**：

```ts
export interface ShutdownStep { name: string; run(): Promise<void> }
export interface ShutdownDeps {
  steps: ShutdownStep[]
  quit(): void
  timeoutMs?: number            // 默认 1500（命名常量 SHUTDOWN_TIMEOUT_MS）
  onTimeout?(): void            // 超时标记：诚实记录「可能丢失最后一批写入」
  onError?(step: string, err: unknown): void
}
export function createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void
```

- 保留 `flushing`/`allowQuit` 语义（二次事件 preventDefault、最终 quit 放行）；
- `runAll`：按序执行 `steps`，每步独立 try/catch（`onError(step, err)` 不阻断后续）；循环顶检查 `timedOut`——已超时则不再启动新 step；
- `Promise.race([runAll(), timeoutPromise])`：runAll 正常完成 → finally `clearTimeout(timer)`（**无残留计时器**）+ quit；超时先到 → 置 `timedOut`、`onTimeout()` → finally quit（即使 step 仍在挂起）；
- **超时标记必须落盘**：`onTimeout` 写入**同步 audit**（auditor 为 `sync:true` 逐行 fsync，即时持久）+ `logger.warn`；硬超时下后续 step（含 diagnostics.closeAll）被跳过、异步日志 batch 可能丢失——审计行是唯一持久记录；
- `quit()` 恒经 `allowQuit = true; deps.quit()`，只触发一次。

**main/index.ts 装配**：
- `const SHUTDOWN_TIMEOUT_MS = 1500` 命名常量（app 级导出或模块级）；
- `app.on('before-quit', createShutdownHandler({ steps: [ {name:'credentials', run: () => store.close()}, {name:'adapter', run: () => adapter.disconnect()}, {name:'diagnostics', run: () => diagnostics.closeAll()} ], quit: () => app.quit(), onTimeout: () => { void diagnostics.auditor.audit({ ts: new Date().toISOString(), type: 'shutdown:timed-out', summary: '退出超时，最后一批写入可能丢失' }); diagnostics.logger.warn('shutdown:timed-out', { message: '退出超时，最后一批写入可能丢失' }) }, onError: (step, err) => diagnostics.logger.error('shutdown:step-failed', { step, message: sanitize(err instanceof Error ? err.message : String(err)) }) }))`；
- **统一 fatal 路径**：`main()` 作用域持有 `let diagnostics: Diagnostics | undefined`；`createDiagnostics` 成功处赋值；`fatal(message)` = `dialog.showErrorBox` + （`diagnostics` 存在 → `void Promise.race([diagnostics.closeAll(), new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS))]).finally(() => app.exit(1))`——**closeAll 挂起亦有硬超时兜底**，不无限驻留；否则 → `app.exit(1)`）；`main()` 内 `catch` 与顶层 `main().catch` 统一走 `fatal`（诊断创建前仍可 `app.exit`）。

**验收测试**（`tests/unit/shutdown.spec.ts` 更新 + 扩展）：
- 既有 5 例适配新 `steps` 接口后全部通过（首 flush 后 quit / 二次事件防重入 / allowQuit 放行 / step 抛错仍 quit / 挂起超时后 quit）；
- 新增：steps 按序执行（顺序数组断言）；step 抛错后续 step 仍执行且 `onError` 收到 step 名；慢但完成的 step + 短 timeout → `onTimeout` **不触发**（正常完成后无残留计时器）、quit 一次；step 1 挂起 → `onTimeout` 触发、quit 一次、step 2 不启动、`onTimeout` 内 audit 写入被调用（**持久标记**）；
- CredentialStore：close 后 `setCredential` 抛 `CREDENTIAL_STORE_CLOSED`；close 等待在途写完成后返回且重启可读；close 清缓存（close 后 `getCredential` 为 null）；close 幂等（二次调用同一 promise）；
- Windows 注入端到端（构造传 `windowsPlatform`）：干净文件 `getStatus==='empty'`（非 unavailable）；`setCredential` 后新 Store 实例可读回（P0-01 验收 #1 与 #2 的「重启读取」单测级覆盖）。注：写入经 `atomicWriteFile` 不接收 platform、Linux 上以默认 posix 语义执行——「create+ENOENT 首建」分支由 §4.1 直接注入测试覆盖（真 Windows 默认平台即 windowsPlatform，实现正确）。

## 5. 验收与门禁

**门禁（控制器复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（433+ 单测，含本批新增）、`pnpm test:integration`（22+）、`pnpm build` 全绿；
- `pnpm -F @cyrene/desktop check:contract` 不回归（11/11）。

**故障注入复测（整改清单 §10 要求）：**
- FIFO：0600 FIFO 置于凭据文件位置，`getStatus` 立即返回 `unavailable`，不阻塞、不挂死（单测覆盖 openSafeFile 立即拒绝）；
- 凭据退出：注入慢写后触发 quit，须在写完成后退出（单测覆盖 close 等待 queue）。

**文档标记：** 本批完成仍标「已开发、未联调」；Windows 联调仍阻塞（P0-01 修复 + 真实 Windows CI 于批次 C 后放行，见整改清单 §9.2）。

## 6. 已知限制（记录，待后续批次）

- **Windows 分支仍是注入平台层单测**：真实 Windows CI 归批次 C（FE-S1-P1-04）；本批的 `windowsPlatform` 注入覆盖控制流，不替代真 Windows 运行证据。
- **IPC 不显式注销**：退出时 CredentialStore 关闭即拒新写，chat/其他 handler 由 `adapter.disconnect()` 兜底；不额外做 handler 注销（1.5s 退出窗口内足够）。
- **audit 接线**（FE-S1-P1-01）与 **Renderer 信任边界**（FE-S1-P0-02/P2-01）留批次 B/C。
- **超时与 step 启动存在 ≤ 定时器精度的竞态窗口**：一个 step 可能恰在超时阈值前启动；影响低（若晚启动的是 diagnostics 反而有利），循环顶 `timedOut` 检查兜底。
- **硬超时下 adapter/diagnostics 可能被跳过**：credentials 挂起 >1.5s 时，超时标记经同步 audit 持久、但异步日志 batch 与 `adapter.disconnect()` 可能未执行；此为硬超时语义的诚实记录（整改清单 FE-S1-P1-03 第 3 条）。
- **Windows 设备形态无 Linux 单测**：`windowsPlatform` 注入下 `isFile()` 不变量覆盖目录/FIFO/socket 等非普通文件；真 Windows 设备边界测试归批次 C 真 Windows CI。
- **fatal 路径 closeAll 亦有硬超时兜底**（同 1.5s）；fatal 不 drain 已创建的 CredentialStore 队列（启动失败期无 IPC，队列通常为空）。
- **onTimeout 审计写为 fire-and-forget**：同步写已发出但不 await 再 quit（保持硬超时「立即退出」语义，避免审计挂起拖死退出）；若超时恰落在 diagnostics 步内（auditor 已关），标记行可能静默失败——该窗口下 closeAll 本身正在 flush，影响低。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-12-phase01-recheck-batchA-design.md`；
- 实施完成后更新 `README.md` / `CLAUDE.md` / `docs/16`（批次 A 落地状态 + 测试数字），保留「已开发、未联调」；
- 最终报告 + 验收按整改清单 §10 逐项回报。
