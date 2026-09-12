// scripts/live2d-install.d.mts
// live2d-install.mjs 的类型声明（P1-11，2026-09-11）。
//
// 为什么需要：测试以 `import { resolveModelsDir } from '../../scripts/live2d-install.mjs'` 引用它，
// 而 `.mjs` 无声明 → TS7016「implicitly has an 'any' type」。那不只是 4 条报错：`any` 会**沿调用链扩散**，
// 让下游 `let x = resolveModelsDir(...)` 退化成 evolving any（一连串 TS7034/TS7005）。
//
// 为什么**不**用 `declare module '*.mjs'` 兜底：那会把该目录下所有脚本的导入都变成 `any`，
// 等于把问题从"看得见的报错"换成"看不见的失守"——正是本仓库反复吃亏的模式。
// 这里逐函数写出真实签名，脚本改动时类型不符会立刻变红。
//
// 维护：新增导出需同步此文件（`tests/unit/scripts-dts-mirror.spec.ts` 会枚举 .mjs 的导出并核对）。
export interface Live2dInstallEnv {
  /** 缺省用 process.platform */
  platform?: string
  APPDATA?: string
  HOME?: string
  XDG_CONFIG_HOME?: string
}

/** userData 风味：'dev' = 未打包 development 的 `Cyrene-Dev`，'default' = 打包产物的 `Cyrene` */
export type UserDataFlavor = 'dev' | 'default'

export const USER_DATA_FLAVORS: readonly UserDataFlavor[]

/**
 * 纯函数：镜像 expectedUserDataBase() 的 userData 根解析（不含 /models）。
 * 任一路径缺所需环境变量时抛错（错误文案含具体平台）；flavor 未知时抛错。
 */
export function resolveUserDataDir(env: Live2dInstallEnv, flavor?: UserDataFlavor): string

/**
 * 纯函数：userData 根 + /models（装配目标目录）。
 * 任一路径缺所需环境变量时抛错（错误文案含具体平台）。
 */
export function resolveModelsDir(env: Live2dInstallEnv, flavor?: UserDataFlavor): string

/** CLI 默认装配风味（与 `pnpm dev` 的 userData 对齐） */
export const DEFAULT_CLI_USER_DATA_FLAVOR: UserDataFlavor

/**
 * 把原始模型目录装配成 userData/models/<id>/ 合规安装包。
 * 已存在且未传 force 时抛错（拒绝覆盖）。返回装配报告（文件数/字节数/哈希数/入口 sha256）。
 */
export function installModel(input: {
  modelDir: string
  id: string
  displayName: string
  licenseNote?: string
  force?: boolean
  modelsDir: string
}): Promise<{
  id: string
  dst: string
  files: number
  bytes: number
  hashes: number
  modelFile: string
  modelFileSha256: string
  preview: string | null
}>
