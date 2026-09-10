// src/preload/index.d.ts
// Renderer 全局 `window.desktopApi` 声明。
//
// 2026-09-10 整改：本文件原内联了约 90 个方法签名的手写副本（另有 Renderer 侧
// stores/desktop-api.types.ts 的 DesktopApiLike 镜像），三者与实现之间没有任何编译器关联——
// 增删方法或改签名都不会报错。现改为**直接引用实现派生类型**
// （`desktop-api.ts` 的 `export type DesktopApi = typeof desktopApi`），
// 由 node 侧 typecheck 保证实现与声明一致；Renderer 镜像另在自身文件内做编译期断言。
import type { DesktopApi } from './desktop-api'

declare global {
  interface Window {
    desktopApi: DesktopApi
  }
}

export {}
