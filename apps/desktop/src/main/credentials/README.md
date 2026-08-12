# credentials — 凭据与密钥

本目录承载主后端连接凭据与模型服务密钥的持久化，是 Main 进程受信边界内的凭据单点。

- **加密落盘**：经 Electron `safeStorage` 加密后写入 `config/credentials.json`，文件权限 0600、原子写、每 key 独立加密块；多 key 损坏时按 key 重建、互不污染（批次 A 的 `EMPTY_FILE` 工厂）。
- **key 白名单单一来源**：合法凭据 key 全部收口于 `shared/contracts/credentials.ts`，存储层与 IPC 层共用同一白名单，杜绝任意字段写入。
- **credentialStatus 4 值**：`unavailable` / `locked` / `empty` / `available`，经具名 IPC 暴露给 Renderer。
- **token-origin 绑定**：`connection-config` 属连接配置，特判委派给连接模块；Token 与当前 Endpoint origin 绑定，origin 变化即清旧 Token，防跨域复用。
- **串行队列 + 有序退出**：写入经串行队列保证原子顺序；`close()/drain` 在退出时排空队列并同步落盘，配合统一 fatal 路径（批次 A）。
- Renderer 仅经 IPC 读取 `credentialStatus`，绝不见任何明文凭据。
