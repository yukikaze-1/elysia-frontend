// apps/desktop/src/main/config/backend-mode.ts
/**
 * 装配策略（spec 决策 7 / plan Global Constraints）：打包恒 Real（requireToken）；未打包默认 Real，
 * 仅 `CYRENE_BACKEND=mock` 显式进入 Mock 演示模式（免 token）。
 * 纯函数（packaged + env 注入），便于单测；index.ts 装配时以 app.isPackaged + process.env 调用。
 */
export function resolveBackendMode(packaged: boolean, env: NodeJS.ProcessEnv): 'real' | 'mock' {
  return !packaged && env['CYRENE_BACKEND'] === 'mock' ? 'mock' : 'real'
}
