// src/main/config/gpu-mode.ts
//
// 2026-09-16 审计 P2 / 立项（方案 A + B）：Linux 无 GPU 时的硬件加速回退——**判定点**。
//
// 缺口：无 DRI 时 Mesa 软件光栅器在 GPU 进程里**确定性段错误**，Chromium 重试耗尽后
// `FATAL: GPU process isn't usable. Goodbye.` **主动杀掉整个应用**；最小复现（X99）里
// `--no-sandbox` / `GALLIUM_DRIVER=llvmpipe|softpipe` / `LIBGL_ALWAYS_SOFTWARE=1` 全部无效，
// `--disable-gpu` 与 SwiftShader 有效。而该开关此前**只存在于测试脚手架与 `verify-artifact.cjs`**，
// `src/main/**` 零命中 ⇒ 产品侧没有任何回退，无 GPU 的 Linux 环境用户拿到的是崩溃。
//
// 为什么单独成模块（而不是并进 `runtime-environment.ts`）：那里已是"窗口呈现模式"的唯一判定点，
// 且被 `windows/window-presentation.ts`、`native-ui/dialog-service.ts` 依赖。本模块需要读文件系统，
// 并进去会把 `node:fs` 拖进那些模块的依赖图——2026-09-16 实测：那样做会让
// `tests/integration/renderer-crash.spec.ts`（唯一用 CDP 观测崩溃后 reload 的用例）稳定失败。
// 故保持职责与依赖都分离：**纯判定在本模块，且只由装配根（`index.ts`）在 app ready 之前调用一次。**
//
// 判据为什么是"设备节点存在性"而不是 `app.getGPUFeatureStatus()`：后者**只在 ready 之后可用**，
// 而崩溃发生在 GPU 进程初始化期——等拿到读数就晚了（只能检测完再重启，体验差且复杂）。

import { readdirSync } from 'node:fs'

/** GPU 回退模式：`auto`（缺省，按平台+设备节点判定）| `disable`（强制软件渲染） */
export const GPU_MODE_ENV = 'CYRENE_GPU_MODE'
/** Linux 上的 GPU 设备节点目录：无可用条目即视为"没有 GPU"（xvfb / 容器 / 无 3D 的 VM） */
export const GPU_DEVICE_DIR = '/dev/dri'

export type GpuMode = 'auto' | 'disable'

/**
 * 判定来源（诊断/证据用，不参与行为分支）：
 * - `env`              调用方显式指定 disable
 * - `no-device-node`   Linux 且无 GPU 设备节点 ⇒ 自动回退
 * - `default`          不干预（有设备节点，或非 Linux）
 */
export type GpuModeSource = 'env' | 'no-device-node' | 'default'

export interface GpuDecision {
  /** 是否必须在 app ready 之前加上 `--disable-gpu` */
  readonly disableHardwareAcceleration: boolean
  readonly gpuMode: GpuMode
  readonly gpuModeSource: GpuModeSource
}

/** 解析显式 GPU 模式；无法识别的取值一律视为「未指定」（按 auto 处理，拼错不该改变渲染路径） */
export function parseGpuMode(raw: string | undefined): GpuMode | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  return value === 'auto' || value === 'disable' ? value : undefined
}

/**
 * 是否存在可用的 GPU 设备节点。只看目录里有没有 `card*` / `renderD*` 条目——
 * 目录存在但为空（部分容器）同样视为没有可用 GPU。
 */
export function hasGpuDeviceNode(dir: string = GPU_DEVICE_DIR): boolean {
  try {
    return readdirSync(dir).some((name) => /^(card|renderD)\d+$/.test(name))
  } catch {
    return false   // 目录不存在/无权限读 → 当作没有（fail-safe：宁可软件渲染也不要崩）
  }
}

/**
 * 判定是否回退。三条规则，顺序即优先级：
 *   ① 显式 `CYRENE_GPU_MODE=disable` ⇒ 任何平台都回退（现场自救口）；
 *   ② Linux 且探测不到设备节点 ⇒ 回退（保守：宁可软件渲染，也不要 GPU 进程杀整个应用）；
 *   ③ 其余一律**不干预**（有设备节点的 Linux 桌面与非 Linux 行为逐字不变）。
 */
export function resolveGpuDecision(input: {
  env: Record<string, string | undefined>
  /** 平台；缺省取 `process.platform`（单测注入以便在任意平台验证 Linux 分支） */
  platform?: string
  /** 设备节点探测；缺省走真实 `/dev/dri`（单测注入假 fs） */
  hasGpuDeviceNode?: () => boolean
}): GpuDecision {
  const platform = input.platform ?? process.platform
  const probe = input.hasGpuDeviceNode ?? (() => hasGpuDeviceNode())
  const requested = parseGpuMode(input.env[GPU_MODE_ENV])
  if (requested === 'disable') return { disableHardwareAcceleration: true, gpuMode: requested, gpuModeSource: 'env' }
  if (platform === 'linux' && !probe()) return { disableHardwareAcceleration: true, gpuMode: requested ?? 'auto', gpuModeSource: 'no-device-node' }
  return { disableHardwareAcceleration: false, gpuMode: requested ?? 'auto', gpuModeSource: 'default' }
}
