// scripts/package-app.d.mts
// package-app.mjs 的类型声明（沿用 P1-11 确立的"逐函数声明、不用 declare module '*.mjs' 兜底"模式）。
// 维护：新增导出需同步此文件。

/** 命中"首跑 fuses 写 wire 的 ENOENT"这一已知 Windows 偶发形态 */
export function isFusesEnoentFlake(output: string): boolean

/** 跑一次 electron-builder --dir；输出同时实时透传并累积返回 */
export function runBuilderOnce(options?: {
  spawnImpl?: unknown
  args?: string[]
}): Promise<{ code: number; output: string }>
