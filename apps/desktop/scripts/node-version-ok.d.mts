// scripts/node-version-ok.mjs 的类型声明（P1-11，2026-09-11）。
// 同 live2d-install.d.mts 的理由：单测直接 import，`.mjs` 无声明 → TS7016，且 any 会沿调用链扩散。
// 刻意**不**用 `declare module '*.mjs'` 兜底（那会把报错换成失守）。

/**
 * 判断 `version` 是否落在 `range`（语义化范围）内。
 * 供 `check-node-version.mjs` 与单测共用；range 非法/version 不可解析时返回 false（不抛）。
 */
export function nodeVersionOk(version: string, range: string): boolean
