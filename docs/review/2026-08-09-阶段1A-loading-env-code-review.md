# Electron 前端阶段 1A（Loading / Env）代码审查

> 审查日期：2026-08-09  
> 审查对象：`/home/yomu/elysia-frontend`  
> 基线：`4bc7f01d75c7c05331d2779cdfcacbc326fd4d45`  
> 审查提交：`bef9134..689a06d`  
> 当前 HEAD：`689a06d`  
> 说明：这是阶段 1A 的未完成态审查，不是整个 Electron 前端的最终验收。

## 0. 修复状态（2026-08-10 追加）

- **[P3] 路径单测硬编码 POSIX —— 已修复**：`protocol-path.spec.ts` 改用 `path.resolve('opt','cyrene','renderer')` 派生期望值（块 A 最终 review fix 波，Windows 可移植）。
- **[P1] 负路径冒烟单实例锁假通过 —— 已修复**：`verify-artifact.cjs` 负路径测试前先关闭正路径 app 并等单实例锁释放（300ms），负路径退出不再可能被锁掩盖为「门禁生效」。
- **[P2] 普通浏览器 skip 正则过宽 —— 已修复**：移除通用 `browserType\.launch` 匹配，只对白名单化 chromium 环境缺失错误跳过；且块 C `trust-boundary.spec.ts` 已把该检查做成 CI 硬门（`test:integration`）。
- 第 3 节「范围提醒」的真实后端契约缺口：**仍属阶段 2 待办**（真实 REST/WS Adapter），清单见 `docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md`，未在本阶段实现。

## 1. 结论

阶段 1A 的主路径已经成形：生产环境通过 `cyrene://` 只读协议加载 Renderer，开发/测试环境的加载分支、CSP、导航门、调试开关门禁、构建与未分发包验证均已接线。类型检查、Lint、单元测试、构建、打包和带显示环境的启动冒烟均能通过。

本轮发现 3 个测试/验证可靠性问题。其中前两个会让安全门禁产生假通过，应在继续扩展后端接入前修复；第三个会影响 Windows CI 可移植性。

真实后端 Adapter、raw wire schema/mapper、REST/WS 联调等不属于阶段 1A 已提交范围，因此本审查**不把“尚未接后端”本身列为阶段 1A 缺陷**。但也不能据当前结果宣称前后端契约已对齐。真实契约差异及后续实现清单见：

- `/home/yomu/elysia-frontend/docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md`

## 2. 审查发现

### [P1] 打包产物的调试门负路径冒烟可能因单实例锁而假通过

位置：`apps/desktop/scripts/verify-artifact.cjs`，负路径测试所在的 `if (packagedExe)` 分支。

当前流程在第一个已打包 Electron 实例仍运行时，再启动一个带 `--remote-debugging-port=9222` 的实例。应用启用了单实例锁，因此第二个实例即使没有被调试门拒绝，也可能仅因拿不到单实例锁而无窗口退出。测试把 `launch()` 抛错或 `firstWindow()` 返回空统一解释为“调试门生效”，于是会出现安全门禁假阳性。

影响：未来若生产调试参数拒绝逻辑被删除或回归，`verify:artifact --smoke` 仍可能通过。

建议修复：

1. 先完成正路径断言并彻底关闭首个应用，再执行负路径启动；或为负路径使用隔离的应用身份/用户数据目录，确保不会命中单实例锁。
2. 不要只以“没有窗口/进程退出”作为成功条件；捕获并断言退出原因、stderr 中的明确拒绝标记，或增加专用测试退出码。
3. 增加一个故意绕过 `hasForbiddenDebugSwitch()` 的测试替身，证明冒烟在门禁失效时确实会失败。

### [P2] 普通浏览器信任边界检查对所有 Chromium 启动错误都可能跳过

位置：`apps/desktop/scripts/verify-artifact.cjs`，普通 Chromium 冒烟的 `catch` 分支。

跳过正则包含通用文本 `browserType\.launch`。Playwright 的 Chromium 启动失败消息通常都会携带这一调用上下文，因此权限、参数、进程异常、共享库损坏等真实回归也可能被误判为“二进制不可用或沙箱受限”并跳过。

影响：`window.desktopApi` 在普通浏览器中必须不存在，这项信任边界检查在 CI 上可能没有真正执行，但总门禁仍显示成功。

建议修复：

- 删除通用的 `browserType\.launch` 匹配；
- 仅对白名单化、可识别的环境缺失错误跳过，例如 Playwright executable 不存在、明确要求安装浏览器，或已确认的 Linux sandbox 错误；
- 跳过时输出结构化原因，并在具备 Playwright 浏览器的正式 CI job 中把“跳过”视为失败。

### [P3] 路径单测硬编码 POSIX 绝对路径，Windows runner 会失败

位置：`apps/desktop/tests/unit/protocol-path.spec.ts`。

测试根目录和全部期望值都硬编码为 `/opt/cyrene/renderer/...`。被测实现使用 Node `path.resolve()` / `path.relative()` 的平台语义；在 Windows 上，相同输入会生成 Windows 路径，当前期望值无法成立。

影响：代码本身可能支持 Windows，但跨平台 CI 会在单测层直接失败，掩盖真正的平台问题。

建议修复：使用 `path.resolve()`、`path.join()` 和临时测试根生成期望值，不在断言中固定 `/` 分隔符或 Linux 根目录。

## 3. 范围提醒：当前结果不能证明真实后端可接入

截至 `689a06d`，阶段 1A 聚焦 Electron 加载、安全边界与产物验证。仓库仍只有领域层 `BackendAdapter`/`MockBackend`，尚未实现真实 REST + WebSocket v2 Adapter，也未引入后端 raw frame 的 schema、mapper 与 golden fixtures。

因此下列事项仍属于后续阶段，不能被本阶段的 92 个单测和产物冒烟覆盖：

- 后端 raw `type` 帧映射为前端领域 `event`；
- `generation.segment.completed.content` 作为完整文本的权威覆盖；
- `session.conversationId` 与活动会话绑定；
- REST snake_case / WebSocket wire 字段转换；
- 历史消息 cursor 分页；
- 输入音频 descriptor、帧大小与提交对齐；
- 每会话 dictation STT profile；
- v2 版本拒绝与鉴权错误处理；
- 后端生成机器契约的跨仓漂移门禁。

这些差异已在契约审计文档中逐项给出实现与测试建议。等对应阶段提交后，应以当时的后端实际 SHA 和生成契约重新审查，不能直接沿用旧 Mock fixture 作为联调证据。

## 4. 已执行验证

以下检查在本机通过：

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:unit`：12 个测试文件、92 个测试通过
- `pnpm build`
- `pnpm package`
- `pnpm verify:artifact`
- Xvfb 下的已打包应用启动冒烟：`cyrene://`、Vue 渲染、CSS、CSP、应用信息、普通浏览器 `desktopApi` 隔离、截图均通过
- 手工启动已打包应用并传入 `--remote-debugging-port=49222`：应用立即拒绝并以非零状态退出
- `pnpm dev`：开发模式可启动（验证后人工终止）

未形成有效门禁或仍有残留的项目：

- `pnpm test:integration` 当前因没有匹配测试文件而失败；这是后续阶段尚未落地，不算阶段 1A 主路径回归。
- 手工传入 `--inspect=49223` 时，Electron/Node 在应用代码执行前短暂输出 `Debugger listening`，之后应用才拒绝启动。应用内检测无法消除该进程启动窗口；发布构建仍需依赖 Electron fuses、启动器/分发策略或进程级验证进一步收口。
- 当前负路径冒烟虽显示通过，但受本报告 [P1] 的单实例锁混淆影响，不能作为独立的端到端证明。

## 5. 建议处理顺序

1. 修复 [P1]，让负路径冒烟能证明“确实由调试门拒绝”。
2. 修复 [P2]，收窄普通浏览器检查的允许跳过条件。
3. 修复 [P3]，保证路径单测跨平台。
4. 后续真实 Adapter 提交完成后，按契约审计文档新增 raw-wire、mapper、断线恢复与跨仓契约测试，再进行下一轮前后端联审。
