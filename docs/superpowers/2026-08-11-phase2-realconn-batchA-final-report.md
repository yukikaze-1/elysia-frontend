# Cyrene 阶段 2 真实联调整改·批次 A 最终报告：连接凭据安全 / 真实模式装配 / rejected ACK

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段2真实联调前端整改清单.md` 批次 A（FE-P0-01 / FE-P1-02 / FE-P1-01）
**HEAD：** main（批次 A commits：spec 6cb63ac、plan f02f350、实现 996a64b..0639bd2 共 14 commits）
**验证基线：** **361 单测 + 20 集成** + `pnpm typecheck` + `pnpm lint` + `pnpm build` 全绿
**状态：** 三块全部落地并经第三方整改清单验收（3/3 达成）；仍标「已开发、未联调」（B-01 到位后进入真实联调）

---

## 1. 批次概览

第三方 review 指出阶段 2「已开发、未联调」状态下真实联调前有 1 个安全阻断项（P0）与若干功能/契约问题。批次 A 按整改清单处理三项，每项走完整 SDD 流程（brainstorm→spec→code-review→plan→review→subagent 实施→task 收尾→最终 review→验收）：

```text
FE-P0-01 连接凭据安全(端点/Token Origin 绑定) ─▶ FE-P1-02 真实模式装配+连接设置 ─▶ FE-P1-01 rejected ACK
   (P0:Renderer 可令 Main 外发 Token)          (production 恒 Real + UI 配置流)       (空 messageId 被 schema 丢→15s 超时)
```

**流程执行：** spec 经 2 轮 code-review（事实核验 + 设计审查）+ 2 轮复核收敛；plan 同理（覆盖 ACK union 崩溃、跨桥保真、受影响测试清单等 19 条 findings）；subagent 三批实施（A: Task1-4 / B: Task5-7 / C: Task8-10）；最终 code-review 2 个 agent（安全/功能 + spec 一致/回归）1 轮修复闭环；第三方整改清单验收 agent 确认 3/3 达成。

## 2. 交付详情

### 2.1 FE-P0-01：连接凭据安全（Endpoint/Token Origin 绑定）

| 项 | 内容 |
|---|---|
| `connection-config` | 新增 `main/connection/connection-config.ts`：持有规范化 endpoint + token-origin 绑定；注入存储端口（load/save/clear token+binding）；纯逻辑可单测 |
| URL 规范化 | `new URL` + `node:net isIP` 回环判定（禁 `startsWith('127.')` 前缀匹配）；远程仅 https、http 仅回环；拒 userinfo/query/fragment；path 前缀保留去尾斜杠；ws 由 URL 对象协议转换派生 |
| Token 绑定 | 新增 `BACKEND_TOKEN_ORIGIN_KEY`（进白名单）；`setBackendToken` 先校验 endpoint；`setEndpoint` origin 变化自动清 token+binding；`connect()` 无参三步校验（无 endpoint / 绑定不符或 token 缺 / 用 baseUrl+token） |
| 安全纵深 | `credentials` 对 `BACKEND_TOKEN_ORIGIN_KEY` 拒绝通用写（绑定仅经 ConnectionConfig 内部维护）；审计记规范化 origin 不含 token |
| 审计 | endpoint:set 进 `diagnostics.auditor`；凭据 set/clear 保留既有日志元数据 |

### 2.2 FE-P1-02：真实模式装配 + 最小连接设置

| 项 | 内容 |
|---|---|
| 装配策略 | `main/config/backend-mode.ts` `resolveBackendMode`：打包恒 Real（mock env 也无法翻转）、未打包默认 Real、`CYRENE_BACKEND=mock` 显式 Mock |
| `CyConnectionPanel` | 新增连接设置面板：REAL/MOCK 徽标、Endpoint 设置、Token 状态 chip + 密码框设置/清除（提交后清明文）、连接/断开、后端 serverVersion/protocolVersion 展示 |
| desktopApi | 新增 `setEndpoint/getEndpoint/getRuntimeInfo`；`connect()` 改无参（arity 0，`chatConnectSchema=z.undefined()`）；白名单 18→21 键 |
| 集成测试 | `launchApp` 固定 `CYRENE_BACKEND=mock`；白名单 21 键断言；凭据往返先 setEndpoint；attacker endpoint 不泄漏 token；getRuntimeInfo |

### 2.3 FE-P1-01：rejected ACK Schema 与结构化错误

| 项 | 内容 |
|---|---|
| ACK schema | `RawUserAckSchema` 单对象 + `superRefine`（accepted 空 messageId 拒 / rejected 允许空）；**禁止**拆 union（外层 discriminatedUnion 实测会崩） |
| handleAck | rejected → 新码 `BACKEND_REJECTED` + `backendCode/retryable` 保留；缺 error 退化 `INVALID_INPUT` 立即 reject（不等 15s 超时） |
| 错误链 | `IpcErrorBody` 结构化扩展（backendCode/retryable/requestId）；executor 上提；preload `formatIpcError` message 前缀跨桥；renderer `parsePublicError` 反解剥离 kv 段 |
| UI | `CyChatInput` 发送失败横幅展示 `.message`；`connection/message store` 错误结构化 |

## 3. 关键决策汇总（记录于 spec §6，共 9 条 + 2 条收尾）

1. **FE-P0-01 方案（用户确认）**：Main 规范化 Endpoint + Token 绑定 Origin，不引入 `connectionProfileId` 模型（YAGNI；profile 是阶段 4 设置中心的事），`connection-config` 留扩展位。
2. **装配策略（用户确认）**：packaged 恒 Real；未打包默认 Real，`CYRENE_BACKEND=mock` 显式 Mock。
3. **Endpoint 内存持有不持久化**：重启需重设；设置中心（阶段 4）再做持久化 profile。
4. **Token 绑定用独立记录 key**（`BACKEND_TOKEN_ORIGIN_KEY`）而非按 origin 派生 key。
5. **允许 pathname（反向代理前缀）**：保留 path、去尾斜杠、`http→ws` 协议转换派生。
6. **错误结构**：`IpcErrorBody` 扩展 + `CyreneErrorCode.BACKEND_REJECTED`；本批只落连接错误与 rejected ACK 路径。
7. **批次 A 三项合一个 spec**：共享 endpoint/token 管理架构，拆两个 spec 会引入重叠。
8. **wsUrl 接口层改造推迟**：`ConnectInput`/`BackendAdapter.connect` 接口不动，RealBackend 现有派生保留（baseUrl 规范化后等价）；批次 B 统一。
9. **setBackendToken/clearBackendToken 编排**：connection-config 增方法 + `registerCredentialsHandlers` 对 `BACKEND_TOKEN_KEY` 特判委派（preload 签名不变）。
10. **收尾新增——plan 文档 typo 修正**：plan 内嵌 `CyneErrorCode`（缺 r）13 处由 implementer sed 修 + 文档修正（9c6fb80）。
11. **收尾新增——`BACKEND_TOKEN_ORIGIN_KEY` 拒通用写（纵深）**：最终 review 安全建议，绑定 origin 仅经 ConnectionConfig 内部维护（0639bd2）。

## 4. 验收（对照整改清单批次 A）

第三方整改清单验收 agent 确认 **3/3 达成**：

| 项 | 结论 |
|---|---|
| FE-P0-01 必须修改 1-5 + 验收测试（attacker 不泄漏/url 拒绝/本机可用/https 规范化/endpoint 变更不自动复用） | ✅ 达成（connection-config.spec + chat-service.spec + ipc-security 集成覆盖） |
| FE-P1-02 必须修改 1-7 + 验收测试（production 恒 Real/development 显式 Mock/REAL·MOCK 标识/连接设置/token 不可读回/后端版本展示/README 真实模式） | ✅ 达成（config-env.spec + CyConnectionPanel + README 小节） |
| FE-P1-01 必须修改 1-4 + 验收测试（rejected 即时/backendCode·retryable 保留/accepted 空 messageId 仍拒/缺 error 退化） | ✅ 达成（raw-schemas.spec + real-backend.spec fake-wss 实测） |

**门禁实测：** typecheck ✅ / lint ✅ / 361 单测（39 files）✅ / 20 集成（5 files）✅ / build ✅。

## 5. 已知限制（记录，待后续批次/联调）

- **批次 B 待推进**：FE-P1-03 会话初始化时序、FE-P1-04 conversation/epoch 守卫、FE-P1-05 完整错误链、FE-P2-01 超时/取消/门控。
- **批次 C 待推进**：FE-P2-02 IPC/replay 运行时 Schema 完整化、FE-P2-03 夹具跨仓库、FE-P2-04 文档漂移（README/CLAUDE.md 状态同步）。
- **本批未修低项（记录）**：① 凭据 set/clear 审计未进 `diagnostics.auditor`（保留 logger 元数据路径，批次 B 接 auditor）；② `parsePublicError` 会剥离 message 中形如 `[k=v]` 的未知字段正文（边缘，仅展示文本）；③ `MockBackend.connect` 仍用 input.serverUrl 覆盖（chat-service 恒传 `mock://local`，行为等价）。
- **`STORAGE_UNAVAILABLE` 无独立 fixture**（与 QUEUE_FULL 同路径，批次 B FE-P1-05 补）；「可重试」独立文案展示归批次 B。

## 6. 文档同步

- `docs/16` 变更记录追加批次 A 完整描述（三块 + 门禁 + 引用修正）；`README.md` 增加「真实模式联调」小节。
- 仍标「已开发、未联调」——B-01 真实环境到位后按 README 小节进入联调。

---

**批次 A 完成。** 三项整改全部落地并经第三方清单验收（3/3），361 单测 + 20 集成 + typecheck/lint/build 全绿。下一步：批次 B（会话初始化时序/conversation·epoch 守卫/完整错误链/超时·取消·门控）。
