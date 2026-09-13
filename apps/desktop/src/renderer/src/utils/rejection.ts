// src/renderer/src/utils/rejection.ts
//
// 2026-09-13（type-aware lint 全集批次）：`prefer-promise-reject-errors` 要求 Promise 的拒绝原因是 Error。
// 本仓这些 store 的写法是「先同步取 api 方法，同步调用可能直接抛」，再 `Promise.reject(cause)`——
// 而 TS 的 catch 变量是 `unknown`，规则因此命中（实测 6 处，character-catalog／identity／character-runtime）。
//
// 为什么不简单地 `Promise.reject(cause as Error)`：拒绝值确实可能不是 Error（第三方或原生抛出的任意值），
// 断言只是把问题藏起来；而消费方普遍按 Error 处理（读 `.message`／堆栈），拿到非 Error 会静默丢诊断。
// 归一时**保留原值**在 `cause` 上，信息不丢。
export function toRejection(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('操作在发起前同步抛出', { cause })
}
