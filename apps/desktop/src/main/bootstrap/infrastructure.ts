// src/main/bootstrap/infrastructure.ts —— ready 之后的第一阶段：底层能力构造（架构整改 Prompt 2）。
//
// 本阶段只做三件事，且顺序即正确性：
//   ① `app.setAppUserModelId` + userData 读回断言 + 生产菜单（ready 后最早，任何落盘之前）
//   ② userData 子目录守卫 → 脱敏器 → diagnostics（日志/审计）→ 运行期兜底守卫
//   ③ 凭据仓库 → 连接配置（含 dev 默认 endpoint）
//
// **不构造任何业务服务**（chat/tool/character/attachment/voice/settings/model）。
// 也不注册 IPC、不建窗口——那些分别属于 services.ts / register-ipc.ts / start-application.ts。
import { app, Menu, safeStorage } from 'electron'
import { join } from 'path'
import { realpath } from 'fs/promises'
import { BACKEND_TOKEN_KEY, BACKEND_TOKEN_ORIGIN_KEY, isKeyAllowed } from '@shared/contracts'
import { expectedUserDataBase } from '../app/lifecycle'
import { ensureUserDataDirs, UserDataDirError, type UserDataDirs } from '../persistence/user-data-dirs'
import type { DialogPort } from '../native-ui/dialog-service'
import { getAppConfig } from '../config'
import type { AppConfig } from '../config/env'
import { assertDevServerOrigin, resolveDevDefaultBackendOrigin } from '../config/dev-ports'
import { evaluateDevRendererUrl } from '../config/trusted-renderer-origin'
import { createDiagnostics, type Diagnostics } from '../diagnostics'
import type { AuditEvent } from '../diagnostics/audit'
import { createSanitizePublicMessage, type MessageSanitizer } from '../diagnostics/sanitize'
import { CredentialStore } from '../credentials/credential-store'
import { ConnectionConfig } from '../connection/connection-config'
import type { ElectronRuntime, RuntimeShell } from './pre-ready'
import { installRuntimeGuards } from './runtime-guards'

/**
 * 全批次共享的底层诊断端口：`Diagnostics`（logger/auditor/logWriter/closeAll）加两个派生出口。
 * 业务层只依赖这个面，不直接构造 writer/auditor。
 */
export interface AppDiagnosticsPort extends Diagnostics {
  /** fail-open 审计（fire-and-forget；注入实现同步抛错也不外泄） */
  audit(event: Omit<AuditEvent, 'ts'>): void
  /** 可 await 的审计：未捕获异常路径必须等它落盘再退出（H-12） */
  auditAsync(event: Omit<AuditEvent, 'ts'>): Promise<void>
  /** 统一脱敏（绝对路径/凭据片段不得原样落盘） */
  sanitize: MessageSanitizer
  /** 审计目录（tool 历史回读通道的数据源） */
  auditDir: string
}

export interface Infrastructure {
  runtime: ElectronRuntime
  config: AppConfig
  dirs: UserDataDirs
  /** userData 基准（已通过读回断言） */
  userDataBase: string
  /** `realpath(userDataBase)`——原子写/包含判定的信任根，四个持久化组件共用同一值 */
  safeRoot: string
  diagnostics: AppDiagnosticsPort
  /** 唯一原生对话框入口——silent 测试模式下不弹系统窗口（见 native-ui/dialog-service.ts 头注） */
  dialogs: DialogPort
  credentials: CredentialStore
  connectionConfig: ConnectionConfig
  /** 后端形态：打包恒 real；未打包默认 real，仅 `CYRENE_BACKEND=mock` 显式 mock。全程只解析一次。 */
  useMock: boolean
}

export type InfrastructureResult = { ok: true; infrastructure: Infrastructure } | { ok: false; message: string }

/** 打包：移除 DevTools 加速键。macOS 用最小菜单保留 Cmd+Q/Cmd+C/V（appMenu/editMenu/windowMenu 不含
 *  View→DevTools）；其余平台 null 即可。D7A-04（阶段 7 批次 A）：生产菜单无 DevTools 角色——
 *  DevTools 唯一开启路径 = 诊断设置页 devMode 开关 + F12 门（config.devToolsAllowed || isDevMode()）。 */
function applyProductionMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
}

export async function createInfrastructure(args: {
  runtime: ElectronRuntime
  shell: RuntimeShell
  /** 后端形态判定（`CYRENE_BACKEND`）——dev 默认 endpoint 的门控与 transport 装配共用同一结果 */
  useMock: boolean
}): Promise<InfrastructureResult> {
  const { shell } = args

  // ready 边界之后的立即动作（与身份链的 userData 路径相关，故必须先于任何落盘）
  app.setAppUserModelId('com.cyrene.desktop')
  if (!args.runtime.setPathOk) {
    return { ok: false, message: `userData 目录不可用：${expectedUserDataBase()}（请检查是否为普通文件或符号链接）` }
  }
  // 防御纵深断言（地基同款）：setPath 后实际 userData 必须等于预期路径，防未来重构/身份顺序变化漂移
  if (app.getPath('userData') !== expectedUserDataBase()) {
    return { ok: false, message: `userData 路径异常：${app.getPath('userData')}（预期 ${expectedUserDataBase()}）` }
  }
  const config = getAppConfig()
  if (!config.devToolsAllowed) applyProductionMenu() // 打包：无 View→DevTools 加速键（mac 保 Cmd+Q/C/V）

  try {
    const userDataBase = expectedUserDataBase()
    const dirs = await ensureUserDataDirs(userDataBase, { baseCreated: args.runtime.baseCreated })
    const sanitize = createSanitizePublicMessage({ home: app.getPath('home'), userData: userDataBase })
    const safeRoot = await realpath(userDataBase)
    const diagnostics = createDiagnostics({ logs: dirs.logs, audit: dirs.audit }, { logLevel: config.logLevel, retentionDays: 30, sanitize })
    // diagnostics 就位后把 closeAll 交给运行期壳：此前的 fatal 路径退出时确实没有诊断要关
    shell.setCloseAll(() => diagnostics.closeAll())
    const port = createDiagnosticsPort(diagnostics, sanitize, dirs.audit)

    // —— 阶段 7 批次 B（D7B-05/07/08）+ H-12：崩溃与进程级兜底装配 ——
    // 必须在任何可能崩溃的构造之前：本行以下的所有 service 构造都在其保护下。
    // 标题用「发生错误」（运行期文案）——未捕获异常路径说「无法启动」会误导用户。
    // 包一层箭头而非直接传方法引用：`fatalRuntime` 是运行期壳上的方法，摘下来传会丢 `this`
    //（`unbound-method`，2026-09-13 type-aware 全集；与 backend-error-handlers 先例同款）。
    installRuntimeGuards(port, (message) => shell.fatalRuntime(message))

    // 启动门禁（B2/P0-02）：dev 模式下 ELECTRON_RENDERER_URL 必须指向受信地址（回环或 allowlist）。
    // 在单实例锁之后——只有持锁主实例评估（第二实例已在锁处 exit(0)）。
    // **仅未打包形态**（与整改前 `if (!app.isPackaged)` 同义）：打包产物里残留的
    // ELECTRON_RENDERER_URL 不得让正式应用拒绝启动。判据用 config.devToolsAllowed（等价于 !isPackaged）。
    if (config.devToolsAllowed) {
      const devGate = assertDevRendererUrl()
      if (devGate !== null) return { ok: false, message: devGate }
    }

    const credentials = new CredentialStore(join(dirs.config, 'credentials.json'), safeStorage, isKeyAllowed, safeRoot)
    // connection-config：注入 CredentialStore 端口（token 与 origin 绑定同仓不同 key）——
    // BACKEND_TOKEN_KEY 由 connection-config 的 set/clear 经 credentials IPC 特判委派（决策 9）。
    // onEndpointChanged 审计：只记规范化 origin（不含 token/完整 URL 参数，spec 3.1.2）；AuditEvent 字段 ts/type/summary（无 data）。
    const connectionConfig = new ConnectionConfig(
      {
        loadToken: () => credentials.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),
        saveToken: (v) => credentials.setCredential(BACKEND_TOKEN_KEY, v),
        clearToken: () => credentials.clearCredential(BACKEND_TOKEN_KEY),
        loadBinding: () => credentials.getCredential(BACKEND_TOKEN_ORIGIN_KEY).then((t) => t ?? undefined),
        saveBinding: (o) => credentials.setCredential(BACKEND_TOKEN_ORIGIN_KEY, o),
        clearBinding: () => credentials.clearCredential(BACKEND_TOKEN_ORIGIN_KEY)
      },
      (e) => { port.audit({ type: 'endpoint:set', summary: e.origin }) }
    )

    const devDefault = await applyDevDefaultEndpoint(args.useMock, connectionConfig, port)
    if (devDefault !== null) return { ok: false, message: devDefault }

    return {
      ok: true,
      infrastructure: {
        runtime: args.runtime,
        config,
        dirs,
        userDataBase,
        safeRoot,
        diagnostics: port,
        dialogs: shell.ensureDialogs(),
        credentials,
        connectionConfig,
        useMock: args.useMock
      }
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof UserDataDirError ? e.message : `启动失败：${e instanceof Error ? e.message : '未知错误'}`
    }
  }
}

/** 审计 fail-open（C1）：fire-and-forget；外层 try/catch 兜注入实现同步抛错；ts 统一注入；可选链防 TS18048 */
function createDiagnosticsPort(diagnostics: Diagnostics, sanitize: MessageSanitizer, auditDir: string): AppDiagnosticsPort {
  const audit = (event: Omit<AuditEvent, 'ts'>): void => {
    try {
      void diagnostics?.auditor?.audit({ ts: new Date().toISOString(), ...event }).catch((err) =>
        diagnostics?.logger.error('audit:write-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) })
      )
    } catch { /* fail-open 恒成立 */ }
  }
  // 可 await 的审计（H-12）：未捕获异常路径必须**等它落盘再退出**——实测发现 fire-and-forget 版
  // 会被 fatalRuntime 的退出抢跑，导致「至少留痕」这个唯一目的落空。语义与 audit 相同（含 fail-open）。
  const auditAsync = async (event: Omit<AuditEvent, 'ts'>): Promise<void> => {
    try {
      await diagnostics?.auditor?.audit({ ts: new Date().toISOString(), ...event })
    } catch (err) {
      diagnostics?.logger.error('audit:write-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) })
    }
  }
  return {
    logger: diagnostics.logger,
    auditor: diagnostics.auditor,
    logWriter: diagnostics.logWriter,
    closeAll: () => diagnostics.closeAll(), // 包箭头：摘方法引用会丢 this（unbound-method 先例）
    audit,
    auditAsync,
    sanitize,
    auditDir
  }
}

/**
 * 启动门禁（dev 形态）：`ELECTRON_RENDERER_URL` 必须指向受信地址（回环或 allowlist）。
 *
 * 两道门互补而非重复：受信门判「能不能连」（回环/白名单，任意端口都受信）；端口断言判
 * 「是不是本项目规划的那个端口」——端口配置漂移或多项目共用端口时当场炸掉，而不是让调试现场
 * 静默跑到另一个端口上。例外：测试 harness（与调试门同一个显式标记）用 port 0 起自己的 dev server，
 * 以免与开发者正在跑的 `pnpm dev` 抢 5373——只放宽端口，回环约束仍然生效。
 *
 * 返回非 null 即致命原因（fatal exit 异步，故调用方必须 return，否则继续建窗/装配）。
 */
function assertDevRendererUrl(): string | null {
  const devEval = evaluateDevRendererUrl(process.env['ELECTRON_RENDERER_URL'], process.env)
  if (devEval.status === 'untrusted') {
    return `ELECTRON_RENDERER_URL 指向不受信地址：${devEval.reason}（仅允许回环或 CYRENE_DEV_RENDERER_ORIGINS 白名单 http 地址）`
  }
  if (devEval.status === 'trusted') {
    const devPortCheck = assertDevServerOrigin(process.env['ELECTRON_RENDERER_URL'], {
      allowAnyLoopbackPort: process.env['CYRENE_TEST_HARNESS'] === '1'
    })
    if (!devPortCheck.ok) return `开发服务器端口与配置不一致：${devPortCheck.reason}`
  }
  return null
}

/**
 * UII-QQ 设置页批次：开发模式默认 Endpoint——仅「未打包（dev）+ 真实模式」且会话内未配置 endpoint 时
 * 注入开发默认后端地址；打包/production 与 mock 演示模式不注入。地址的**唯一来源**是 config/dev-ports.ts
 * （可用 CYRENE_DEV_BACKEND_ORIGIN 覆盖，仍受「http 仅回环」校验收口）。守卫在
 * ConnectionConfig.maybeApplyDevDefault：无凭据直接应用；已有凭据仅当绑定 origin 与默认地址一致时恢复
 * （重启后 endpoint 内存清空的本机场景），绑定其他 origin / 仅 Token 无绑定一律不动，绝不清除已存凭据；
 * 用户本次会话保存的其他地址也不会被覆盖（启动期 getEndpoint() 为空才尝试）。
 *
 * 返回非 null 即致命原因。
 */
async function applyDevDefaultEndpoint(
  useMock: boolean,
  connectionConfig: ConnectionConfig,
  port: AppDiagnosticsPort
): Promise<string | null> {
  if (app.isPackaged || useMock) return null
  let devBackendOrigin: string | undefined
  try {
    devBackendOrigin = resolveDevDefaultBackendOrigin(process.env)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  if (devBackendOrigin !== undefined) {
    await connectionConfig.maybeApplyDevDefault(devBackendOrigin).catch((e) => {
      port.logger.warn('endpoint:dev-default-failed', { message: port.sanitize(e instanceof Error ? e.message : String(e)) })
    })
  }
  return null
}
