# ipc — 具名 Schema 校验 IPC 骨架

阶段 1 填充：`channels.ts`（zod schema；通道常量在 shared/contracts/ipc.ts，Preload 只 import 类型与常量）+ `executor.ts`（createIpcHandler，纯）+ `registry.ts`（Electron 绑定 + isTrustedSender 主窗口 WebContents 锚点）+ `handlers.ts`（装配）。统一走 IpcResult 错误信封，不暴露原始 ipcRenderer。
