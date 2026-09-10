import type { PublicError } from '../../utils/public-error'
import { errorMessage } from '../../utils/error-message'

/**
 * 角色域错误文案（多套 UI 基础，2026-09-10：实现已并入 `utils/error-message.ts`）。
 *
 * 保留本文件是因为角色表单的调用点与测试都直接引用它；它现在只是 `errorMessage` 的语义别名，
 * 不再自己维护一份映射表——避免两处映射表漂移（此前角色域一张、全域没有，正是文案散落的成因）。
 */
export function characterErrorMessage(error: PublicError | undefined, fallback: string): string {
  return errorMessage(error, fallback)
}
