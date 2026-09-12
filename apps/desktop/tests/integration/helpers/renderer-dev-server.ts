// tests/integration/helpers/renderer-dev-server.ts
// dev 形态集成覆盖（M-29/P2-5）：以**与 `pnpm dev` 同一份配置**起一个 renderer Vite dev server。
//
// 为什么需要它（这就是 P2-5 要补的盲区）：
//   集成套件此前**全部**运行 prod 形态——helpers/app.ts 无条件删除 `ELECTRON_RENDERER_URL`，
//   页面恒为 `cyrene://renderer`。而 2026-09-10 用户看到的 Live2D「模型加载失败 / 原因：Failed to fetch」
//   只在 dev 形态存在（dev 页面在 `http://localhost:<port>`，而 `cyrene` scheme 恒 `corsEnabled:false`，
//   跨源 fetch 被 Chromium 拒绝），于是整类"只在 dev 可达"的回归**没有任何测试覆盖**。
//
// 为什么不用 electron-vite 自己的 `createServer({ rendererOnly: true })`：
//   读它的实现（node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js）可见 `rendererOnly` 只跳过
//   main/preload 构建，函数末尾**仍无条件** `startElectron(inlineConfig.root)`——会额外拉起一个
//   不受 harness 管控（无 appData 隔离、无 Mock 装配）的 Electron 进程，与 Playwright 抢同一批资源。
//   故这里只借它导出的 `resolveConfig` 取到**同一份** renderer 配置（root/base 默认值、vue 插件、
//   dev CSP 中间件、`@renderer`/`@shared`/`@framework` alias 全部来自真实 electron.vite.config.ts），
//   再用 Vite 原生 `createServer` 起服务——配置不复制，故不可能与 `pnpm dev` 分叉。
import { createServer as createViteServer } from 'vite'
import type { InlineConfig as ViteInlineConfig } from 'vite'
import { resolveConfig } from 'electron-vite'
import type { AddressInfo } from 'node:net'

export interface RendererDevServer {
  /** 形如 `http://127.0.0.1:<port>`（回环 → 命中 resolveTrustedDevOrigins 的恒信任分支） */
  url: string
  close(): Promise<void>
}

export async function startRendererDevServer(): Promise<RendererDevServer> {
  // mode='development' 是承重的：renderer 侧 needsIpcResourceSupply() 要求 import.meta.env.MODE
  // === 'development' 才会把 Live2D 模型读取切到 IPC 供给通道——本 spec 要验的正是那条通道。
  const resolved = await resolveConfig({}, 'serve', 'development')
  const cfg = resolved.config?.renderer
  if (!cfg) throw new Error('electron-vite 未解析出 renderer 配置（electron.vite.config.ts 缺失 renderer 段？）')

  const server = await createViteServer({
    ...(cfg as ViteInlineConfig),
    // 配置已由 electron-vite 解析完毕：禁止 Vite 再去 cwd 找一遍配置文件（会二次求值并且 root 语义不同）
    configFile: false,
    // port 0 = 内核分配空闲端口：测试进程不得与开发者正在跑的 `pnpm dev` 抢 5373（固定端口，strictPort）。
    // Main 侧的端口一致性断言（config/dev-ports.ts assertDevServerOrigin）对 harness 显式放行任意回环端口，
    // 否则本形态会被判成「端口漂移」——放行只针对端口，回环约束不放宽（见 docs/19）。
    server: { ...(cfg.server ?? {}), host: '127.0.0.1', port: 0 }
  })
  await server.listen()

  const address = server.httpServer?.address() as AddressInfo | null
  if (!address || typeof address.port !== 'number' || address.port <= 0) {
    await server.close()
    throw new Error('renderer dev server 未拿到监听端口')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => { await server.close() }
  }
}
