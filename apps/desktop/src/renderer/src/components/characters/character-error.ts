import type { PublicError } from '../../utils/public-error'

/**
 * The renderer receives already-public errors from Main. These short, stable
 * messages add an actionable next step without echoing an internal exception,
 * absolute path, or backend response body into the settings UI.
 */
export function characterErrorMessage(error: PublicError | undefined, fallback: string): string {
  if (!error) return fallback
  switch (error.backendCode ?? error.code) {
    case 'CHARACTER_NOT_FOUND': return '角色已不存在，请返回目录刷新。'
    case 'CHARACTER_IMMUTABLE': return '内置角色不可修改，请先克隆为自定义角色。'
    case 'CHARACTER_ARCHIVED': return '该角色已归档，不能继续编辑或用于新会话。'
    case 'CHARACTER_REVISION_CONFLICT':
    case 'CHARACTER_STATE_CONFLICT': return '角色版本已更新。请重新加载最新版本，或选择另存为新角色。'
    case 'CHARACTER_STORAGE_UNAVAILABLE':
    case 'STORAGE_UNAVAILABLE': return '本地草稿存储暂时不可用；请稍后重试。'
    case 'CHARACTER_PREVIEW_FAILED': return '临时预览失败，请检查连接或稍后重试。'
    case 'CHARACTER_MUTATION_IN_PROGRESS':
    case 'CHARACTER_BUSY': return '角色正在处理中，请等待当前操作完成。'
    case 'CHARACTER_OFFLINE': return '当前未连接；远端角色操作不可用，但仍可保存本地草稿。'
    case 'CHARACTER_VALIDATION': return '角色校验未通过，请按下方问题修正后再保存。'
    default: return error.message || fallback
  }
}
