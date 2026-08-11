// 集成测试专用 Window.desktopApi 类型声明。
// 说明：src/preload/index.d.ts 与本文件内容同源，但 tsc 的同名遮蔽规则——目录内 index.d.ts 与
// index.ts 同名时声明文件被静默丢弃——使 tsconfig.node.json（含 tests/**/*）永远加载不到它。
// 本文件以非冲突基名落于 tests 树，让 launchApp 返回的 page.evaluate 内 `window.desktopApi` 在
// node 编译程序中可见（渲染进程类型来自 src/preload/index.d.ts，两者共享 @shared/contracts 类型）。
import type { AppInfo, BackendSession, CredentialStatus, RuntimeInfo } from '@shared/contracts'

declare global {
  interface Window {
    desktopApi: {
      getAppInfo(): Promise<AppInfo>
      getCredentialStatus(): Promise<CredentialStatus>
      setBackendToken(token: string): Promise<CredentialStatus>
      clearBackendToken(): Promise<CredentialStatus>
      // —— 连接装配（与 src/preload/index.d.ts 同源；Task 9 集成测试要调） ——
      setEndpoint(url: string): Promise<{ endpoint: string }>
      getEndpoint(): Promise<{ endpoint?: string }>
      getRuntimeInfo(): Promise<RuntimeInfo>
      connect(): Promise<BackendSession>
      // —— 聊天错误订阅(纯 push 通道,不入 invoke;与 src/preload/index.d.ts 同源窄声明) ——
      onChatError(handler: (err: { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }) => void): () => void
    }
  }
}

export {}
