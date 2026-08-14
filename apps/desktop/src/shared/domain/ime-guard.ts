// src/shared/domain/ime-guard.ts
// 阶段 3 G4（spec §4.7，D14 硬化②）：IME 合成期间 Enter 是候选确认，不得触发发送/搜索。
export function isCompositionEnter(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229
}
