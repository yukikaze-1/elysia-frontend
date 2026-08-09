# protocol — cyrene:// 受限自定义协议

- `scheme.ts`：`registerCyreneScheme()` 特权注册，必须在 app ready 前调用；
- `path.ts`：`resolveRendererPath` 纯函数（解码/穿越/NUL/双重解码拒绝）；
- `csp.ts`：`buildRendererCsp` 严格 CSP（无 unsafe-eval、frame-src none）；
- `mime.ts`：`mimeOf` 扩展名 MIME 映射（未命中返回 null）；
- `handler.ts`：`registerCyreneProtocolHandler` 只读服务渲染根，fail-closed；
- 附件/媒体协议服务延到阶段 3；仅服务渲染根，不映射任意磁盘。
