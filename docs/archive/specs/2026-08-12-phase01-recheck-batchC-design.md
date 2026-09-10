# Cyrene 阶段 0/1 整改·批次 C：审计与持续门禁设计

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 C（FE-S1-P1-01 / FE-S1-P1-04）
**审查对象基线：** `main@8678c5c`（阶段 0/1 整改批次 B 落地后 HEAD）
**范围：** Electron 阶段 1 审计业务接线（凭据 + 连接生命周期）与持续门禁（Linux packaged artifact + Windows CI）
**目的：** 让 `audit/` 从「有实现、无生产者」变成「凭据生命周期与连接生命周期有真实审计证据」；把「打包态安全冒烟」与「Windows 平台」从「只验证当前工作区」变成「CI 持续门禁」。本批完成后仍标「已开发、未联调」。
**决策：** 本批决策已定案——C1（fail-open：操作成功不假报失败，审计失败只记日志+标缺失）、C2（审计扩展到连接生命周期：connect/disconnect/错误）、C3（Windows CI 构建级：install/typecheck/unit/build + Windows 专属 persistence 测试，不启动 Electron）均为用户拍板。
**文档状态：** v3 定稿（经 code-review 两轮闭环：事实核验 2 差异 + 覆盖 3 缺口 + 合规 2 硬伤 + 设计 1 缺陷（wrapper 不兜同步抛错）+ 3 一致性注记 + 复核 8/8 修复 全整合）

---

## 1. 背景与目标

批次 A（跨平台文件与退出地基）与批次 B（Renderer 信任边界，P0-02 关闭）已落地（483 单测 + 22 集成 + package + verify:artifact 全绿）。批次 C 处理整改清单 §8 第三批——审计与持续门禁：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-S1-P1-01 | P1 | Auditor 只有实现、无业务生产者；凭据 set/clear 只写运行日志 | 凭据生命周期（set/clear/status-change）+ 连接生命周期（connect/disconnect/错误）接入审计（C2）；fail-open 语义（C1） |
| FE-S1-P1-04 | P1 | CI 不运行打包态安全冒烟，也没有 Windows 门禁 | CI 增 Linux artifact job（package + verify:artifact --smoke）+ Windows job（构建级，C3）+ artifact clean-build + SHA 证据 |

**完成标准**（对照 review §6.1/§6.4）：
- 凭据 set/clear 经 IPC 后有 `credential:set/clear`（含 result）+ `credential:status-change` 审计事件；endpoint:set 既有审计保留（改走统一 fail-open 包装）；
- 连接生命周期有 `connection:connect`（result: connected/failed + errorCode）+ `connection:disconnect` + `connection:error`（code/backendCode/retryable）审计事件；
- 审计失败不改变操作结果（fail-open，C1）：操作已成功不假报「保存失败」，审计写失败记 `audit:write-failed` 日志；
- 审计事件不写 Token/完整 query/聊天正文（复用 auditor 的 summary 净化）；
- 真实应用装配集成测试：经 IPC set/clear 后，临时 `audit/` 出现预期 JSONL；
- CI 增 `artifact` job（ubuntu：clean build + package + xvfb verify:artifact --smoke + SHA 证据）与 `windows` job（windows-latest：typecheck/lint/unit/build，不启动 Electron，C3）；POSIX 专属单测（FIFO/socket//dev/null/symlink/mode）加 Windows 平台守卫；
- typecheck、lint、483+ 单测、22+ 集成、build、check:contract(11/11) 全绿；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续）

**本批做：** FE-S1-P1-01（审计接线：凭据 + 连接生命周期 + fail-open）、FE-S1-P1-04（CI：Linux artifact job + Windows job + safe-open POSIX 守卫 + SHA 证据）。

**本批不做**：
- 阶段 0 真实性（批次 D：FE-S0-P1-01 首次联调范围冻结 / FE-S0-P1-03 Mock 隔离 / FE-S0-P2-01 Node engines / FE-S0-P2-02 占位命令与子 README）；
- 真实 Windows 上启动 Electron 并完成 Token 生命周期冒烟（C3 明确构建级不启动；真机冒烟留 B-01/后续）；
- 审计事件在 Renderer 的可视化（审计是 append-only 日志，仅 Main 侧读取/排障，无 UI）；
- 多实例/多 key 审计扩展（现 allowlist 单 key，事件已带 key 名，多 key 自然扩展）。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/main/index.ts:157` | 仅 `endpoint:set` 接 audit（`void diagnostics?.auditor.audit(...)`，无 catch） | 凭据 set/clear 只有 `logger.info`；endpoint:set 未走统一 fail-open 包装 |
| `src/main/credentials/index.ts:38-67` | set/clear executor 内 `opts.logger.info('credential:set/clear')` + `maybeLogStatusChange`（logger） | 无 audit 调用；status-change 只落运行日志 |
| `src/main/chat/chat-service.ts:33-46,63` | connect/disconnect 只 `pushState` | 无连接生命周期审计 |
| `src/main/chat/backend-error-handlers.ts:48-52` | onError 只 `logger.error` + `send(chat:error)` | 无审计 |
| `.github/workflows/ci.yml` | 3 个 ubuntu job（check/unit/integration），无 package/verify:artifact job、无 Windows job | 打包态安全冒烟与 Windows 回归无持续门禁（FE-S1-P1-04） |
| `tests/unit/safe-open.spec.ts` | POSIX 原生测试（mode 掩码/symlink/FIFO/socket//dev/null/逃逸）无条件跑 | Windows CI 上 mkfifo/symlink/`/dev/null` 不可用、mode 语义不同 → 会红（需平台守卫） |

### 3.2 技术约束

- **AuditEvent 形状**（`diagnostics/audit.ts:7-16`）：`{ ts, type, runtime?, toolId?, callId?, status?, durationMs?, summary? }`；`audit()` 内部对 `summary` 经 `redactSensitiveValues(sanitize(summary))` 净化。审计事件用 `type` + `summary` 表达（与 endpoint:set 一致），summary 只放 key 名/result/errorCode，**绝不写 Token/query/聊天正文**。
- **auditor 是 sync:true 逐行 fsync**（`diagnostics/index.ts:16` + `file-writer.ts` sync 分支）：audit 行一旦写完即落盘。但 audit 经 fail-open 包装是 fire-and-forget（不 await），**IPC 响应与审计落盘存在竞态**——集成测试必须轮询断言（`expect.poll` 带 timeout），不能 IPC 返回后一次性 `readFileSync` 直接断言。
- **fail-open（C1）**：audit 是 fire-and-forget 包装（`void auditor.audit(event).catch(...)`），任何审计失败不改变已成功操作的结果。
- **Windows CI（C3）**：`pnpm test`（unit）与 `pnpm build`（electron-vite 打包）都不需要 electron 二进制（unit 是 node 环境 + `vi.mock('electron')`；build 不启动 electron）→ Windows job 无需 `ensure:electron`，快且稳。
- **safe-open POSIX 守卫**：POSIX 原生测试（mode 掩码、O_NOFOLLOW symlink、realpath 逃逸、FIFO/socket//dev/null）在 Windows 上行为不同/不可用，须 `describe.skipIf(process.platform === 'win32')`；windowsPlatform 注入测试（create+ENOENT/existing+ENOENT/symlink 拒/目录拒/fallback）在 Windows 上仍跑（真 Windows 覆盖，即清单「Windows 专属 persistence tests」）。
- **integration 集成测试在 `--mode test` cyrene:// 下**（`launchApp`）：审计集成测试读 `<userData>/Cyrene/audit/audit-YYYY-MM-DD.jsonl`；safeStorage 不可用环境下 set 会失败但 `credential:set failed` 审计仍会写 → 断言可分支化。

## 4. 设计

### 4.1 审计 fail-open 包装（C1）

`main/index.ts` 装配处新增统一包装（替代 endpoint:set 的裸 `void auditor.audit`）：

```ts
import type { AuditEvent } from './diagnostics/audit'

/** 审计 fail-open（C1）：fire-and-forget，写失败只记 audit:write-failed 日志，不影响已成功操作。
 *  - 外层 try/catch：连注入实现的同步抛错也吞掉——单层即 by-construction fail-open（不需各调用点各自 try/catch）；
 *  - 统一注入 ts：事件字面量不写 ts，由本 wrapper 补（DRY，AuditEvent.ts 必填）；
 *  - 可选链 diagnostics?.：模块级 let 在闭包内 TS 不收窄（TS18048，与既有 endpoint:set 同款）。
 *  - 放置点：必须定义在 main() 内（createDiagnostics 之后、buildBackendErrorHandlers 之前）——依赖函数内局部 sanitize。 */
const audit = (event: Omit<AuditEvent, 'ts'>): void => {
  try {
    void diagnostics?.auditor?.audit({ ts: new Date().toISOString(), ...event }).catch((err) =>
      diagnostics?.logger.error('audit:write-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) })
    )
  } catch {
    // 注入实现同步抛错也吞掉，fail-open 恒成立
  }
}
```

- `endpoint:set` 回调改走 `audit(...)`（与 shutdown:timed-out 的审计写保持两处并存：shutdown 是硬超时兜底专用，本批不动）。
- `audit` 注入到 `createChatService`、`buildBackendErrorHandlers`、`registerHandlers`（→ `registerCredentialsHandlers`）。

### 4.2 凭据生命周期审计（FE-S1-P1-01）

`src/main/credentials/index.ts`：
- `createCredentialsExecutors(store, { logger, sanitize, audit }, connConfig?)`——新增 `audit?: (event: AuditEvent) => void` 依赖；
- `set` executor：包 try/catch——成功 → `audit?.({ type: 'credential:set', status: 'success', summary: 'key=<key>' })`（ts 由 wrapper 统一注入）+ 保留 `logger.info` + status-change 检查（before≠after → `audit?.({ type: 'credential:status-change', summary: 'key=<key> from=<before> to=<after>' })`）；失败 → `audit?.({ type: 'credential:set', status: 'failed', summary: 'key=<key> code=<err.code>' })` + rethrow（**不吞错**，Renderer 仍按既有失败路径）；
- `clear` executor：同构 `credential:clear`；
- `registerCredentialsHandlers` 透传 `audit`。

**fail-open 语义**：audit 在操作结果确定后 fire-and-forget；操作成功 → Renderer 收到成功，即使 audit 写失败也只多一条 `audit:write-failed` 日志（C1）。

**status-change 隔离**：set/clear 成功后的 `store.getStatus` 检查须独立 try/catch（审计元数据失败不改变操作结果）；操作失败路径不查 status-change（只记 failed 事件）。

**运行日志 vs 审计用途**：`logger.info('credential:set', {key})` 是运行诊断（排查当前行为、带请求上下文）；`auditor.audit({type:'credential:set'})` 是 append-only 安全审计（凭据生命周期证据、不可变、按日留存 30 天）。两者互不替代：日志可随时改/删，审计是合规证据；审计失败也不回退到日志（fail-open 只记 write-failed 标记缺失）。

### 4.3 连接生命周期审计（C2）

`src/main/chat/chat-service.ts`：
- `ChatServiceDeps` 新增 `audit?: (event: AuditEvent) => void`；
- `connect()`：整体 try/catch，审计放 `pushState` 之后、`return` 之前（real/mock 两分支收敛到单出口，防审计记录未完成的 connected）——成功 → `audit?.({ type: 'connection:connect', status: 'connected', summary: 'mode=<real|mock>' })`；失败 → `audit?.({ type: 'connection:connect', status: 'failed', summary: 'code=<err instanceof Error ? (err as { code?: string }).code ?? String(err.message) : String(err)>' })`（归一化非 CyreneError 抛错）+ rethrow；
- `disconnect()`：`adapter.disconnect()` 后 → `audit?.({ type: 'connection:disconnect', summary: 'mode=<real|mock>' })`（adapter.disconnect 抛错则跳过审计，可接受——断开未完成）。

`src/main/chat/backend-error-handlers.ts`：
- `BackendErrorHandlerDeps` 新增 `audit?: (event: AuditEvent) => void`；
- `onError`：现有 `logger.error` + `send(chat:error)` 之后 → `audit?.({ type: 'connection:error', summary: 'code=<err.code>' + (backendCode? ' backend=<backendCode>' : '') + (retryable? ' retryable' : '') })`。

`main/index.ts` 装配：`createChatService({ ..., audit })`、`buildBackendErrorHandlers({ ..., audit })`、`registerHandlers({ ..., audit })`。

### 4.4 CI 持续门禁（FE-S1-P1-04，C3）

**`.github/workflows/ci.yml` 新增两个 job：**

```yaml
  # 打包态安全冒烟：clean → package（内含 electron-vite build）→ verify:artifact --smoke（P0-02 验收 A6 持续化）
  artifact:
    name: packaged artifact smoke
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.20.0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Cache Electron binary
        uses: actions/cache@v4
        with:
          path: ~/.cache/electron
          key: electron-cache-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: electron-cache-${{ runner.os }}-

      - name: Ensure Electron binary
        run: pnpm --filter @cyrene/desktop ensure:electron

      - name: Install Playwright (artifact smoke)
        run: pnpm --filter @cyrene/desktop exec playwright install --with-deps chromium

      - name: Clean + package (fresh out/dist)
        run: rm -rf out dist && pnpm --filter @cyrene/desktop package

      - name: Record app SHA
        run: git rev-parse HEAD > app-sha.txt

      - name: Upload SHA evidence
        uses: actions/upload-artifact@v4
        with:
          name: app-sha
          path: app-sha.txt

      - name: Artifact smoke (xvfb)
        run: xvfb-run -a pnpm --filter @cyrene/desktop verify:artifact -- --smoke

  # Windows 构建级门禁（C3：不启动 Electron）——unit 是 node 环境 + build 是打包器，均不需 electron 二进制
  windows:
    name: windows build-level
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.20.0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck + lint + unit + build
        run: pnpm typecheck && pnpm lint && pnpm test && pnpm build

      - name: Record commit SHA (Windows evidence)
        run: git rev-parse HEAD > app-sha-win.txt

      - name: Upload SHA evidence
        uses: actions/upload-artifact@v4
        with:
          name: app-sha-win
          path: app-sha-win.txt
```

**`tests/unit/safe-open.spec.ts` POSIX 守卫：**
- `describe('openSafeFile', ...)`（原 POSIX 原生：mode 掩码/symlink/逃逸等）→ `describe.skipIf(process.platform === 'win32')('openSafeFile', ...)`；
- 新 describe 内 POSIX 原生例（FIFO mkfifo / Unix socket / `/dev/null` / create 遇既有 FIFO fallback）→ `it.skipIf(process.platform === 'win32')`。**守卫理由**：mode 掩码（Windows stat.mode 报 0666）与 symlink/socket（权限/命名管道语义）会红；mkfifo/`/dev/null`（命令/路径缺失→ENOENT）是**假绿**（失去断言意义）——守卫均为「保留真语义」而非只防红；
- **windowsPlatform 注入例保留在 Windows 上运行**（真 Windows 覆盖 create+ENOENT/existing+ENOENT/symlink 拒/目录拒/fallback），但其中「create+ENOENT 首建 0600」的 `st.mode & 0o777 === 0o600` 断言在 Windows 上会红（mode 报 0666）——该断言改为平台守卫：`if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600)`（0600 校验仅在 POSIX 有意义，Windows 只断言 `created===true` + `isFile()`）。

### 4.5 验收测试

- 单元（`tests/unit/credentials-ipc.spec.ts` 扩展）：注入假 `audit` 回调——set 成功触发 `credential:set success`；set 失败（safeStorage 不可用）触发 `credential:set failed` + 原错误 rethrow；clear 同构；status-change 在 before≠after 时触发。
- 单元（`tests/unit/chat-service.spec.ts` 扩展）：假 adapter——connect 成功触发 `connection:connect connected`；connect 失败触发 `connection:connect failed` + rethrow；disconnect 触发 `connection:disconnect`。
- 单元（`tests/unit/backend-error-handlers.spec.ts` 扩展）：onError 触发 `connection:error`（含 backendCode/retryable 提取）；summary 不含原始 payload。
- 集成（`tests/integration/ipc-security.spec.ts` 或新 spec）：`launchApp` 后经 IPC `setEndpoint+setBackendToken`（safeStorage 分支化），**轮询**读 `<userData>/Cyrene/audit/audit-YYYY-MM-DD.jsonl`（`expect.poll` 带 timeout——audit fire-and-forget 与 IPC 返回有竞态）断言含 `credential:set`（成功或 failed 分支均可）；随后 `clearBackendToken` 再轮询断言含 `credential:clear`（清单 P1-01 必须修改 #4 的 set/clear 双向装配级证据）。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`（483+ 单测）、`xvfb-run -a pnpm test:integration`（22+）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（11/11）、`pnpm package` + `xvfb-run -a verify:artifact -- --smoke` 全绿。
- CI 本体（`.github/workflows/ci.yml`）在 GitHub 上验证（本机沙箱无法跑 GHA——需用户 push 触发；本机用 `act` 不可行时记录为「push 后 CI 验证」项）。

## 5. 验收与门禁

**门禁（控制器复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（483+ 单测）、`xvfb-run -a pnpm test:integration`（22+）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（11/11）、`pnpm package` + `xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke` 全绿。

**故障注入复测（整改清单 §10 要求）：**
- 审计证据：集成测试实读 `audit/` 文件断言 `credential:set` 行存在（真实应用级审计证据，非仅单测 mock）；
- audit 写失败：注入抛错的 auditor → 操作仍成功返回 + `audit:write-failed` 日志（单测覆盖 fail-open）。

**文档标记：** 本批完成仍标「已开发、未联调」；CI 新 job 需 push 触发验证（本机沙箱无 GHA），如实记录。

## 6. 已知限制（记录，待后续批次/联调）

- **CI 新 job 无法在本机沙箱验证**：`.github/workflows/ci.yml` 的 artifact/windows job 需用户 push 到 GitHub 触发；本机只能验证 safe-open 守卫后单测全绿 + artifact smoke 本机跑通（等价于 ubuntu artifact job 的内容）。commit+CI run 证据由两 job 的 `app-sha*.txt` 上传物 + GitHub Actions run URL 构成，写入最终报告。
- **Windows 上 symlinkSync 权限残余**：windowsPlatform 注入组的「symlink 被 lstat 拒」例用 `symlinkSync`，windows-latest runner 通常有开发者模式可建 symlink；若个别 runner 无权限导致该例红，需再加平台守卫（本批设计已保留，风险记录）。
- **connect 前置检查失败也记 connection:connect failed**（endpoint/token 未设置等 CREDENTIAL_UNAVAILABLE）：属连接生命周期的一部分；若嫌噪音可后续过滤，本批保留完整生命周期。
- **connect 前置检查失败也记 connection:connect failed**（endpoint/token 未设置等 CREDENTIAL_UNAVAILABLE）：属连接生命周期的一部分；若嫌噪音可后续过滤，本批保留完整生命周期。
- **审计事件无 UI**：append-only JSONL，仅 Main 侧排障/验收用；Renderer 无读取面。
- **Windows CI 跑 POSIX 守卫后的单测**：windowsPlatform 注入例在 Windows 上给出真 Windows 覆盖，但「真 Windows 上启动 Electron + Token 冒烟」仍留 B-01/后续（C3 明确构建级）。
- **批次后续**：阶段 0 真实性（批次 D：FE-S0-P1-01/P1-03/P2-01/P2-02）。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-12-phase01-recheck-batchC-design.md`；
- 实施完成后更新 `README.md` / `CLAUDE.md` / `docs/16`（批次 C 落地状态 + 测试数字 + CI 新 job 说明），保留「已开发、未联调」；
- 最终报告 + 验收按整改清单 §10 逐项回报。
