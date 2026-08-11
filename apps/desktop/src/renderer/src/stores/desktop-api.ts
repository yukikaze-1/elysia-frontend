// src/renderer/src/stores/desktop-api.ts
// 依赖注入点(P1-3):store 惰性 `import { api }`,在动作内访问;
// main.ts 启动时 `setDesktopApi(window.desktopApi)`;测试 `setDesktopApi(mockApi)`。
import type { DesktopApiLike } from './desktop-api.types'

export let api: DesktopApiLike

export function setDesktopApi(a: DesktopApiLike): void {
  api = a
}
