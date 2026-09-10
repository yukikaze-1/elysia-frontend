// src/preload/window.d.ts
// Renderer / 测试的全局 `window.desktopApi` 声明（全仓唯一）。
//
// 为什么文件名不是 index.d.ts：tsc 的同名遮蔽规则——同一目录下 `index.d.ts` 与 `index.ts` 同时
// 进入程序时，声明文件被静默丢弃。tsconfig.node.json 的 include 含 `src/preload/**/*`（同时命中
// index.ts），因此在 **node 程序**里 index.d.ts 从来不可见；只有 tsconfig.web.json 的
// `src/preload/*.d.ts` 能显式命中它。这个差异此前靠 tests/integration/helpers/desktop-api.d.ts
// 这份**手写的第三份镜像**兜住（该文件注释即记录了这一现象）。
//
// 2026-09-10 整改：暴露面声明收敛为「唯一一份、且引用实现派生类型」——
//   src/preload/desktop-api.ts（实现）  →  DesktopApi = typeof desktopApi  →  本文件
// 两份手写镜像（原 src/preload/index.d.ts 的内联签名、tests/.../desktop-api.d.ts）已删除。
// Renderer 侧 `DesktopApiLike` 仍在 stores/desktop-api.types.ts 内，但已加编译期断言钉在本声明上。
import type { DesktopApi } from './desktop-api'

declare global {
  interface Window {
    desktopApi: DesktopApi
  }
}

export {}
