# Cyrene 前端实施任务清单与进度跟踪

**文档版本：** v0.1
**文档状态：** 随实施持续更新 / 阶段 0 基线 + 阶段 1 三块（安全加载/凭据·日志/集成测试）已落地并全量验证（182 单测 + 18 集成）；阶段 2 三块（A 领域契约+raw wire / B RealBackend / C Store+IPC+UI）全部落地并全量验证（312 单测 + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 2 真实联调整改·批次 A（连接凭据安全 / 真实模式装配 / rejected ACK 结构化）三块落地并全量验证（360 单测 + 20 集成 + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 2 真实联调整改·批次 B（真实连接编排：连接后会话初始化 / conversation·epoch 守卫 / 可见错误链与脱敏日志 / 超时·取消·门控）落地并全量验证（**399 单测 + 22 集成** + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 2 真实联调整改·批次 C（IPC/replay 运行时 Schema / 夹具场景补全 + manifest 门禁 + 跨仓库脚本 / 文档漂移同步）落地并全量验证（**433 单测 + 22 集成** + typecheck/lint/build 全绿，**已开发、未联调**）；阶段 0/1 整改·批次 A（FE-S1-P0-01 Windows 安全文件首建/ENOENT 保留 / FE-S1-P1-02 非普通文件全拒 / FE-S1-P2-02 EMPTY_FILE 工厂化 / FE-S1-P1-03 CredentialStore 有序退出）落地并全量验证（**460 单测（42 files）+ 22 集成（5 files）** + typecheck/lint/build + check:contract(11/11) 全绿，**已开发、未联调**；Windows 联调仍阻塞，真 Windows 运行证据与 Windows CI 归后续批次 C）；阶段 0/1 整改·批次 B（FE-S1-P0-02 dev Renderer URL 回环白名单 + 启动报错退出 + 开发 CSP / FE-S1-P2-01 IPC 来源纵深）落地并全量验证（**483 单测（45 files）+ 22 集成（5 files）** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿，**已开发、未联调**；**P0-02 关闭**（首次真实联调前最后 P0）；Windows 联调仍阻塞，真 Windows 运行证据与 Windows CI 归后续批次 C）；阶段 0/1 整改·批次 C（FE-S1-P1-01 审计接线（凭据生命周期 `credential:set/clear/status-change` + 连接生命周期 `connection:connect/disconnect/error` 接入 append-only audit；fail-open 语义 C1——审计失败不改变操作结果；真实应用装配集成测试：经 IPC set/clear 后 audit/ JSONL 出现预期行）+ FE-S1-P1-04 CI 持续门禁（新增 `artifact` job：clean + package + `verify:artifact --smoke` + SHA 证据；新增 `windows` job：构建级 typecheck/lint/unit/build，C3 不启动 Electron；POSIX 专属单测加平台守卫））落地并全量验证（**493 单测（45 files）+ 23 集成（6 files）** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿，**已开发、未联调**；真实后端联调未进行，CI 两个新 job 需 push 触发 GHA 验证（本机沙箱无 GHA），Windows 联调仍阻塞（真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续，C3 明确构建级））；阶段 0/1 整改·批次 D（FE-S0-P1-01 首次联调口径冻结（Linux 本机文本聊天最小闭环 13 项用例 + 三态状态 + 阶段 0「带已知豁免提前开发」+ Windows「阶段 1 未通过项」+ 外部依赖清单 + README 真实联调启动说明）/ FE-S0-P1-03 MockBackend 隔离与真实性（每实例会话状态 + 一致 CRUD + 每次 send 唯一 ID + 可注入 clock/ID + 单 generation 取消 + 并发/多实例测试）/ FE-S0-P2-01 Node engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出 / FE-S0-P2-02 占位命令非零退出 + credentials/diagnostics 子 README 真实化 + 主 README preload 修正）落地并全量验证（**501 单测（46 files）+ 23 集成（6 files）** + typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿，**已开发、未联调**；真实后端 B-01 联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板为唯一剩余外部依赖）；首次真实联调整改（FE-INT-P1-01 state/typing 兼容帧（strict + no-op + fail-closed + check:contract 13/13 + state-typing fixture + manifest schemaHash 同步）/ FE-INT-RISK-01 单写者约束文档化）落地并全量验证（**510 单测（46 files）+ 23 集成（6 files）** + typecheck/lint/build + check:contract(13/13) 全绿，**已开发、未联调**；B-01 正式验收未通过，首次真实联调已执行（2026-08-13，确认 P1/RISK 问题并修复中））；二次真实联调整改（FE-INT2-P0-01 Renderer 启动 snapshot 水合编排 + 启动代次守卫 / FE-INT2-P1-01 replay 身份契约防御（schema 要求非空 message_id/timestamp + 移除共享 fallback + 无身份帧协议错误由 REST 恢复）/ FE-INT2-P1-02 取消码统一（GENERATION_CANCELLED + 取消终态 interrupted 无失败横幅））落地并全量验证（**526 单测（47 files）+ 23 集成（6 files）** + typecheck/lint/build + check:contract(13/13) + package + verify:artifact --smoke 全绿，**已开发、未联调**；三次真实联调整改（真实 ws 连接关闭 permessage-deflate 修复 aiohttp 空闲压缩断连 + 握手回归 + Windows 真机 76s 空闲文本/reload/取消复验）落地并全量验证（**527 单测（47 files）+ 23 集成（6 files）** + typecheck/lint/build + check:contract(13/13) 全绿，**已真实联调**；**B-01 已封口**（2026-08-14，十项真实复跑全绿，阶段 2 主链转「已真实联调」））；阶段 3 可转为主线；真实联调待外部输入（H-01/H-07/G-01/G-02，B-01 已关闭）；阶段 0 标「带已知豁免提前开发」（非「已验证」，三态状态源见 README「真实模式联调」小节）；Windows 冒烟已通过（B-01 十项复跑真 Windows 全绿，构建级 CI 继续保留）；**阶段 3 四组（G1 布局响应式 / G2 历史聊天体验 / G3 附件多媒体 / G4 历史查看器+表情+无障碍）全部落地并全量验证（904 单测（82 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract(13/13) 全绿）**，**阶段 3 已落地**；阶段 3 真实联调前整改（2026-08-15，日期自然日 P0-01 / webm kind hint D1 / REST 跨仓门禁 D2 / 贴图真实契约 D3 / 删死代码 D4 + B-02 验收口径）落地并全量验证（**904 单测（82 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿**，B-02/B-03 进入条件达成）；**阶段 3 真实联调复验整改（2026-08-15，P0-01 相对签名 URL 基于 endpoint 解析 / P0-02 ContentPart 可空数字 null 归一化 + REST/WS replay wire 边界放行 duration_ms null / P0-03 StickerPart 恢复（用户 Message.stickerId + assistant sticker 分段）/ P1-01 历史搜索统一 sortKey 升序）落地并全量验证**；**阶段 3 真实联调第二轮前端整改（2026-08-15，FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达）落地并全量验证（944 单测（83 files）+ 42 集成（11 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿）**（纯 CSS 容器约束 + loadMore 锚点补偿 + mock 大 seed CYRENE_MOCK_HISTORY_LARGE 分页语义对齐 real + 真实 Electron 布局/点击集成测试三用例），阶段 3 已真实联调通过（2026-08-15，历史查看器 50+50 短回归：普通点击加载第二页 100 条顺序/去重/来源跳转正常，后端 556117a），阶段 3 整体升「已真实联调」；阶段 2 主链保持「已真实联调」（B-01 封口）；**阶段 4 批次 A（模型服务 Profile 管理 + TTS 试听 + 设置中心框架）已落地并全量验证（1003 单测（88 files）+ 55 集成（13 files）+ typecheck/lint/build + check:contract WS 15/15 + REST 15/15 全绿，已开发、未联调）**；**阶段 4 批次 B（语音：普通录音 + 实时语音会话 + 输入法转写 + TTS 自动朗读 + 设置持久化）已落地并全量验证（1245 单测（100 files）+ 70 集成（15 files）+ typecheck/lint/build + check:contract 全绿，已开发、未联调）；阶段 4 真实联调整改（普通录音异常清理 FE-S4-RUN-P0-01/P1-01/P1-02，discard 幂等语义 + 等待态 + voice.error 门控 + mock 冻结契约建模 + 协议桩漂移 canary）已落地并全量验证（**1284 单测（100 files）+ 73 集成（15 files）** + typecheck/lint/build 全绿，已开发、未联调，整改后仍待配套后端 BE-S4-RUN-P0-01 修复 SHA 真实 Windows Electron 复验）**；阶段 4 新功能（A/B）均保持「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方；**阶段 5 批次 A（Live2D 地基）已落地并全量验证（1400 单测（106 files）+ 83 集成（16 files）+ typecheck/lint/build + check:contract（WS 28/28 + REST 15/15）全绿，已开发、未联调）**——SDK vendoring（Cubism Web SDK 5-r.5）+ Main 注册表/integrity + cyrene:// 供给 + 装配 CLI + Adapter + Controller/store + settings 契约 + Panel 最小面 + Electron 集成，真实 Windows Electron（REAL）联调归批次 C/D；**阶段 5 批次 B（Live2D 表现）已落地并全量验证（2026-08-18，1508 单测（114 files）+ 90 集成（16 files）+ typecheck/lint/build 全绿，已开发、未联调）**——状态机收敛表 + 待机眨眼/呼吸 + 动作/表情白名单调度 + 无动作参数级回退 + `live2dStateSource` 状态编排 + 情绪态→表情本地映射 + 「角色与外观」设置子页（`Live2DSettings` 10 字段 + `performanceMode` 四值归一）+ Panel 状态徽标/缩放偏移/鼠标跟随点击回正 + `switchModel` 生效 id 竞态硬化 + Electron 集成新增 7 用例（状态驱动/动作播放/情绪表情/设置子页/性能模式/布局/切换竞态），真实 Windows Electron（REAL）联调归批次 C/D
**文档日期：** 2026-08-06
**依据文档：** [10-Cyrene-前端实施路线与任务拆分-v0.2.md](10-Cyrene-前端实施路线与任务拆分-v0.2.md)、[12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md](12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md)

---

## 0. 本文定位与使用方式

本文是**逐阶段执行的活清单**，把文档 10 的技术任务和文档 12 的进入条件/验收门槛拆成可勾选项，用于跟踪推进进度。它**不替代** 10/12：两份依据文档仍是阶段编号、进入条件和验收门槛的权威来源；发现差异时以 12 为准，并同步修订 10 与本文。

**状态标记（沿用文档 12 约定）：**

- `[ ]` 待办 / 尚未提供；
- `[~]` 进行中 / 部分完成；
- `[x]` 已完成并通过验证；
- 仅由 Mock 驱动完成的任务必须标注 **“已开发、未联调”**，真实后端通过前不得标为“已完成”。
- **三态状态源（见 README「真实模式联调」小节）**：**已开发**（Mock 驱动落地）/ **已验证**（typecheck/lint/test/build + package + verify:artifact --smoke 全绿、未真实联调）/ **已真实联调**（真实后端 B-01 验收通过）；阶段 0 因外部输入未到位标「**带已知豁免提前开发**」（非「已验证」）。

**更新规则：** 每个任务完成时在括号后补记日期与方式；新增需求进入变更清单，不直接插入当前阶段。

---

## 1. 总体阶段视图

```text
阶段 0 资料与协议基线 ──▶ 阶段 1 Electron 安全骨架 ──▶ 阶段 2 核心聊天纵向闭环
                                                            ├─▶ 阶段 3 完整聊天、历史与多媒体
                                                            ├─▶ 阶段 4 模型服务与语音
                                                            └─▶ 阶段 5 Live2D
                             阶段 1/2 ──▶ 阶段 6 工具、权限与 Desktop P0 能力
  阶段 3/4/5/6 ──▶ 阶段 7 安全、稳定性与性能收敛 ──▶ 阶段 8 打包、跨平台与 Demo 验收
```

**当前所处阶段：阶段 1 三块（安全加载 / 凭据·日志 / IPC 集成测试）全部落地并全量验证；阶段 2 三块（A 领域契约+raw wire、B RealBackend REST/WS Adapter、C Store+IPC+聊天 UI 纵向闭环）全部落地并全量验证（312 单测 + typecheck/lint/build 全绿），标记「已开发、未联调」——「发送 → 流式 → 渲染」完整链路已打通（Mock 驱动）；阶段 2 真实联调整改·批次 A（FE-P0-01 Token 与 Endpoint Origin 绑定 / FE-P1-02 Real/Mock 装配策略与最小连接设置 / FE-P1-01 rejected ACK 即时结构化传递）落地并全量验证（360 单测 + 20 集成），仍标记「已开发、未联调」——连接面板（Endpoint/Token 设置）+ 装配策略已就绪；阶段 2 真实联调整改·批次 B（FE-P1-03 连接后会话初始化 / FE-P1-04 conversation·epoch 守卫 / FE-P1-05 可见错误链与脱敏日志 / FE-P2-01 超时·取消·门控）落地并全量验证（399 单测 + 22 集成 + typecheck/lint/build 全绿），仍标记「已开发、未联调」——连接后会话自动就绪、切会话不串台、错误可见、超时/门控完整，真实后端环境（B-01）到位即可进入联调；阶段 2 真实联调整改·批次 C（FE-P2-02 IPC 成功响应/replay 运行时 Schema（Main/Preload 双层校验 + 单条丢弃告警）/ FE-P2-03 夹具场景补全（7 组）+ manifest schemaHash/verified 门禁 + 跨仓库契约脚本 `check:contract` / FE-P2-04 文档漂移同步）落地并全量验证（433 单测 + 22 集成 + typecheck/lint/build 全绿），仍标记「已开发、未联调」——IPC/replay 边界运行时保障、夹具 schemaHash 门禁与 B-01 联调门禁（真实样例 → parseRawFrame + mapper 断言）就绪；阶段 0/1 整改·批次 A（FE-S1-P0-01 Windows 安全文件首建/ENOENT 保留（safe-open 重构为可注入 `SafeOpenPlatform` posix/windows）/ FE-S1-P1-02 非普通文件全拒（FIFO/socket/目录/device，POSIX 打开追加 `O_NONBLOCK` 防阻塞）/ FE-S1-P2-02 `EMPTY_FILE` 工厂化（多 key 损坏重建不污染）/ FE-S1-P1-03 CredentialStore `close()`/drain + 有序退出（凭据→adapter→diagnostics + 超时标记经同步审计落盘 + 统一 fatal 路径））落地并全量验证（460 单测（42 files）+ 22 集成（5 files）+ typecheck/lint/build + check:contract(11/11) 全绿），仍标「已开发、未联调」——跨平台文件与退出地基就绪，Windows 联调仍阻塞（真 Windows 运行证据与 Windows CI 归批次 C）；阶段 0/1 整改·批次 B（FE-S1-P0-02 dev Renderer URL 回环白名单（`ELECTRON_RENDERER_URL` 只接受回环 localhost/127.0.0.0/8/[::1] + `CYRENE_DEV_RENDERER_ORIGINS` 附加 allowlist，非法 URL **启动报错退出**，受信 Renderer URL 收敛为 Main 单一策略函数，窗口加载/导航/IPC 来源共用）+ 开发 CSP（`frame-ancestors 'none'` 经 Vite 中间件注入响应头 + meta 收紧 `frame-src/form-action 'none'` + `connect-src` 去裸 ws:/wss:）/ FE-S1-P2-01 IPC 来源纵深（`senderFrame===mainFrame` + 发送 frame 当前 URL 受信校验））落地并全量验证（483 单测（45 files）+ 22 集成（5 files）+ typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿），仍标「已开发、未联调」——**P0-02 关闭**（首次真实联调前最后 P0），dev 回环启动冒烟 + HMR 放行 headless 不可做（记为 B-01 联调首日或本机冒烟验证项），Windows 联调仍阻塞（真 Windows 运行证据与 Windows CI 归批次 C）；阶段 0/1 整改·批次 C（FE-S1-P1-01 审计接线（凭据生命周期 `credential:set/clear/status-change` + 连接生命周期 `connection:connect/disconnect/error` 接入 append-only audit；fail-open 语义 C1——审计失败不改变操作结果；真实应用装配集成测试：经 IPC set/clear 后 audit/ JSONL 出现预期行）+ FE-S1-P1-04 CI 持续门禁（新增 `artifact` job：clean + package + `verify:artifact --smoke` + SHA 证据；新增 `windows` job：构建级 typecheck/lint/unit/build，C3 不启动 Electron；POSIX 专属单测加平台守卫））落地并全量验证（493 单测（45 files）+ 23 集成（6 files）+ typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿），仍标「已开发、未联调」——审计接线与 CI 持续门禁就绪，真实后端联调未进行，CI 两个新 job 需 push 触发 GHA 验证（本机沙箱无 GHA），Windows 联调仍阻塞（真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续，C3 明确构建级）；阶段 0/1 整改·批次 D（FE-S0-P1-01 首次联调口径冻结（Linux 本机文本聊天最小闭环 13 项用例 + 三态状态 + 阶段 0「带已知豁免提前开发」+ Windows「阶段 1 未通过项」+ 外部依赖清单 + README 真实联调启动说明）/ FE-S0-P1-03 MockBackend 隔离与真实性（每实例会话状态 + 一致 CRUD + 每次 send 唯一 ID + 可注入 clock/ID + 单 generation 取消 + 并发/多实例测试）/ FE-S0-P2-01 Node engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出 / FE-S0-P2-02 占位命令非零退出 + credentials/diagnostics 子 README 真实化 + 主 README preload 修正）落地并全量验证（501 单测（46 files）+ 23 集成（6 files）+ typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿），仍标「已开发、未联调」——阶段 0 真实性就绪（口径冻结 + Mock 可信 + 工程约束真实），真实后端 B-01 联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板为唯一剩余外部依赖；首次真实联调整改（FE-INT-P1-01 state/typing 兼容帧 + FE-INT-RISK-01 单写者约束）落地并全量验证（510 单测（46 files）+ 23 集成（6 files）+ check:contract(13/13) 全绿），仍标「已开发、未联调」——首次真实联调已执行（2026-08-13）、二次真实联调整改（Renderer 水合 + replay 身份 + 取消码）落地并全量验证（526 单测）；**三次真实联调整改（WS 压缩关闭修复）落地，B-01 已真实联调通过**（2026-08-14，Windows 真机十项复跑全绿，527 单测（47 files）+ 23 集成（6 files）+ check:contract 13/13），阶段 2 主链由「已开发、未联调」转「已真实联调」；**阶段 3 四组（G1 布局响应式 / G2 历史聊天体验 / G3 附件多媒体 / G4 历史查看器+表情+无障碍）全部落地并全量验证（904 单测（82 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract(13/13) 全绿），阶段 3 已落地**；阶段 3 真实联调前整改（2026-08-15）落地并全量验证（904 单测 + 39 集成 + check:contract WS 13/13 + REST 段 8/8 全绿），B-02/B-03 进入条件达成；**阶段 3 真实联调复验整改（P0-01 相对签名 URL / P0-02 ContentPart null / P0-03 StickerPart 恢复 / P1-01 搜索排序升序）落地并全量验证**；**阶段 3 真实联调第二轮前端整改（FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达）修复并全量验证（944 单测（83 files）+ 42 集成（11 files）+ typecheck/lint/build + check:contract WS 13/13 + REST 段 8/8 全绿）**，阶段 3 已真实联调通过（2026-08-15，历史查看器 50+50 短回归），阶段 3 整体升「已真实联调」，阶段 2 主链保持「已真实联调」；下一块为阶段 4/5（模型服务与语音 / Live2D），可升为主线。**

- 仓库与 git：已完成（初始化、分支 main、远程 origin、上游跟踪）
- 开发环境：已完成（fnm + Node 22.23.0 + pnpm 11.20.0，`.nvmrc` / `.npmrc` / README）
- 工程脚手架：已完成（阶段 0 基线：脚手架/契约/Adapter+Mock/token+四区 UI/单测/CI，见 §3）
- 后端输入（B/C/D/E/F 契约）：**已由后端批次 0-8c 全部实现并交付**（frontend-handoff-v2），doc 02 §19 对齐表已填写；真实环境实测/联调待进行（详见 §2 说明）
- 仍缺输入（外部资源/产品决策）：主验收平台（H-01）、Demo/联调成功标准（H-07）、Live2D SDK 与模型资源（G-01/G-02）、签名证书（H-04）（B-01 测试环境地址已到位，2026-08-14 联调通过）；其余 `[ ]` 为前端本地授权/沙盒/审计设计与产品决策（非后端缺口）
- **已知限制（2026-08-13 首次真实联调整改 T1+T2 记录）**：① **FE-INT-RISK-01 单写者约束**——单活动桌面客户端/单写者，同会话由多个客户端同时写入不在当前产品范围；其他客户端对当前活动会话的写入（本端无本地 optimistic user 消息的 generation）保留现状到达序渲染，不保证跨客户端因果顺序；多客户端支持需前后端共同设计因果链（后端 generation.started 前广播 user committed / generation 携带 user 引用 / 会话级单调 sequence），当前不做；「低级别诊断」与「提示来自其他客户端」两选项均否决（单写者下跨客户端 generation 属罕见异常，额外诊断/提示引入 renderer 逻辑与文案成本，且不改变「不保证因果顺序」的事实）；**本项不纳入首次单客户端 B-01 阻断门禁**。② 后端合法 `state`/`typing` 帧已建模为「已知但有意忽略的兼容帧」（不再 `RAW_FRAME_INVALID`，renderer 暂不消费，留阶段 3+）；未知帧仍 fail-closed `RAW_FRAME_INVALID`。③ 后端 `message_id=""` 阻断：前端非空校验保持（四种不可接受改法全部拒绝，本批不改该 schema）。

---

## 2. 待补齐的外部输入（来自文档 12，P0 阻塞项优先）

> 这些输入决定 Adapter 契约与联调排期；未到位时对应任务只能以 Mock 推进并标注“已开发、未联调”。

> **2026-08-08：** 后端**批次 0-8c 全部完成**（协议契约 + 审计修复闭合，2798 tests），交接包 frontend-handoff-v2 提供全部协议契约；doc 02 §19/§19.1 已填写（27 项对齐 + D-1~D-10 桥接差异）。符号约定：**`[~]` = 契约已由后端提供/确认、待真实环境实测/联调**（后端只读核对，未改后端）；**`[ ]` = 前端产品/安全决策或外部资源，非后端未实现**。已标 `[~]`：B-02~B-06/B-08、C-01~C-09、**D-01~D-08**、E-01~E-06/E-08、F-01~F-05/**F-06（沙盒目录已定）**/**F-08**、G-04、**H-03/H-06/H-09（日志/开发者模式策略已定默认）**。仍缺 `[ ]`：B-01/B-07、C-10/C-11、E-07（转写专用 STT 字段，待决策）、E-09（Local Worker 接口）、F-07/F-09~F-11（**前端本地授权/审计设计**）、G-01~G-03/G-05/G-06（**Live2D SDK 许可 + 模型资源，外部输入**）、H-01/H-02/H-04/H-05/H-07/H-08（**产品决策/签名证书**）。阶段 1 进入条件 E-03 凭据所有权契约已确认（后端 Secret Store + desktop/local 归 Electron），前端侧落地 = `safeStorage` 不可用即拒存（§4.0）。

> **2026-08-15 状态注（阶段 4 批次 A 落地）：** **E-07 已由「待决策」转「契约已确认」**——后端 `556117a` 已为 `dictation.start` 增加 `sttProfileId` 独立字段（`<provider>/<model>`，缺省用全局活动 STT，会话内快照不改全局活动 STT），doc 02 §19 D-8 关闭；输入法转写可经 `dictation.start.sttProfileId` 独立选择兼容 STT Profile，无需 start 前经 `switch_model` 切换。E-07 行同步升 `[~]`。仍缺 `[ ]` 不变：E-09（Local Worker 接口）、F-07/F-09~F-11（前端本地授权/审计设计）、G-01~G-03/G-05/G-06（Live2D SDK 许可 + 模型资源）、H-01/H-02/H-04/H-05/H-07/H-08（产品决策/签名证书）。

### 2.1 工程、仓库与协作（A 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [x] | A-01 | 前端仓库（已建并推送 `elysia-frontend`，main 分支） | 0 |
| [~] | A-02 | 分支/提交/Review 约定（已定：本地提交、手动 push；Review 方式待定） | 0 |
| [x] | A-03 | Node 版本、包管理器与工具链（fnm + Node 22.23.0 + pnpm） | 0 |
| [x] | A-04 | 代码规范/格式化/Lint/测试约定（eslint flat config + vitest + tsconfig 已落地） | 0 |
| [ ] | A-05 | CI 环境与 Runner（Windows/Ubuntu Runner 是否可用） | 1 |
| [~] | A-06 | Issue/变更/版本记录方式（暂用本文档与 git 记录） | 0 |

### 2.2 后端环境、认证与基础通信（B 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [x] | B-01 | 测试环境地址/端口/协议/网络访问（2026-08-14 真实联调十项复跑通过） | 0 |
| [~] | B-02 | 认证方式、测试账号、Token 获取/刷新/注销（契约已确认：静态 Bearer + `AGENT_ACCESS_TOKEN`，无 refresh/注销；测试账号待环境） | 0 |
| [~] | B-03 | REST / WebSocket / SSE 真实连接样例（WS v2 + REST，无 SSE） | 0 |
| [~] | B-04 | 协议版本、客户端版本协商与不兼容错误（`X-Protocol-Version` + `server_info.protocol_version`） | 0 |
| [~] | B-05 | 心跳、超时、断线、重连与续传规则（无断点续传；session 回放 + pending/generations 查询） | 2 |
| [~] | B-06 | 统一错误结构、错误码与 traceId 规则（40 码 + `ProtocolError`，WS 侧 `requestId`） | 2 |
| [ ] | B-07 | 测试环境上传/清理规则 | 3 |
| [~] | B-08 | 后端日志查询 / 联调 Trace 协作方式（`requestId` 关联） | 2 |

### 2.3 会话、消息与流式回复契约（C 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | C-01 | 会话列表/新建/重命名/删除/详情接口（`/api/sessions` + WS `activate_session`） | 2 |
| [~] | C-02 | 历史消息分页、稳定排序键、游标失效规则（`before`/`after` keyset + `has_more`） | 2 |
| [~] | C-03 | 发送/确认/重试与 `clientRequestId` 幂等规则 | 2 |
| [~] | C-04 | 完整回复的开始/增量/分段完成/父完成/失败事件记录（`traces/ws-v2-*.jsonl`） | 0 |
| [~] | C-05 | `messageId/generationId/segmentId/segmentIndex` 真实字段（`responseId` 弃用，别名 `generationId`） | 0 |
| [~] | C-06 | Inner Voice 与 Public Reply 字段、交错顺序与完成语义 | 0 |
| [~] | C-07 | 回复级/会话级 Token 字段（`usage{turn_total,rounds}` + `conversationUsage{total,byModel}`） | 2 |
| [~] | C-08 | 实际模型、心情代码、显示名、强度与来源字段（`generation.completed.model/mood`） | 2 |
| [~] | C-09 | 停止生成、取消成功与迟到增量规则（WS `interrupt` → `generation.failed{CANCELLED}`） | 2 |
| [ ] | C-10 | Markdown/引用/链接/代码块格式样例（后端 content 为纯文本，渲染由前端处理） | 2 |
| [ ] | C-11 | 撤回/编辑/重新生成/分支是否进入 Demo | 3 |

### 2.4 附件、多媒体、搜索与聊天历史（D 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | D-01 | 附件上传流程（`POST /api/uploads`：multipart `files[]`+`kind`、魔数校验、≤10 文件、10/50/20/20MB、聚合 64MB、sha256、取消/丢弃） | 3 |
| [~] | D-02 | 附件下载/播放鉴权、URL 有效期与刷新（签名下载 `/api/attachments/{id}?sig=&exp=` 24h + 签发 `/sign` 端点 + Range/206） | 3 |
| [~] | D-03 | 图片/视频/音频元数据、MIME/编解码矩阵、缩略图（MIME/编码矩阵已确认；**缩略图后端未提供**，阶段 3 前端处理） | 3 |
| [~] | D-04 | 拖拽/粘贴允许类型、数量与最大尺寸（后端校验权威：类型/MIME/数量/尺寸上限已确认） | 3 |
| [~] | D-05 | 历史查看器关键词/日期/分类/游标查询接口（`/api/search/messages` + `/api/sessions/{id}/messages` before/after） | 3 |
| [~] | D-06 | 搜索命中/资源项跳回来源消息所需 ID（`SearchMessageItem.messageId/responseId` + `ResourceItem.messageId`） | 3 |
| [~] | D-07 | 表情包来源、稳定 ID、版本、收藏与同步范围（内置 sticker 稳定 `st_` ID + `/api/stickers`；收藏/同步为产品决策） | 3 |
| [~] | D-08 | 资源保存/下载/缓存/过期清理策略（GC 四规则：软删 24h / 未引用 7 天 / 孤儿清理 / 磁盘缺失软删） | 7 |

> **2026-08-14 状态注（阶段 3 落地）：** D-01~D-07 已由阶段 3 落地实现——附件上传/待发送队列 + 通用媒体代理（D-01~D-04）、历史查看器 search/context 组合查询与来源跳转（D-05/D-06）、内置 `st_` 表情包清单与 stickerId 发送（D-07）；实现为 Mock 驱动标「已开发、未联调」，真实后端 search/context/stickers/附件端点联调复验通过后方可升「已真实联调」。D-08 仍归阶段 7。
>
> **2026-08-15 状态注（阶段 3 真实联调通过）：** 真实 Windows Electron 完成历史查看器 50+50 短回归（普通点击「加载更多」加载第二页，100 条顺序/去重/来源跳转正常，面板完整在窗口内内部滚动，FE-S3-RUN2-P1-01 闭环），D-01~D-07 与 2026-08-15 三批整改（联调前 / 复验 / 第二轮布局）全部升「已真实联调」，阶段 3 整体联调通过。D-08 仍归阶段 7。

### 2.5 模型服务、语音与输入法转写（E 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | E-01 | LLM/STT/TTS Profile 查询、创建、测试、激活、禁用、删除（`/api/providers` + WS `switch_model`） | 4 |
| [~] | E-02 | 内置/自定义 Profile 字段、Provider、能力、执行位置枚举（`runtime/credentialConfigured/capabilities`） | 4 |
| [~] | E-03 | 凭据所有权（后端/Main/Local Worker）与一次性提交规则（后端 Secret Store `data/secrets/`；desktop/local 归 Electron） | 1 |
| [~] | E-04 | 自定义 Endpoint 安全规则（后端 SSRF 校验已落地 `SSRF_BLOCKED`；前端 Header/重定向白名单细节阶段 4） | 4 |
| [~] | E-05 | 录音/实时语音音频格式、采样率、字幕、VAD、断句、轮次事件（三种语音 v2-only 契约已确认） | 4 |
| [~] | E-06 | TTS 整段/流式、音频格式、声音、取消与播放完成事件（`audio_*` 流式；声音 `GET /api/tts/voices`） | 4 |
| [~] | E-07 | 输入法转写专用 STT 选择与执行位置（后端 `dictation.start.sttProfileId` 契约已确认（`556117a`，`<provider>/<model>`，缺省用全局活动 STT），doc 02 §19 D-8 关闭） | 4 |
| [~] | E-08 | 输入法转写按下/松开/取消/最终文字/临时音频清理规则（`dictation.*` 契约已确认，零消息副作用） | 4 |
| [ ] | E-09 | Local Worker 启动、发现、版本、模型下载与资源占用接口 | 4 |

### 2.6 工具系统、Desktop Runtime 与权限策略（F 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [~] | F-01 | 工具注册表、名称/描述/Runtime/风险/输入输出 Schema（`GET /api/tools` → `ToolMetadata[16]`） | 6 |
| [~] | F-02 | Backend/Desktop/Local Worker 真实标识与路由规则（`runtime` + `X-Client-Platform: electron`） | 6 |
| [~] | F-03 | 工具请求/状态/进度/结果/失败/取消/超时事件（`tool.request` / `tool.status` 六态） | 6 |
| [~] | F-04 | `callId` 幂等、重连查询与结果重传规则（`paramHash` 篡改拒绝 + `GET /api/tools/calls/{callId}`） | 6 |
| [~] | F-05 | Demo P0 Desktop 工具最终清单（确认四工具：文件选/读/写 + 截图；`desktop.command.run` 不注册） | 6 |
| [~] | F-06 | 沙盒目录已定（`userData/sandbox`）；**路径/域名黑名单默认值与授权级别阶段 6 细化**（后端 security §3.2 明确属 Electron 本地职责，前端需自行设计） | 6 |
| [ ] | F-07 | 授权级别（一次/目录范围/命令模板/有效期/撤销）（前端本地授权设计，待产品决策） | 6 |
| [~] | F-08 | 受控命令模板是否进入 Demo（后端确认 `desktop.command.run` 不注册 → **命令模板不进入 Demo**，已闭环） | 6 |
| [ ] | F-09 | 文件写入 Diff、覆盖、写前哈希、冲突与回滚要求（前端工具 UX 设计，待产品决策） | 6 |
| [ ] | F-10 | 截图在 Windows/X11/Wayland 的选择与授权要求 | 6 |
| [ ] | F-11 | 审批历史/工具日志保留、容量、清理与导出策略 | 7 |

### 2.7 Live2D 资源与表现规则（G 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [ ] | G-01 | 可用的 Live2D SDK 版本、许可分类（AI/Chatbot/Expandable）（**外部输入**：SDK 许可需采购/确认；后端 `character/` 为性格配置非 Live2D 模型） | 5 |
| [ ] | G-02 | 至少两个合法模型配置及 Manifest（**外部输入**：需合法 Live2D 模型资源，代码无法提供） | 5 |
| [ ] | G-03 | 模型表情/动作/参数名称安全白名单 | 5 |
| [~] | G-04 | 后端情绪/状态 → idle/listening/thinking/speaking 映射表（`expression`/`generation.completed.mood` 源字段已确认；映射表待设计产出） | 5 |
| [ ] | G-05 | TTS 口型驱动方式（音量/音素/后端参数） | 5 |
| [ ] | G-06 | 默认模型、切换规则、目标帧率与低性能降级策略 | 7 |

### 2.8 平台、测试、发布与产品边界（H 组）

| 状态 | ID | 项 | 最迟阶段 |
|---:|---|---|---:|
| [ ] | H-01 | 首个主验收平台（建议 Windows 11 x64） | 0 |
| [ ] | H-02 | Windows 10 / Ubuntu 目标版本、X11/Wayland 范围 | 1 |
| [~] | H-03 | 应用名称、App ID、图标、版本号与版权（名称 Cyrene / 版本 0.1.0 已定于 `package.json`；App ID/图标/版权待定） | 1 |
| [ ] | H-04 | Windows 签名证书、Linux 包格式与发布渠道（**外部输入**：签名证书需采购） | 8 |
| [ ] | H-05 | 自动更新是否进入 Demo；更新源与回滚策略（产品决策） | 8 |
| [~] | H-06 | 测试账号/会话/文件/可公开截图数据（交接包 `traces/` 提供脱敏测试会话/消息；测试账号/Token 待真实环境） | 2 |
| [ ] | H-07 | Demo 演示脚本、P0/P1 范围与成功标准 | 0 |
| [ ] | H-08 | 性能基线机器与 CPU/内存/GPU 允许范围 | 7 |
| [~] | H-09 | 日志/开发者模式策略已定默认（轮转 5MB×3、审计 30 天、开发者模式恒关、诊断导出 = 阶段 7 安全收敛/Demo P0 范围）；正式确认待产品 | 7 |

---

## 3. 阶段 0：资料、协议与工程基线（带已知豁免提前开发）

**进入条件：** 最低开工条件已基本满足（仓库、环境、README 就绪）；后端 B/C 组 P0 输入未到位，不影响本阶段脚手架与 Mock 推进。

### 任务清单

- [x] 建立前端仓库（git init、分支 main、远程 origin、上游跟踪）——2026-08-06
- [x] 固定 Node、包管理器与工具链（fnm + Node 22.23.0 + pnpm + `.nvmrc` + `.npmrc` + pnpm-workspace.yaml）——2026-08-06
- [x] 编写 README（环境信息、命令、协作约定）——2026-08-06
- [x] 填写通信文档 02 §19 的后端对齐表（依据后端交接包 frontend-handoff-v2 批次 7：protocol-v2.md v0.6 + frontend_contract 单源包 + traces/）——2026-08-08
- [x] 初始化 `apps/desktop/` 工程（electron-vite + Vue 3 + TS + pnpm；Electron Forge 留待阶段 8）——2026-08-08
- [x] 建立前端领域类型、运行时 Schema 与公开错误模型（`shared/contracts`、`shared/schemas`、`shared/domain`、`shared/errors`）——2026-08-08
- [~] 把真实流式事件整理为可重复播放的脱敏夹具（已建 Mock 夹具 JSONL；后端真实轨迹现位于 `elysia-agent/frontend-handoff-v2/traces/ws-v2-*.jsonl`，待移植为正式夹具）
- [x] 建立 Main 中 `BackendAdapter` 接口骨架与 Mock Backend（已开发、未联调）——2026-08-08
- [x] 移植 `ref/cyrene-ui-preview-v5.html` 的设计 token 与四区布局为 Vue 组件（纯 UI 壳）——2026-08-08
- [x] 建立 `typecheck` / `lint` / `test` / `test:integration` 命令（Vitest）与最小 CI——2026-08-08
- [ ] 确认主验收平台、Live2D 资源与许可（H-01、G-01/G-02）

### 验收门槛

- [~] 全新环境按 README 能安装依赖并启动（沙箱内 dev 冒烟通过；窗口需在本机确认）
- [x] 类型检查、格式检查与最小测试命令通过（typecheck/lint/test 19 项通过）——2026-08-08
- [~] 真实事件不经 UI 组件即可映射为前端领域事件（Mock 事件经 Schema 后由 Adapter 消费；真实事件待后端提供）
- [x] Mock 能重放 Inner Voice / Public Reply 多句流（mock-replay 单测覆盖）——2026-08-08
- [x] 未确认字段集中登记在 02 对齐表（§19 + §19.1 字段差异表），无散落代码猜测——2026-08-08
- [x] 仓库中不存在明文凭据——2026-08-08

---

## 4. 阶段 1：Electron 安全骨架

**进入条件：** 阶段 0 通过；E-03 凭据所有权已确认。

### 4.0 前置决策（2026-08-08 已拍板）

| 决策 | 结论 | 依据 |
|---|---|---|
| App 身份 / userData | `app.setName('Cyrene')` → userData=`~/.config/Cyrene`；App ID 保持 `com.cyrene.desktop` | doc 12 H-03（App ID/图标/版权仍待正式确认） |
| 沙盒目录（F-06） | `userData/sandbox`，随应用数据走、0700、卸载即清理；黑名单默认值与授权级别阶段 6 细化 | 后端 security §3.2 明确路径校验属 Electron 职责 |
| 开发者模式（H-09） | **不进 P0 Demo**：生产构建恒关 DevTools、远程调试恒关、无开启路径；日志/审计脱敏仍做 | doc 07 §12、验收门槛第 6 条 |
| 凭据存储（E-03 前端落地） | Electron 侧 `safeStorage`；**不可用即拒存**（`credentialStatus=unavailable` + 提示解锁钥匙串），绝不静默明文降级 | doc 07 §11「优先使用系统安全存储」 |
| 日志/审计/诊断 | 运行日志轮转 5MB×3 份；审计保留 30 天；诊断导出 = 阶段 7 安全收敛（Demo P0 范围，导出前二次脱敏；阶段 1 块 B 只立 JSONL 机制） | doc 07 §11/§12、doc 11 设置中心 |

### 任务清单

- [x] 落地 Main / Preload / Renderer 进程边界与推荐目录结构（文档 01 §5）
- [x] 开启 Context Isolation、Renderer Sandbox、导航与新窗口限制
- [~] 让 Main 持有后端 Transport、认证凭据与原始协议解析（**凭据存储已落地**：`safeStorage` 加密 `config/credentials.json` + `credentialStatus` 4 值 IPC，Renderer 只经 IPC 见状态；真实 Token 供给/Transport 连接属阶段 2）
- [~] 建立具名、可校验的 IPC API（Preload `DesktopApi`）与公开事件订阅（取消函数）（具名 Schema 校验 IPC 与 Preload DesktopApi 已落地；公开事件订阅/取消函数属阶段 2，待后续块）
- [x] 实现窗口、单实例、外部链接拦截与应用生命周期
- [x] 建立普通设置、系统安全凭据、日志、诊断与临时目录（config/app-cache/logs/audit/temp/models/sandbox；**app-cache 避开 Chromium 的 Cache**，决策见 spec P-8）
- [x] 建立开发/测试/生产配置与最小打包流程（`__APP_MODE__` 烘焙 + `resolveAppConfig` 三 mode、生产安全默认恒关；electron-builder `dir` 未分发包 + `verify:artifact` 静态/冒烟）——2026-08-09
- [x] 落地 CSP（无 `unsafe-eval`）、受限自定义协议替代 `file://`（严格 CSP 响应头 + 保留 meta AND 取交集、`frame-src 'none'`；`cyrene://` 只读服务渲染根，打包恒走受限协议）——2026-08-09
- [x] 建立 IPC Schema 校验与非法通道/超大输入拒绝测试（zod Schema 校验机制与 executor 拒绝单测 + 块 C 集成测试：API 面白名单/4097/空串→SCHEMA_VALIDATION_FAILED/来源校验隐藏窗被拒）——2026-08-10

### 验收门槛

- [~] Renderer 无 Node、任意 IPC、系统凭据或带凭据后端直连（结构保证 sandbox/contextIsolation/不暴露 ipcRenderer + 冒烟确认普通浏览器 `window.desktopApi` 为 undefined；完整安全测试套件后续块）
- [x] 非白名单通道、非法参数与超大输入被 Main 拒绝（块 C 集成测试：desktopApi 面恰为白名单 + setBackendToken 4097/空串 → SCHEMA_VALIDATION_FAILED + 隐藏窗来源校验被拒）——2026-08-10
- [x] Token/密钥只显示状态，不能从 Renderer 读回（块 B 凭据 IPC：`credentials:get-status/set/clear` 统一返回 `{status,key}`，preload 只解包 `.status`、无明文读取通道；key 白名单单一来源 `shared/contracts/credentials.ts`）——2026-08-10
- [x] 外部链接通过受控接口打开（块 C 集成测试：window.open/location 外部 → shell.openExternal + deny 不导航）——2026-08-10
- [~] Windows 与目标 Ubuntu 开发环境各启动一次（**Ubuntu(Wayland)已冒烟通过**：Playwright `_electron` 启动构建产物，`getAppInfo` 返回 `{Cyrene, 0.1.0, linux}`、七目录 0700、四栏 UI 渲染；Windows 待验证）
- [x] 生产配置默认关闭开发者模式与 DevTools，远程调试端口始终关闭（`devToolsAllowed = !isPackaged` 恒关 + `Menu.setApplicationMenu(null)` 无加速键路径；远程调试门 main() 顶部同步拒绝显式端口/裸开关/pipe，`=0` 仅测试 harness 放行；verify:artifact 负路径冒烟验证拒绝生效）——2026-08-09

---

## 5. 阶段 2：核心聊天纵向闭环

**进入条件：** 阶段 1 通过；C-01～C-10 的 P0 项可用（暂缺则以 Mock 推进并标注“已开发、未联调”）。

### 任务清单

- [x] 连接、认证、心跳、重连与公开错误状态——2026-08-11（2B RealBackend：WS `/ws` 握手 `X-Protocol-Version:"2"`/`X-Client-Platform:electron`/Bearer、`server_info` 版本 fail-closed、心跳(pong)、断线指数退避重连 + `unexpected-response` fail-fast、`ConnectionState` 公开；**已开发、未联调**）
- [x] 会话列表、当前会话、历史第一页与基本管理——2026-08-11（2B RealBackend REST：list/get/create/rename/delete + `activateConversation`、`getConversationMessages` `_id` cursor 分页、`session` 回放缓冲归属；**已开发、未联调**）
- [x] 用户发送、乐观状态、确认与 `clientRequestId` 幂等重试——2026-08-11（2B `sendMessage` + ack 关联；2C messageStore 乐观发送 pending→acknowledged/failed + `clientMessageId` key 迁移；**已开发、未联调**）
- [x] 合并 `generation.started/segment.started/delta/segment.completed/completed/failed`——2026-08-11（2A 逻辑层：领域契约 + raw wire schema + frame-mapper + Accumulator；2C messageStore 经 `StreamAccumulator` 应用流式事件；**已开发、未联调**）
- [x] 按 `responseId` 归并有序 `AssistantSegment[]`——2026-08-11（2A Accumulator 权威 content 规则 + segmentIndex 排序；2C 渲染；**已开发、未联调**）
- [x] Inner Voice / Public Reply 全局分段顺序与独立展示（可折叠）——2026-08-11（2C CyMessageBubble 双通道渲染：inner_voice 折叠 + public_reply markdown，segmentIndex 全局排序；**已开发、未联调**）
- [x] 回复级/会话级 Token、实际模型与心情落位——2026-08-11（2A 逻辑层映射 + Accumulator 写入；2C UI chips 落位（completed 后显示）；**已开发、未联调**）
- [~] Markdown、代码块、复制、停止生成与基础断线恢复——2026-08-11（2C 已落地 Markdown 渲染（marked+消毒）、停止生成（乐观 interrupted + `generation.failed{CANCELLED}` 幂等）、断线提示（chat:state 推送 + in-flight interrupted）；**代码块复制/语法高亮与基础断线恢复 UX 属阶段 3**）
- [x] Adapter、流式累加器与 Store 的契约测试——2026-08-11（2A mapper/Accumulator/wire-fixtures 两层校验 + 2C 三 store 单测（mock desktopApi）+ IPC 链路；**已开发、未联调**）

### 验收门槛

- [x] 使用真实后端完成“新建会话 → 发送 → 流式回复”——2026-08-14（B-01 十项复跑通过：文本 ACK/流式/completed + 真实 `get_time` 工具 + 取消 `GENERATION_CANCELLED`；阶段 2 主链转「已真实联调」）
- [ ] 同一回复只显示一组头像、时间与操作区
- [ ] 分段完成不提前结束父回复（只有 `generation.completed` 结束）
- [ ] 重复、乱序与迟到增量不产生重复或污染
- [ ] 停止与断线保留已生成内容
- [ ] Inner Voice 缺失时不显示空区域
- [ ] UI 组件不引用后端原始字段

---

## 6. 阶段 3：完整聊天、历史与多媒体

**进入条件：** 阶段 2 通过；D-01～D-07 可用或有明确 Mock/联调日期。

### 任务清单

- [x] 四区主布局、会话栏折叠与 Live2D 右栏预留——2026-08-14（G1：`renderer/src/layout/` 常量 + effective-layout 断点 1200/736/520/320、会话栏 260 可折叠、Live2D 右栏默认显示 340 可调（[300,420]）、最小窗口 1100×700、布局记忆 Renderer localStorage `cyrene.layout.v1`；**已开发、未联调**）
- [x] 历史游标懒加载、虚拟列表与滚动锚点——2026-08-14（G2：CyMessageList 自研虚拟列表（估高 + ResizeObserver + 前缀和二分，不引三方库）+ 锚点捕获/恢复/补偿 + 回到底部；**已开发、未联调**）
- [x] 每会话草稿、离线缓存与损坏恢复——2026-08-14（G2：draftStore 草稿 50 会话×100KB 超限提示、离线缓存最近 20 会话、草稿/滚动锚点归 Main 持久化（persistSession/hydratePersistence/cacheMessages IPC + SessionStore）+ 损坏恢复；**已开发、未联调**）
- [x] 点击/拖拽/粘贴共用的附件校验与待发送队列（拖拽不自动上传/发送）——2026-08-14（G3：CyAttachmentQueue + CyDropOverlay，点击/拖拽/粘贴共用校验与待发送状态机，拖拽只进入待发送队列不自动上传发送；**已开发、未联调**）
- [x] 图片、视频、音频、文件、链接与错误/过期状态——2026-08-14（G3：附件内嵌 Message + ContentPart 映射、通用媒体代理 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`（attachment 签名 + Range/206、sticker 静态白名单）、原生预览 + 图标卡、错误/过期可解释占位；**已开发、未联调**）
- [x] 统一聊天历史查看器：关键词/日期/分类/分页/来源跳转——2026-08-14（G4：CyHistoryViewer 全窗覆盖式模态 + CyHistoryResultItem，关键词/本地自然日/分类组合查询 + 不透明游标分页 + 来源跳转与高亮；**已开发、未联调**）
- [x] 把原消息搜索与会话媒体统一到历史查看器（后端六分类：图片/视频、表情、文件、音频、链接）——2026-08-14（G4：搜索项文本展示（SearchMessageItem 无 kind/url，P0-1 缩略图缺口待后端确认）；原「绘画资源」提法已清理为六分类口径；**已开发、未联调**）
- [x] Emoji、表情包清单、最近使用、发送引用与历史分类——2026-08-14（G4：CyEmojiPicker（光标插入 + 最近优先 localStorage）+ CyStickerPanel（只内置 st_ 表情包清单 + stickerId 发送），历史查看器表情分类集中查看；**已开发、未联调**）
- [x] 键盘、焦点、中文输入法与基础可访问性——2026-08-14（G4：模态焦点陷阱/初始焦点/Esc 返回/aria-live/高亮非纯颜色 + IME 守卫硬化（isCompositionEnter 纯函数 + `.prevent` 移入发送路径）；**已开发、未联调**）
- [x] 落地 1200 / 736 / 520 / 320 响应式规则——2026-08-14（G1：四档断点落地，窄窗自动折叠会话栏/关闭 Live2D 保护聊天区；**已开发、未联调**）

### 验收门槛

- [x] 1100×700 可用，窄窗口无 Live2D 覆盖聊天——2026-08-14（G1 effective-layout 落地；实机视觉复验待人工）
- [x] 历史懒加载不改变当前可视锚点——2026-08-14（G2 锚点捕获/恢复/补偿，单测 + 集成覆盖）
- [x] 切换会话不丢草稿与合理滚动位置——2026-08-14（G2 切会话草稿 flush + 锚点持久化）
- [x] 拖拽附件只进入待发送队列，不自动上传或发送——2026-08-14（G3 拖拽/粘贴/点击共用校验队列）
- [x] 图片/视频/音频可预览/播放，失败状态可解释——2026-08-14（G3 原生预览 + 图标卡；真实媒体联调复验待）
- [x] 历史查看器可组合查询并跳回来源消息/分段——2026-08-14（G4；search/context 真实端点联调复验待）
- [x] Emoji 与表情包不自动发送——2026-08-14（G4）
- [x] 主要操作可通过键盘完成——2026-08-14（G4 焦点/键盘/IME；人工键盘走查待）

**B-02 通过口径（2026-08-15 联调前整改批次确认）：** 搜索日期按后端自然日契约（`date_from/date_to=YYYY-MM-DD` + `timezone=IANA`，不再预转 UTC ISO）；贴图 tab 保留 `category=sticker`（后端补白名单，前端不做客户端降级）；所有分类 tab 搜索结果以「纯文本行 + 「消息」chip」展示（真实 `SearchMessageItem` 无 resource/kind/url，chip 恒为「消息」、空 snippet 显示「（无文本命中）」），无缩略图（P2-3 已知限制）不视为缺陷；`image_video` 双子流独立游标合并语义记录；「跳回来源消息/分段」正常即通过；贴图发送（WS stickerId）→ 搜索命中 → 跳转四步闭环纳入 B-02 验收（真实后端 `category=sticker` 返回 200 非 400）。

---

## 7. 阶段 4：模型服务与语音

**进入条件：** 阶段 2 通过；E-01～E-08 已确认。

> **批 A（模型服务 Profile 管理 + TTS 试听 + 设置中心框架）已落地并全量验证（2026-08-15，final review 修复 wave 后）**：决策 D1（阶段 4 分两块，P4-A = Profile 管理 + TTS 试听 / P4-B = 语音）、D3（TTS 自动朗读归 P4-B）、D4（backend 为主，desktop/local_worker 展示不可用态）已由用户敲定；LLM/STT/TTS Profile 查询/新增/编辑/复制/删除保护/类型化测试/激活切换 + TTS 声音列表/试听（一次性 `tts-preview` media 路由）+ 设置中心框架（导航进入、面板内部滚动、其余分组占位）落地；`credentialStatus` 两态（凭据一次性提交不回显）；当前激活来源 `server_info.services` + `switch_model_result`/`set_tts_voice_result`（无 `model.profile.changed` wire 事件）；WS result 帧单 in-flight 按回显 service/model/voice 关联（10s 超时）；切换只影响新请求；**1003 单测（88 files）+ 55 集成（13 files）** + typecheck/lint/build + check:contract（WS 15/15 + REST 15/15）全绿；阶段 4 新功能仍标「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方（下一轮）；验收记录见 `docs/review/2026-08-15-阶段4批次A-验收记录.md`，决策记录见 `docs/review/2026-08-15-阶段4批次A-决策记录.md`。
>
> **批 B（语音：普通录音 + 实时语音会话 + 输入法转写 + TTS 自动朗读 + 设置持久化）已落地并全量验证（2026-08-16，本批 Task 1~15 + 文档同步 Task 16）**：三种语音模式（`voice.record.*`+BINARY+commit/discard / `voice_session.*` 全态+背压 / `dictation.start{sttProfileId}`+partial/final/cancelled）+ TTS 自动朗读（D3，`autoReadReply` 本地播放门 D-P1）+ settingsStore/设置持久化（Main `dirs.config/settings.json`，D-P6）+ 语音设置子页 `CyVoicePane` + 后端 STT 一次性同意（D-P16）+ 语音族错误路由（D-P15，connectionStore 横幅抑制）+ 会话切换守卫（D-P5）；13 新 BackendEvent + schema 镜像、`voice:audio-chunk` 单向守卫（`registerOneWayHandler`，1 MiB，D-P18）、麦克风权限处理器（D-P7）、MediaService `tts-live` 路由、Renderer `PcmCapture`（AudioWorklet/ScriptProcessor 降级）、mock 语音/TTS 模拟；**1245 单测（100 files）+ 70 集成（15 files）** + typecheck/lint/build + check:contract 全绿；阶段 4 新功能（A/B 两批）仍标「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方（下一轮）；决策记录见 `docs/review/2026-08-16-阶段4批次B-决策记录.md`。
>
> **阶段 4 真实联调整改（普通录音异常清理 FE-S4-RUN-P0-01/P1-01/P1-02）已落地（2026-08-16，6 tasks SDD）**：`voice.discard` 语义对齐配套后端修订 **BE-S4-RUN-P0-01**（可取消任意未提交阶段 RECORDING/TRANSCRIBING/PENDING + IDLE 迟到/重复 discard 幂等成功）→ 录音取消收敛单一 helper `discardRecord()`（recordingId 保留至取消帧发送 resolve/reject；发送失败 console.warn + 本地清态 + 连接 reset 收口）；`record.awaitingTranscript` 等待态（停后「正在识别…」→ transcript/error/45s timeout 终态；45s 兜底「未识别，请重试」为唯一翻转；`CyVoicePending` 渲染优先级 错误 > 字幕 > 正在识别 > 未识别，错误与字幕可并存；等待期试听/删除/重录可用、确认发送禁用）；`voice.error` recording 态消费门控（R-S4-06，防旧会话迟到错误污染新录音展示）；`MockBackend.discardVoice` 冻结契约五态建模 + `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` env（fire-and-forget transcript emit 延迟，R-S4-08）+ real-backend 有状态协议桩（冻结契约序列 + 漂移 canary）；**1284 单测（100 files）+ 73 集成（15 files）** + typecheck/lint/build 全绿；check:contract 待配套后端更新 `frontend_contract` discard 样例后复跑（本批无前端 schema 镜像变更）；阶段 4 新功能（A/B）仍标「已开发、未联调」（Mock 驱动）——**整改后仍待配套后端修复 SHA 真实 Windows Electron 复验（下一轮）**；决策记录 §10 见 `docs/review/2026-08-16-阶段4批次B-决策记录.md`，spec/plan 见 `docs/superpowers/specs|plans/2026-08-16-phase4-voice-cleanup-fixes-*`。

### 任务清单

- [x] LLM/STT/TTS 三类内置与自定义 Profile——2026-08-15（P4-A：查询/新增/编辑/复制/删除保护/类型化测试/激活切换；**已开发、未联调**）
- [x] Profile 新增、编辑、复制、删除保护、类型化测试与切换——2026-08-15（P4-A；**已开发、未联调**）
- [x] 后端/Main/Local Worker 凭据所有权与一次性提交（密钥不回显）——2026-08-15（P4-A：凭据一次性提交不回显、credentialStatus 两态；**已开发、未联调**）
- [x] 普通录音输入、待发送音频、试听与删除——2026-08-16（P4-B：🎤 录音→停止→`CyVoicePending` 待发送条（字幕/试听/重录/删除/确认发送）+ 本地 AudioContext 试听；真实联调整改：取消收敛 `discardRecord()`、停后「正在识别…」等待态 + 45s 兜底「未识别，请重试」、`voice.error` recording 态门控；**已开发、未联调**）
- [x] 实时语音会话、字幕、VAD、断句、语音轮次与停止——2026-08-16（P4-B：🔊 实时条 `CyRealtimeBar`、`voice_session.*` 全态 + ack 背压窗口（200 帧/5s 兜底）、轮次自动提交触发 generation；**已开发、未联调**）
- [x] TTS 试听、播放、取消与完成状态——2026-08-15/16（P4-A 试听 `tts-preview` + P4-B 自动朗读 `autoReadReply` 播放门、`audio.cancel`、onended/onerror 清态；**已开发、未联调**）
- [x] 输入法转写专用 STT Profile、按住/松开/取消与草稿插入——2026-08-16（P4-B：⌨️ pointerdown/up + 上滑取消、`dictation.final` 只写草稿（append/replace_selection）、独立 STT 下拉（backend+enabled，删除引用回退全局 STT）；**已开发、未联调**）
- [x] Backend/本机/Local Worker 模型执行位置与数据去向提示——2026-08-15/16（P4-A backend 可用态 + P4-B 后端 STT 首次操作一次性同意 D-P16；**已开发、未联调**）

### 验收门槛

- [x] 三类 Profile 可读取、测试与切换；输入法转写可独立选择兼容 STT Profile——2026-08-15/16（P4-A + P4-B `settingsStore.dictation.sttProfileId`；**已开发、未联调**）
- [x] 三类自定义 Profile 可安全创建/编辑/删除，密钥不回显——2026-08-15（P4-A；**已开发、未联调**）
- [x] 普通录音停止后只生成待发送语音输入，不自动发送——2026-08-16（P4-B；真实联调整改：等待期试听/删除/重录可用、确认发送禁用，无字幕不可发送；**已开发、未联调**）
- [x] 实时语音字幕不写入文字草稿——2026-08-16（P4-B；**已开发、未联调**）
- [x] 输入法转写只把最终文字插入草稿，不创建语音消息、不自动发送——2026-08-16（P4-B；**已开发、未联调**）
- [x] 未经确认不会把本机音频回退上传到后端——2026-08-16（P4-B consent D-P16；**已开发、未联调**）
- [x] 切换 Profile 只影响新请求，不破坏当前生成/转写/播放——2026-08-15（P4-A；**已开发、未联调**）

---

## 8. 阶段 5：Live2D

**进入条件：** 阶段 2 通过；G-01～G-05 已确认并取得合法资源。

### 任务清单

- [x] `Live2DController`、SDK Adapter 与资源 Manifest——2026-08-17（批次 A：Controller/SDK Adapter/CubismGL 已落地，装配工具产出 manifest + integrity；**已开发、未联调**）
- [x] 至少两个合法模型配置的加载、卸载与原子切换（2026-08-18 批次 B 补完：两个已装配模型可切换/加载/卸载已通过（Haru + lil/wanko，损坏注入保留原模型）；`switchModel` 返回**生效 id** + 切换竞态硬化（守卫丢弃持旧 id）经 Electron 集成（切换竞态 B7）验证）
- [x] 聊天右侧布局列、缩放、偏移与响应式折叠（不覆盖聊天）（批次 A 已含右栏 canvas + 模型下拉；批次 B 补缩放/偏移即时预览 + 持久化（Panel 手柄 + 设置子页滑块，安全钳制），布局列不覆盖消息/输入区）
- [x] idle/listening/thinking/speaking/waiting_permission 状态映射（2026-08-18 批次 B：`live2dStateSource` 编排 + 状态机收敛表；`listening/working/waiting_permission` 槽位定义完备但驱动源 null，归阶段 6）
- [x] 待机、眨眼、呼吸、鼠标跟随、动作与表情优先级（2026-08-18 批次 B：B2 眨眼/呼吸纯函数 + B3 动作/表情白名单调度（低不打断 3 级、去抖、超时、清队列、点击不打断）+ B4 无动作参数级回退 + 情绪态→表情本地映射 + 鼠标跟随/回正）
- [x] TTS 实际音频的音量口型（2026-08-18 批次 C：`computeMouthLevel` 包络纯函数 + MediaElementSource→Analyser RMS 数据源 + 口部写出通用化（对所有 ready 模型写 `ParamMouthOpenY`）+ 停止/取消归零 + `CYRENE_MOCK_MOUTH_LEVEL` env 合成包络集成链路；真实 RMS 归联调肉眼验证）
- [x] 暂停、降帧、GPU 上下文恢复与静态头像降级（2026-08-18 批次 C：`FrameBudget` 四值真实降帧 + `reset(modelId?)` GPU 丢失一次重建（成功恢复 ready + 重放 settings/CharacterState，失败 → 静态头像）+ `setVisibility` 接线非死面；画布分辨率降级与系统低电量降级显式 defer，决策记录承接）
- [x] 设置持久化与许可/资源完整性检查（`integrity.json` SHA-256）——2026-08-17（批次 A：settings `live2d` 段持久化 + `integrity.json` 全量 SHA-256 复核（fail-closed）+ licenseRef/许可记录）；2026-08-18 批次 B 扩 `Live2DSettings` 全量 10 字段 + `performanceMode` 四值归一（旧三值读回归一、老文件不 corrupt）；**已开发、未联调**

### 验收门槛

- [ ] 两个已安装模型可加载与切换；切换失败保留当前模型与聊天状态
- [ ] 角色栏作为右侧布局列展开，不覆盖消息或输入区
- [ ] 非白名单动作、参数与资源路径被拒绝
- [ ] 隐藏后停止高频渲染
- [ ] GPU/资源异常不影响聊天与权限操作

> **规划注记（2026-08-18，批次 A/B/C 已落地）：** 阶段 5 评估为 **3 批次 18 task**，批次 A（地基，2026-08-17）、批次 B（表现，2026-08-18）与批次 C（收口，2026-08-18）均已落地并全量验证（批次 C 门禁 **1599 单测（119 files）+ 97 集成（16 files）** + typecheck/lint/build + check:contract（WS 28/28 + REST 15/15）全绿，**已开发、未联调**）。资源状态：**Web SDK 5-r.5 已入仓库** `third_party/CubismSdkForWeb-5-r.5/`（commit `22993e5`，含 Core/Framework/Samples/13 shaders 与许可文件，A1 从此 vendoring）；**用户 3 模型仍在 `tmp/live2d/`，未入 git**（免费版个人开发验证，A5 装配工具注入 license note 后装入 `userData/models`，装配时生成 manifest + integrity.json）。批次 A 范围已落地：A1 SDK vendoring + CSP（asm.js 不放开 wasm）/ A2 Live2DAdapter（GL 抽象，WebGL1）/ A3 Main 模型注册表 + integrity 校验 + IPC / A4 cyrene:// live2d 专用供给分支 / A5 模型装配 dev 工具 / A6 Live2DController + live2dStore + 最小切换 + settings `live2d` 契约 / A7 Electron 集成。**批次 B 已落地**：状态机收敛表 / 待机眨眼呼吸 / 动作表情白名单调度 / 无动作参数级回退 / `live2dStateSource` 状态编排 / 情绪态→表情 / 设置子页（`Live2DSettings` 全量 10 字段 + `performanceMode` 四值）/ Panel 状态徽标缩放偏移鼠标点击回正 / `switchModel` 生效 id 竞态硬化 / Electron 集成 7 用例（spec/plan `docs/superpowers/specs|plans/2026-08-18-phase5-live2d-batchb-expression-*`）。**批次 C（收口）已落地**：TTS 口型数据源（C1）/ 性能降级 + GPU 重建 + 可见性收口（C2）/ 后端 `live2d.directive` 扁平冻结契约四件套 + 七值 + 建议强度仲裁（C3）/ 防御加固收口（M1-M4/F2/F3/restore 分叉，批次 A F2-F4 关单）/ 文档 + 决策记录 + 联调清单（spec/plan `docs/superpowers/specs|plans/2026-08-18-phase5-live2d-batchc-closure-*`；决策 `docs/review/2026-08-18-阶段5批次C-决策记录.md`；联调清单 `docs/review/2026-08-18-阶段5批次C-联调清单.md`）。**真实 Windows Electron（REAL）联调**为代码批次后的验收方，由开发者事后凭联调清单执行（C1 口型肉眼 / C2 四值降帧实测 + GPU-lost 重建 / C3 真实 emotion→情绪→表情 + 未知帧忽略不崩 + 指令防御路径 + 归真机 deferred 项 + 自动化门禁复跑），通过后三态升「已真实联调」。已拍板：管理范围 P0 原样（doc 05，无导入/卸载 UI）；模型免费版个人开发验证；模型放 `userData/models` + Main 校验 + cyrene:// 供给。完整评估与决策点见 spec/plan + `docs/review/2026-08-18-阶段5批次C-决策记录.md`（主会话落文）与 `docs/review/2026-08-18-阶段5批次B-决策记录.md`、`docs/review/2026-08-17-阶段5批次A-决策记录.md`。

---

## 9. 阶段 6：工具、权限与 Desktop P0 能力

**进入条件：** 阶段 1 与阶段 2 通过；F-01～F-10 已确认。

> **决策注记（2026-08-19 方案 B 定案；2026-08-20 后端已落地 + 前端批次 A/B 已落地）：** 工具双轨统筹决策与前后端更新点见 `docs/review/2026-08-19-阶段6-工具双轨统筹决策记录.md`（后端镜像在 elysia-agent；**后端 B-6-01~09 已落地并验证，本地 HEAD `03a6e882`，尚未 push**——push 后前端 pull 再动 `check:contract` manifest）。核心口径：wire 双轨（Desktop `tool.request/tool.status`；Backend 新增 `tool.started/tool.completed`）→ 前端领域单轨 `ToolCallRecord`；权威键 = LLM `tool_call_id`（`sourceCallId`）；实时 `toolStore` 易失、归档（assistant `tool_calls` + role=tool 结果）为历史/回放持久权威；`generation.completed` 不加 `tool_calls`、`finishReason` 不承载工具语义。旧后端 `action` 帧按「已知忽略」兼容帧过渡，不作工具状态源。**F-6 批次 A（raw/领域四件套 + `ToolCallRecord` + 归档配对 + mock/测试）已于 2026-08-20 落地并全量验证（三态=已开发、未联调）**，见 `docs/review/2026-08-20-阶段6批次A-决策记录.md`；**F-6 批次 B（Main 工具注册表/服务/四执行器/状态发送/审计 + Preload IPC 面 + toolStore/卡片/权限窗/聊天接线/Live2D `waiting_permission` + mock 改接 + 集成测试）已于 2026-08-20 落地并全量验证（三态=已开发、未联调）**——F-06/F-07/F-09/F-10 预检拍板落地，见 `docs/review/2026-08-20-阶段6批次B-决策记录.md`；**批次 C 前置**：真实 Windows Electron 联调（三态升「已真实联调」）+ allow_scoped 授权 UI/有效期 + 设置页授权管理/命令模板空态（F-08 待确认）+ `GET /api/tools/calls/{callId}` 状态查询 + action 移除评估 + 跨页/跨会话配对复核。

> **批次 C 状态注记（2026-08-21）**：**F-6 批次 C（allow_scoped 目录授权 + 设置页「安全与权限」子页（授权管理/审批历史/命令模板空态）+ settings.tools grants 子树 + L-1~L-8 收口 + GET /api/tools/calls/{callId} real/mock + 装配顺序 V-4）已落地并全量验证（三态=已开发、未联调）**；**F-08 关闭**（命令模板空态确认，受控命令不进入 Demo）；L-5/M-1/M-3 留档（paramHash 浮点评估无代码改动 / M-1 确认 / M-3 否决）+ 新文件写 TOCTOU 守卫；评估结论记录（action 保留至阶段 8 / 跨页配对不适用（历史基于 audit 事件）/ M-8 保留 in-Renderer / renderer 可撤销 grant 接受 F-8）；决策记录 `docs/review/2026-08-20-阶段6批次C-决策记录.md`；**真实 Windows Electron 联调由开发者批次后执行，联调清单见 `docs/review/2026-08-21-阶段6-工具与权限-真实联调清单.md`**（通过后三态升「已真实联调」）。

### 任务清单

- [x] raw/领域四件套：`tool.request/tool.started/tool.completed`（Server→Client）与 `tool.status`（Client→Server）raw schema + FrameMapper + 领域事件 + zod 镜像（F-6-01~04；`action` 过渡期兼容帧）【批次 A 已落地】
- [x] Tool Store、工具卡片、统一状态机与公开错误（`ToolCallRecord` 按 `sourceCallId` 三来路归一化）（F-6-15/16/17，批次 B 已落地）
- [x] Backend / Desktop / Local Worker Runtime 区分（Backend 只展示；Desktop 本地状态机裁决终态）（F-6-18，批次 B 已落地——backend 卡片零按钮只读、desktop 卡片 awaiting_permission 才出权限入口）
- [x] 归档配对：`RestMapper` 解析 assistant `tool_calls` + 按 `tool_call_id` 配对 role=tool 结果，回放/历史重建卡片（F-6-19~21；批次 A 已落地；批次 C 复核跨页/跨会话配对）【批次 A 已落地】
- [x] Desktop 静态注册表、版本、Schema 与本地风险重算（F-6-07，批次 B 已落地——`tool-registry.ts` 四工具 + 本地 risk 常量 + inputSchema strict）
- [x] `callId` 幂等、取消、超时与结果重传（`tool.status` 安全元数据仅由 Main 缓存组装）（F-6-08/10，批次 B 已落地——tool-service 13 步决策链 + tool-status-sender + paramHash canonical 校验 + 重连重发终态）
- [x] 权限窗口、沙盒、路径/域名黑名单、范围授权与撤销（F-6-08/17，批次 B 已落地——CyToolApproval 四问 + `PATH_BLACKLIST_DEFAULTS` 仅黑名单零预授权；**范围授权与撤销归批次 C**）
- [x] 审批历史、已授权命令模板/目录与空状态（F-6-17/20，批次 C 已落地——设置页「安全与权限」CySecurityPane 三分区：授权管理（grants 列表+撤销）/审批历史（audit 回读过滤搜索跳转撤销）/命令模板空态；**F-08 关闭**，2026-08-21）
- [x] allow_scoped 目录授权（D6C-01~06：`PermissionGrant` 契约含 backendIdentity + settings.tools grants 子树 + GrantStore（matches 段边界/身份匹配/幂等/装载期校验）+ 决策链 step 8 grant 匹配（优先于豁免、黑名单优先、capture 恒确认、写命中只读 Diff）+ 「允许指定目录」创建流（TTL 白名单双校验/pickDirectory 注入/断连不创建）+ 撤销/过期惰性清除）【批次 C 已落地；2026-08-21】
- [x] 授权管理 IPC 四通道（`tool:grant-directory`/`tool:grants`/`tool:grant-revoke`/`tool:history`）zod 双端 + `isTrustedSender`（D6C-12）【批次 C 已落地；2026-08-21】
- [x] L-1~L-8 批次 B 复核项收口（records 驱逐/init 水合先水合后订阅/run 入口守卫/`tool.request` try-catch/diff 行截断/confirmUpload 顺序/decide.catch）+ M-1 确认/M-3 否决 + 新文件写 TOCTOU 守卫 + GET /api/tools/calls/{callId} real/mock + reconnect queryStatus 三分支 + 装配顺序 V-4【批次 C 已落地；2026-08-21】
- [x] `desktop.file.select` 与受控资源句柄（F-6-09，批次 B 已落地——selected-set TTL 豁免替代受控句柄语义，B12）
- [x] `desktop.file.read` 的类型、大小、路径与内容返回（F-6-09，批次 B 已落地——2 MiB 上限/64 KiB 内联/附件上传/二进制拒/TOCTOU）
- [x] `desktop.file.write` 的 Diff、写前哈希、原子替换与冲突保护（F-6-09，批次 B 已落地——jsdiff 行级 Diff/写前哈希 `FILE_CONFLICT`/原子替换/格式保留）
- [x] `desktop.screen.capture` 的系统选择、预览、上传确认与清理（F-6-09/10，批次 B 已落地——Win+X11 desktopCapturer/Wayland 降级/子状态机钉死/两步确认）
- [x] 可选 `desktop.command.run` 仅在范围明确确认后注册（当前不注册）（**确认全阶段不注册**，F-07 拍板）

### 验收门槛

- [ ] Backend 工具只展示，不会在客户端误执行
- [ ] Desktop 工具只通过 Main 与本地注册表执行
- [ ] 四个 Desktop P0 工具 ID 完成真实后端闭环（Mock 阶段标“已开发、未联调”）
- [ ] 未注册、未知 Runtime、版本不兼容与非法参数均安全失败
- [ ] 黑名单优先于沙盒与历史授权
- [ ] 相同 `callId` 不重复弹窗或产生副作用
- [ ] 用户拒绝/关闭/超时后不执行；文件冲突不覆盖；截图不静默采集或上传
- [ ] `tool.request.sourceCallId` 必填且与 `tool.started/completed.callId`、归档 `tool_call_id` 同值；缺 `sourceCallId` 或回传安全元数据不一致按协议错误拒绝
- [ ] 命令执行未确认时不注册；启用时也不能接收任意 Shell 字符串
- [ ] 审计与日志不含完整敏感内容

---

## 10. 阶段 7：安全、稳定性与性能收敛

**进入条件：** 阶段 3～6 的 Demo 范围功能完成。

### 任务清单

- [ ] Markdown/XSS、危险链接、CSP、导航与媒体来源测试
- [ ] IPC 攻击面、超大输入与来源窗口校验
- [ ] 路径穿越、符号链接、重放与授权后参数变化测试
- [ ] Token、模型密钥、聊天正文、Inner Voice、录音与本地数据泄漏扫描
- [ ] 直接语音字幕与文字草稿隔离测试
- [ ] 网络中断、Renderer 崩溃、缓存损坏与 GPU 上下文恢复
- [ ] 长会话、长流式、历史资源列表与 Live2D 性能测试
- [ ] 日志轮转、缓存上限、临时附件与录音清理
- [ ] 集中修复 Blocker、Critical 与主要回归问题

### 验收门槛

- [ ] Blocker / Critical 为 0；安全发布清单通过
- [ ] 200 条混合消息、100 个多分段回复、500 项历史资源操作正常
- [ ] 长时间运行无明显持续内存增长
- [ ] Live2D 关闭后 CPU/GPU 使用明显下降
- [ ] 日志与诊断导出通过敏感信息扫描
- [ ] 主链路异常可恢复或安全失败

---

## 11. 阶段 8：打包、跨平台与 Demo 验收

**进入条件：** 阶段 7 通过；H-03～H-09 发布相关项已确认。

### 任务清单

- [ ] Windows 安装包与 Ubuntu 主安装产物（Electron Forge）
- [ ] 安装、首次启动、升级、卸载与重装测试
- [ ] 产物秘密、开发配置、Source Map 与未授权资源扫描
- [ ] Windows/Ubuntu 实机链路与 Wayland 范围测试
- [ ] 完整 Demo 演示脚本
- [ ] 版本、提交、依赖、协议与资源清单
- [ ] 发布说明、校验和、已知问题与回滚/重装方案

### 验收门槛

- [ ] Windows 主验收环境完整通过
- [ ] Ubuntu 目标环境至少完成一次全链路
- [ ] 生产包默认关闭开发者模式与 DevTools，远程调试端口始终关闭
- [ ] 安装包不包含测试密钥、敏感事件样例或未授权模型
- [ ] Demo 脚本连续执行两次结果一致
- [ ] 版本、提交、协议与资源哈希可追溯
- [ ] 已知问题与回滚/重装方式已记录

---

## 12. 全阶段统一完成定义（Definition of Done）

任何任务只有在同时满足以下条件时才可标记完成：

- 代码实现并通过类型检查与格式检查；
- 外部数据具有运行时 Schema；
- 正常、失败、取消、拒绝与超时路径按适用范围处理；
- 核心纯逻辑具有单元测试；
- 跨 Main/Preload/Renderer 或 BackendAdapter 的功能具有集成测试；
- 用户可见主流程具有 E2E 或人工验收记录；
- 不包含明文凭据、未脱敏日志或未授权资源；
- 相关文档与协议对齐表同步更新；
- 已知限制与剩余风险被显式记录；
- 真实后端未联调时，状态只能标记为“已开发、未联调”（三态：**已开发** / **已验证** / **已真实联调**，见 README「真实模式联调」小节；阶段 0 标「带已知豁免提前开发」）。

---

## 13. 变更记录

| 日期 | 变更 | 状态 |
|---|---|---|
| 2026-08-06 | 创建本文；标记阶段 0 已落地项（仓库、环境、README）与待办项 | 进行中 |
| 2026-08-08 | 阶段 0 工程推进：`apps/desktop/` 脚手架、领域契约、BackendAdapter 骨架 + Mock、设计 token 与四区 UI 壳、Vitest 单测与 CI 全部落地并通过验证；标注“已开发、未联调” | 进行中 |
| 2026-08-08 | 依据后端交接包 frontend-handoff-v2 批次 7 填写 doc 02 §19 对齐表 + §19.1 字段差异桥接表；勾选阶段 0 对齐表相关项 | 进行中 |
| 2026-08-08 | §2 输入清单逐行标注：契约已确认项标 `[~]`（B-02~B-06/B-08、C-01~C-09、E-01~E-06/E-08、F-01~F-05、G-04），A-01/A-04 勾 `[x]`；仍缺项列表补全；头部状态更新 | 进行中 |
| 2026-08-08 | 深读后端批次 0-8c 全部进度/审计文档后复核：**D-01~D-08、F-08、H-03/H-06 升级为 `[~]`**（后端批次 3/7 契约已覆盖）；剩余 `[ ]` 明确标注性质——前端本地授权/沙盒/审计设计（F-06 后端 security §3.2 明确属 Electron 职责）与外部资源/产品决策（G-01/G-02 Live2D、H-01/H-04 平台/签名） | 进行中 |
| 2026-08-08 | **阶段 1 前置决策拍板**（§4.0）：App 身份 Cyrene/com.cyrene.desktop、沙盒 `userData/sandbox`、开发者模式不进 P0 恒关、凭据 safeStorage 不可用即拒存、日志 5MB×3/审计 30 天/诊断导出进 P0；F-06/H-09 升级 `[~]` | 进行中 |
| 2026-08-09 | 阶段 1 第一块落地：9 子目录、installAppIdentity + userData 七目录、IPC 骨架（app:get-info） | 已开发、未联调 |
| 2026-08-09 | **GUI 冒烟自动验证通过**（Playwright `_electron` + vision MCP）：Ubuntu(Wayland) 启动构建产物，七目录 0700、`getAppInfo`→`{Cyrene,0.1.0,linux}`、四栏 UI 渲染正常、普通浏览器 `desktopApi` undefined（信任边界）；验收门槛 2 项升 `[~]` | 已开发、未联调 |
| 2026-08-09 | **阶段 1 块 A（安全加载与环境基线）落地并全量验证**：`cyrene://` 受限协议替代 `file://`、严格 CSP（响应头 AND 保留 meta、`frame-src 'none'`）、dev/test/prod 环境（`__APP_MODE__` 烘焙）与生产安全默认（DevTools 恒关 + 远程调试门）、electron-builder 未分发包 + `verify:artifact`（静态 + 冒烟 16/17 项，负路径验证调试门）；勾选 §4 任务 ③④ 与验收门槛「生产恒关/远程调试恒关」 | 进行中 |
| 2026-08-10 | **阶段 1 块 B（主进程受信服务）落地并全量验证**：凭据存储（`safeStorage` 封装 + 版本化 `config/credentials.json` 0600/原子写/每 key 加密块 + `credentialStatus` 4 值 IPC + key 白名单单一来源）+ 日志/审计（手写 JSONL logger 无 msg 参数/落盘双净化、append-only 审计按日 + 30 天清理、共享 file-writer rotate 5MB×3）+ 装配（before-quit allowQuit 防挂死 flush、生命周期日志）；182 单测全绿 + typecheck/lint/build 通过；勾选验收门槛「Token/密钥只显示状态」；诊断导出措辞同步为「阶段 7 安全收敛（Demo P0 范围）」（B-1） | 已开发、未联调 |
| 2026-08-10 | **阶段 1 块 C（IPC/协议安全集成测试）落地**：Playwright _electron 集成套件（协议 handler F1 403/404/逃逸/200+CSP、IPC API 面/超大输入/来源校验、外部链接受控、普通浏览器信任边界）+ test:integration(--mode test 构建) + CI xvfb-run | 已开发、未联调 |
| 2026-08-11 | **阶段 2 块 A（领域契约修复 + raw wire 层）落地**：领域事件扩展（`GenerationSegmentStartedEvent`、`SegmentCompleted.kind/content`、Token 结构 `usage.rounds`/`ConversationTokenUsage`、`ProtocolWarning`）+ raw-types/raw-schemas（判别 `type` + strict，zod 4.4.3 双参 record）+ frame-mapper（status 过滤/fail-closed/告警）+ StreamAccumulator 权威 content 规则（docs/18 §4.3 七条）+ fixture 分离（`domain/` 领域 + `wire-v2/` raw wire + manifest 锚定 `beeba577`）+ wire-fixtures 两层校验；231 单测全绿 + typecheck/lint/build；spec/plan 见 superpowers 目录 | 已开发、未联调 |
| 2026-08-11 | **阶段 2 块 B（RealBackend REST/WS v2 Adapter）落地**：`ws` 依赖 + REST wire 层（rest-types/rest-schemas 混合命名 + strict）+ rest-mapper（`Message.tool?` 元数据、`_id` cursor 分页、回放项 mood→emotion）+ raw 层扩展 `user_message.ack`/`error` + `BackendAdapter` 接口扩展（`getConversationMessages`/`activateConversation`/`renameConversation`）+ `RealBackend`（握手 header 精确/`server_info` 版本 fail-closed/session 回放缓冲/ack 关联 15s 超时/重连退避 + unexpected-response fail-fast/REST 会话·历史·激活 + Bearer + 错误映射）；告警码收编 `ProtocolWarningCode`；265 单测全绿 + typecheck/lint/build；spec/plan 见 superpowers 目录 | 已开发、未联调 |
| 2026-08-11 | **阶段 2 块 C（Store + IPC 事件推送 + 聊天 UI 纵向闭环）落地**：`chat-service` + `chat:event/state/replay` 推送通道 + chat 命令（IpcResult 信封 + schema）+ `desktopApi` chat 面（unwrap + 订阅守卫 + 取消函数）+ Pinia 三 store（connection/conversation/message，messageStore 经 `StreamAccumulator` 流式应用 + 乐观发送 + 断线 interrupted）+ UI 动态化（`CyMarkdown`（marked+消毒 entity 加固）/`CyMessageBubble` 双通道折叠/chips/`CyChatInput` IME 守卫/`CyChatView` 空态·断线横幅·连接控件/`CyConversationList` 列表操作）；对 2B 加性修改（`ConnectionState` 迁 shared、`getConnectionState`、`onConnectionStateChange`、`MessageStatus.completing`）；312 单测全绿 + typecheck/lint/build；「发送 → 流式 → 渲染」链路打通（Mock 驱动）；spec/plan 见 superpowers 目录 | 已开发、未联调 |
| 2026-08-11 | **阶段 2 批次收尾（最终 review 修复闭环 + 批次报告）**：2B F1-F7、2C P1-1~3+P2 全部修复；315 单测 + typecheck/lint/build 全绿；批次最终报告见 `docs/superpowers/2026-08-11-phase2-batch-final-report.md`；阶段 2 三块全部完成，下一步阶段 3（或先 B-01 联调） | 已开发、未联调 |
| 2026-08-11 | **CI 首次跑修复（阶段 2 后第一推）**：`.github/workflows/ci.yml` 集成测试全红，两个独立根因——① electron 43 无 postinstall + 集成测试 helper 硬编码 `dist` 路径（不走 `require('electron')` 懒下载）→ CI 全新环境二进制缺失（`spawn electron ENOENT`），修复 `ensure:electron` 脚本 + CI install 后步骤；② `sandbox: true` preload 被 electron-vite 外部化 zod → 产物 `require("zod")` 沙箱运行时报错 → contextBridge 中断 `window.desktopApi` undefined，修复 `externalizeDepsPlugin({ exclude: ['zod'] })`；本地 18 集成测试全绿复验；坑与排查要点见 doc 17 §4/§10 P-12/P-13/§16 | 已开发、未联调 |
| 2026-08-11 | **CI 修复 v2（ensure 脚本布局 + 缓存 + job 拆分）**：① `ensure:electron` 由 `node node_modules/electron/install.js` 改为 `node -e "require('electron')"`——pnpm hoisted 干净 install 不创建 workspace 子包 `node_modules`（本地该目录是历史残留），相对路径脚本在 CI 报 `MODULE_NOT_FOUND`（P-14）；② CI 拆 3 个独立 job（check=typecheck+lint / unit / integration），integration 加 `actions/cache` 缓存 `~/.cache/electron`（key 锚定 `pnpm-lock.yaml`）；本地复验 18 集成 + 315 单测 + typecheck + lint 全绿 | 已开发、未联调 |
| 2026-08-11 | **CI 修复 v3（helper electron 路径定位）**：v2 后 ensure 用对路径（`require('electron')` 解析到根 hoisted 区下载成功），但 launch 仍 ENOENT——测试 helper（`tests/integration/helpers/app.ts`）硬编码 `join(ROOT,'node_modules/electron/dist/…')`，干净布局下 `apps/desktop/node_modules` 整个不存在；改为 `require.resolve('electron')` + `dirname` 定位包再拼 `dist/<exe>`；本地模拟 CI 布局（mv 子包 node_modules）18 集成全绿复验 | 已开发、未联调 |
| 2026-08-12 | **阶段 2 真实联调整改·批次 A（连接凭据安全 / 真实模式装配 / rejected ACK）落地**：FE-P0-01 Main 规范化 Endpoint + Token-Origin 绑定（`connection-config` 纯逻辑 + 注入 CredentialStore 端口；URL 规范化 https/回环 http/拒绝 userinfo·query·fragment/path 前缀；origin 变化自动清 token 绑定；`connect` 无参三步校验）+ FE-P1-02 装配策略（`resolveBackendMode`：打包恒 Real、未打包默认 Real + `CYRENE_BACKEND=mock` 显式 Mock）+ `CyConnectionPanel` 连接设置 UI（REAL/MOCK 标识、Endpoint/Token 设置、token 密码框提交清空）+ FE-P1-01 rejected ACK 即时结构化（`RawUserAckSchema` superRefine + `handleAck` `BACKEND_REJECTED`/backendCode/retryable + 错误 message 前缀跨桥 + `parsePublicError` 反解）；集成测试（白名单 18→21 键、凭据先设 endpoint、attacker 不泄漏 token、`getRuntimeInfo`、`launchApp` 固定 mock）；**360 单测 + 20 集成 + typecheck/lint/build 全绿**；仍标「已开发、未联调」；spec/plan 见 `docs/superpowers/specs|plans/2026-08-11-phase2-realconn-preparation-*` | 已开发、未联调 |
| 2026-08-12 | **阶段 2 真实联调整改·批次 B（真实连接编排：连接后会话初始化 / 会话守卫 / 错误链 / 超时门控）落地**：FE-P1-03 连接后会话初始化（renderer 编排 `onConnected` 幂等 + 首次/重连分支 + `pendingReplay` 纯缓冲 + `onActiveConversationAppeared` 活动会话晚到补激活 + `ready` 就绪门控）+ FE-P1-04 conversation/epoch 守卫（`generationByConversation` 归属表（仅 started 带 conversationId、中间事件查表）+ `activate` epoch 大者胜 + `migrateKey` 竞态守卫 + 断线清理 local-* 乐观消息）+ FE-P1-05 错误链（`onProtocolWarning`→脱敏日志（固定 code+sanitize+mode+build）+ `onError`→logger+`chat:error` 推送 + `connectionStore.error` 结构化展示（连接失败保持 error 态）+ 429 走重连退避不新增领域码）+ FE-P2-01 超时/门控（握手 10s/REST 10s（可注入）+ disconnect abort→`NOT_CONNECTED` + `setEndpoint` 联动断开 + `canSend`/会话管理 `connected&&ready` 门控 + `busy` 防重复）；门控 computed 为组件逻辑无单测，验收以集成断言/人工兜底（M5）；已知限制：重连 reconcile 竞态（I4，`activeConversationId` 晚于 safeList 时可跳过 reconcile，低概率）；**399 单测 + 22 集成 + typecheck/lint/build 全绿**；**第三方验收 4/4 达成**；仍标「已开发、未联调」；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase2-realconn-batchB-*` | 已开发、未联调 |
| 2026-08-12 | **阶段 2 真实联调整改·批次 C（边界与联调门禁：IPC/replay 运行时 Schema / 夹具跨仓库门禁 / 文档漂移同步）落地**：FE-P2-02 IPC 成功响应与 replay payload 运行时 Schema（共享领域响应 Schema 镜像契约、废弃 channels 拷贝收敛 + executor 响应校验失败 → `SCHEMA_VALIDATION_FAILED` + 字段摘要 + 日志（C2）+ Main handler 传 responseSchema + Preload `unwrap(res, schema)` 双层防御 + `isReplayPayload` 纯守卫 + `filterReplayMessages` 单条丢弃告警（E2 用户拍板：不整批拒绝））+ FE-P2-03 夹具跨仓库门禁（新增 7 组场景 jsonl + replay 消息交叉校验（I5）+ manifest schemaHash/verified/scenario（F4：新增 7 组 `verified:false`、既有 4 组保持 beeba577）+ `rawSchemasFingerprint()`/`RAW_FRAME_TYPES` union `_def` 推导（I4/I6）+ 跨仓库契约脚本 `check-backend-contract.mjs`（`frontend_contract` 挂载时 frame type 覆盖比对、<3 下限报错、未挂载 exit 0））+ FE-P2-04 文档漂移同步（CLAUDE.md/README/docs16，G2 用户拍板）；决策 E2/F3/F1/G2 用户拍板 + E1/F4 推荐；已知限制：跨仓库脚本依赖后端目录挂载（CI/他人机器未挂载自动跳过）、replay 单条非法逐条丢弃 + 告警（不整批拒绝）；**433 单测 + 22 集成 + typecheck/lint/build 全绿**；**第三方验收 3/3 达成**；仍标「已开发、未联调」；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase2-realconn-batchC-*` | 已开发、未联调 |
| 2026-08-12 | **阶段 0/1 整改·批次 A（跨平台文件与退出地基）落地并全量验证**：FE-S1-P0-01 Windows 安全文件首建/ENOENT 保留（safe-open 重构为可注入 `SafeOpenPlatform` posix/windows，`existing+ENOENT` 原样抛原始 errno，`CredentialStore.readFile` 据此判「文件不存在」）+ FE-S1-P1-02 非普通文件全拒（FIFO/socket/目录/device，POSIX 打开追加 `O_NONBLOCK` 防阻塞、统一 `fd.stat().isFile()` 不变量、create 冲突 fallback 同规则）+ FE-S1-P2-02 `EMPTY_FILE` 工厂化（`createEmptyFile()` 每次全新对象，多 key 损坏重建互不污染）+ FE-S1-P1-03 CredentialStore `close()`/drain（`CREDENTIAL_STORE_CLOSED`、等待在途落盘、清明文 cache）+ shutdown 重构（`ShutdownStep[]` 有序 凭据→adapter→diagnostics、`SHUTDOWN_TIMEOUT_MS`、超时标记经同步 audit 落盘 + `createFatalShutdown` 统一 fatal 路径）+ main 装配（onTimeout 同步审计 + fatal 接线）；决策 A1 用户拍板（真实 Windows CI 归批次 C）+ A2 推荐；**460 单测（42 files）+ 22 集成（5 files）+ typecheck/lint/build + check:contract(11/11) 全绿**；仍标「已开发、未联调」；**Windows 联调仍阻塞**（P0-01 已修，真 Windows 运行证据与 Windows CI 归阶段 0/1 整改·批次 C）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchA-*` | 已开发、未联调 |
| 2026-08-12 | **阶段 0/1 整改·批次 B（Renderer 信任边界）落地并全量验证**：FE-S1-P0-02 dev Renderer URL 回环白名单（`ELECTRON_RENDERER_URL` 只接受回环 localhost/127.0.0.0/8/[::1] + `CYRENE_DEV_RENDERER_ORIGINS` 附加 allowlist http origin（逗号分隔、非法条目跳过）；非法 URL **启动报错退出**（fatal + return）；「受信 Renderer URL」收敛为 Main 单一策略函数 `trusted-renderer-origin.ts`（isLoopbackHostname 四段点分收紧 / normalizeOrigin / isAppRendererUrl），窗口加载/导航/IPC 来源三处共用）+ 开发 CSP（`buildDevCsp` electron-free：`frame-ancestors 'none'` 经 Vite 中间件注入响应头（meta 不支持该指令）+ meta 收紧 `frame-src/form-action 'none'` + `connect-src` 去裸 ws:/wss: 只放行回环/allowlist origin ws）+ FE-S1-P2-01 IPC 来源纵深（`isTrustedSenderFor` 可测纯函数：win null/destroyed → false、sender 匹配 + `senderFrame===mainFrame` + 发送 frame 当前 URL 受信（cyrene://renderer 或受信 dev http））；决策 B1/B2 用户拍板 + B3 推荐；**483 单测（45 files）+ 22 集成（5 files）+ typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿**；**P0-02 关闭**（首次真实联调前最后 P0）；仍标「已开发、未联调」（dev 回环启动冒烟 + HMR 放行 headless 不可做，记为 B-01 联调首日或本机冒烟验证项）；**Windows 联调仍阻塞**（真 Windows 运行证据与 Windows CI 归阶段 0/1 整改·批次 C）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchB-*` | 已开发、未联调 |
| 2026-08-12 | **阶段 0/1 整改·批次 C（审计与持续门禁）落地并全量验证**：FE-S1-P1-01 审计接线（凭据生命周期 `credential:set/clear/status-change` + 连接生命周期 `connection:connect/disconnect/error` 接入 append-only audit；fail-open 语义 C1——审计失败不改变操作结果；真实应用装配集成测试：经 IPC set/clear 后 audit/ JSONL 出现预期行）+ FE-S1-P1-04 CI 持续门禁（新增 `artifact` job：clean + package + `verify:artifact --smoke` + SHA 证据；新增 `windows` job：构建级 typecheck/lint/unit/build，C3 不启动 Electron；POSIX 专属单测加平台守卫）；决策 C1（fail-open）/C2（连接生命周期审计）/C3（Windows 构建级）均为用户拍板；**493 单测（45 files）+ 23 集成（6 files）+ typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿**；仍标「已开发、未联调」（真实后端联调未进行）；CI 两个新 job 需 push 触发 GHA 验证（本机沙箱无 GHA）；**Windows 联调仍阻塞**（真 Windows 上启动 Electron + Token 冒烟仍留 B-01/后续，C3 明确构建级）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchC-*` | 已开发、未联调 |
| 2026-08-13 | **阶段 0/1 整改·批次 D（阶段 0 真实性）落地并全量验证**：FE-S0-P1-01 首次联调口径冻结（Linux 本机文本聊天最小闭环 13 项用例（启动 / 设置 Token / 连接 / 列会话 / 激活新建 / 发送 / ACK / 双通道流式 / completed / 取消 / 断线重连 / 错误展示 / 日志定位）+ 三态状态（已开发/已验证/已真实联调）+ 阶段 0「带已知豁免提前开发」+ Windows「阶段 1 未通过项」+ 外部依赖清单 + README 真实联调启动说明 + CI 版本同源声明）+ FE-S0-P1-03 MockBackend 隔离与真实性（每实例深拷贝会话状态 + 一致 CRUD + 每次 send 注入唯一 ID + 可注入 clock/ID factory + 单 generation 取消 + 并发/多实例测试）+ FE-S0-P2-01 Node engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出 + FE-S0-P2-02 占位命令（`test:e2e`/`make`）非零退出 + credentials/diagnostics 子 README 真实化 + 主 README preload 修正；决策 D1/D2/D3/D4 均为用户拍板；**501 单测（46 files）+ 23 集成（6 files）+ typecheck/lint/build + check:contract(11/11) + package + verify:artifact --smoke 全绿**；仍标「已开发、未联调」；真实后端 B-01 联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板为唯一剩余外部依赖；spec/plan 见 `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchD-*` | 已开发、未联调 |
| 2026-08-13 | **首次真实联调整改 T1+T2（state/typing 兼容帧 + 单写者口径）落地**：FE-INT-P1-01 后端合法 `state`/`typing` 帧建模为「已知但有意忽略的兼容帧」（`RawState`/`RawTyping` 入 `RawFrame` + strict schema（未知键仍拒、`state` 无 min(1) 空串契约合法）+ `handleFrame` 显式 no-op（不落 mapper）+ check:contract 白名单 11→13 + 新 `state-typing` fixture 组（handoff trace 真实帧，verified:false）+ 11 份既有 manifest schemaHash 同步；未知帧仍 fail-closed `RAW_FRAME_INVALID`）+ FE-INT-RISK-01 单写者约束文档化（README/CLAUDE/docs16：单活动桌面客户端/单写者、多客户端同会话不支持、含否决理由与「不纳入首次单客户端 B-01 阻断门禁」）+ `message_id=""` 后端阻断（前端非空校验保持，四种不可接受改法全部拒绝）；**510+ 单测（46 files）+ 23 集成 + typecheck/lint/build + check:contract(13/13) 全绿**；仍标「已开发、未联调」（真实后端复跑诊断项为 B-01 验证项）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-13-realint-fix-*` | 已开发、未联调 |
| 2026-08-14 | **三次真实联调（P0 修复 + B-01 封口）落地并全量验证**：真实 ws 连接显式 `perMessageDeflate:false` 关闭压缩，修复 aiohttp 空闲压缩连接首个客户端业务帧 RSV 保留位错误断连（阻断复现：Ubuntu 探针静默 75s → 默认 close 1002 / 关压缩 close 1000）+ 握手回归（断言不发送 `Sec-WebSocket-Extensions`，`wsFactory` 测试注入契约不变）+ Windows 真机复验（前端 `6b27e2e` + 后端 `73ac7a3`：静默 76s 后 UI 发文本 ACK/流式/completed/REST 全通、76s 后 reload 恢复连接/活动会话/13 条历史、取消 `GENERATION_CANCELLED`→interrupted 保留 partial、0 断连 0 RSV 错误、Pinia/DOM 19/19 唯一键、droppedEvents=0）；**527 单测（47 files）+ 23 集成（6 files）+ typecheck/lint/build + check:contract(13/13) + package + verify:artifact --smoke 全绿**；**B-01 已真实联调通过（十项复跑全绿）**，阶段 2 主链转「已真实联调」，阶段 3 可升为主线；证据见 `docs/review/2026-08-14-Windows-Electron-第三次真实联调前端阻断.md` | 已真实联调 |
| 2026-08-14 | **阶段 3 G1+G2（布局响应式 + 历史聊天体验）落地并全量验证**：G1 四区布局（`renderer/src/layout/` 常量 + effective-layout 断点 1200/736/520/320、会话栏 260 可折叠、Live2D 右栏默认显示 340 可调（[300,420]）、最小窗口 1100×700、布局记忆 Renderer localStorage `cyrene.layout.v1`）+ G2 历史聊天体验（CyMessageList 自研虚拟列表 + 锚点捕获/恢复/补偿 + 回到底部、draftStore 草稿 50 会话×100KB 超限提示、离线缓存最近 20 会话、草稿/滚动锚点归 Main 持久化（persistSession/hydratePersistence/cacheMessages IPC + SessionStore）、代码块仅复制按钮 + 基础样式不引高亮库）；**已开发、未联调** | 已开发、未联调 |
| 2026-08-14 | **阶段 3 G3+G4（附件多媒体 + 历史查看器/表情/无障碍）落地并全量验证**：G3 附件内嵌 Message + ContentPart 映射、通用媒体代理 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`（attachment 签名 + Range/206、sticker 静态白名单 + MIME/1MB 上限）、CyAttachmentQueue/CyAttachmentMedia/CyDropOverlay、原生预览 + 图标卡、拖拽不自动上传发送；G4 CyHistoryViewer/CyHistoryResultItem 全窗覆盖式查看器（关键词/日期/分类/不透明游标分页/来源跳转与高亮）+ CyEmojiPicker/CyStickerPanel（只内置 `st_` 表情包 + stickerId 发送）+ IME/焦点/键盘无障碍 + historyViewerStore + `utils/media.ts`/`sticker-url.ts`/`history-date.ts`；搜索项文本展示（SearchMessageItem 无 kind/url，P0-1 缩略图缺口待后端确认）；现代 QQ/微信风格；**已开发、未联调** | 已开发、未联调 |
| 2026-08-14 | **阶段 3 四组全量验证通过**：894 单测（80 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract(13/13) + package + verify:artifact --smoke 全绿；**阶段 3 已落地**（新功能 Mock 驱动标「已开发、未联调」，阶段 2 主链保持「已真实联调」）；下一块阶段 4/5（模型服务与语音 / Live2D）可升为主线 | 阶段 3 已落地（新功能已开发、未联调） |
| 2026-08-14 | **阶段 3 四组 commit 最终 review 修复闭环**：G1（App.vue rAF 不丢宽、CyHistoryViewer 遮罩对齐 NAV 60）+ G2（SessionStore.hydrate 降级自引用 bug、cacheStore 内存快照同步、loadPage 缓存 updatedAt 真实时间、draft 淘汰内存清理）+ G3（附件逐项校验、占位重试恢复、上传复验对齐、发送失败保留、取消即移除等 2P1+8P2）+ G4（跨会话跳转定位、分页续接、image_video 双流游标、epoch 守卫、纯贴图发送、自然日分组等 5P1+4P2）；文档 commit 合并为每组一个 spec + 一个 plan（rebase，树一致）；**复跑 894 单测（80 files）+ 39 集成（10 files）全绿** | 阶段 3 已落地（新功能已开发、未联调） |
| 2026-08-15 | **阶段 3 真实联调前整改（5 项）落地并全量验证**：P0-01 搜索日期按后端自然日契约发送（`date_from/date_to=YYYY-MM-DD`，不再预转 UTC ISO）+ `INVALID_TIMEZONE` 400→`INVALID_INPUT` 映射 + D4 删 `localDateToHalfOpenRange` 死代码（连私有助手与单测）；D1 webm kind hint MIME 特例回退（`wireKindHint` 仅 `audio/webm` 时 `video→audio`，大小限额仍魔数）+ `ATTACHMENT_KIND_MIME.audio` 补 `audio/webm`；D2 check:contract 扩 REST 段（rest.py 8 模型字段覆盖/必填性/role 枚举子集 + 防静默通过（模型数<8 或字段数=0 → exit 1））+ 新增 real-backend-upload.spec（FormData 顺序/混合批次/webm 透传/响应权威/取消）+ 历史查看器搜索失败 hasSearched 保持 false 防伪空态；D3 新增 sticker-contract.spec（真实形状 sticker 响应 → 严格 Schema → IPC 双 schema（chatQueryHistorySchema + ChatHistoryPageSchema）→ restMapper → History Store 可展示 + 跳转）；B-02 验收口径（纯文本行 + 「消息」chip + 跳转正常即通过，P2-3 无缩略图非缺陷；贴图发送→搜索命中→跳转闭环纳入 B-02 验收）写入本文档与决策记录；**904 单测（82 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿**；阶段 3 新功能仍标「已开发、未联调」，B-02/B-03 进入条件达成；决策见 `docs/review/2026-08-15-阶段3-联调前整改-决策记录.md` | 已开发、未联调（B-02/B-03 进入条件达成） |
| 2026-08-15 | **阶段 3 真实联调复验整改（4 项 P0/P1 生产修复）落地并全量验证**：P0-01 相对签名 URL 基于 endpoint 解析（`media-service.resolveSignUrl` 相对→绝对、保留反代 path 前缀、绝对 http(s) 放行不强同源；`SignedUrlResolveError` 与签发失败区分；缓存 key `${baseUrl}:${attachmentId}` endpoint 身份分区；stream 500 / checkStatus resolve_failed）；P0-02 ContentPart 可空数字 null/非法归一化（`toOptionalNonNegativeNumber`：typeof number && finite && >=0，否则缺省；`ContentPartShape` 数字字段诚实反映 wire；**wire 边界** `RestMessageSchema` + `RawSessionMessageItemSchema` `duration_ms` 改 nullable，rest-types/raw-types 类型同步；IPC/领域 Schema 保持严格）+ 补 `raw-types.ts` `duration_ms` 类型同步（任务 5 门禁闭合）；P0-03 StickerPart 恢复（`stickerIdOf`/`extractStickerId`，`sticker_id` 优先 + src 经 `stickerIdFromResourceUrl` 兜底，`STICKER_ID_PATTERN` 单一来源 `shared/domain/sticker-url`；用户分支恢复 `Message.stickerId` + typed parts 文本提取，assistant 分支 `kind:'sticker'` 分段；贴图不塞入 attachments；无效 ID fail-open）；P1-01 历史搜索单流首屏统一 `sortKey` 升序（`compareBySortKey` export，单流分支进入领域前升序，cursor 原样续接）；**936 单测（82 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿**；新增真实相对签名 URL / ContentPart null / StickerPart replay / 两页排序 fixture；后端 MIME（BE-S3-RUN-P0-02 audio/webm·audio/wav）主修在后端仓，修复后补真实契约测试（D4）；阶段 3 新功能仍标「已开发、未联调」（真实 Windows Electron 回归通过后升「已真实联调」）；决策见 `docs/review/2026-08-15-阶段3-真实联调复验整改-决策记录.md` | 已开发、未联调（真实回归前不升） |
| 2026-08-15 | **阶段 3 真实联调第二轮前端整改（FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达）落地并全量验证**：纯 CSS 容器约束（`.cy-history-overlay` grid→flex 消除 grid area 百分比环 + `.cy-history` `min-height:0` 允许收缩、面板定高不随结果条数增长；`.cy-history-results` `flex:1 1 0;min-height:120px;overflow-y:auto;overflow-anchor:none` 独占剩余空间内部滚动，header/筛选/分类/状态/footer `flex-shrink:0` 常驻）+ `onLoadMorePreservingAnchor` loadMore 锚点补偿（捕获首个可见 `.cy-history-item[data-hit-id]` + 精确 `offsetTop`，`nextTick` 后补偿 `scrollTop`，禁 `force`/DOM `.click()`）+ mock 历史数据基建（`MockBackendOptions.seedHistoryCount` + `CYRENE_MOCK_HISTORY_LARGE` env 透传 + `parseMockHistoryCountEnv`（undefined→不装、正整数→原值、0/负/NaN/非法→120）+ 分页语义对齐 real（DESC 源切片 + 页内升序，mock 第一页=最新 50 条））+ 新集成 `history-viewer-layout.spec.ts` 三用例（1184×721 主档：面板/footer/按钮 ⊂ viewport + 真 `locator.click()` 加载第二页 100 条 + hitId 唯一 + first50 相对顺序子序列保留 + day 组 2→4 + 锚点偏移 ≤1px + `overflow-anchor:none` computed 生效 + Shift+Tab×3 焦点陷阱回绕到「加载更多」+ Esc 关闭回焦「聊天记录」/ 1100×700 最小档 / 空结果态（`zzz_nonexistent` → 空态 ⊂ 面板 + 无 `.cy-more-btn`））；**944 单测（83 files）+ 42 集成（11 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿**；新增 6 单测（`mock-backend-seed.spec.ts`）+ 3 集成用例；实施期两个 Ruling（① 字段初始化器 `seedHistoryCount = options.…` 原生 class fields 下先于构造体执行、看不到形参 → ReferenceError，改为构造体内按序赋值（声明顺序保留）；② `launchWithSize` `app.evaluate` 闭包变量 w/h 不随 Playwright 序列化进主进程 → ReferenceError，改显式第二参传 `{w,h}`）；阶段 3 新功能仍标「已开发、未联调」（真实 Windows Electron 50+50 短回归（后端 `556117a`）通过后升「已真实联调」）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-15-phase3-rerun2-layout-*`，决策见 `docs/review/2026-08-15-阶段3真实联调第二轮前端整改-决策记录.md` | 已开发、未联调（真实回归前不升） |
| 2026-08-15 | **阶段 3 真实联调通过**：真实 Windows Electron（REAL 模式，经 SSH 本地转发连接 Ubuntu backend `0.1.0+556117a` / protocol `2.0`）完成历史查看器 50+50 短回归——搜索 50 条后普通点击「加载更多」加载第二页，100 条顺序/去重/来源跳转正常，面板完整在窗口内内部滚动（FE-S3-RUN2-P1-01 闭环）；阶段 3 四组（G1 布局响应式 / G2 历史聊天体验 / G3 附件多媒体 / G4 历史查看器+表情+无障碍）与 2026-08-15 三批整改（联调前 / 复验 / 第二轮布局）全部由「已开发、未联调」升「已真实联调」；验收见 `docs/review/2026-08-15-阶段3真实联调通过-验收记录.md` | 已真实联调（阶段 3 整体通过，阶段 2 主链保持 B-01 封口） |
| 2026-08-15 | **阶段 4 批次 A（模型服务 Profile 管理 + TTS 试听）落地并全量验证**：决策 D1（阶段 4 分两块，P4-A = Profile 管理 + TTS 试听 / P4-B = 语音）/D3（TTS 自动朗读归 P4-B）/D4（backend 为主，desktop/local_worker 展示不可用态）用户敲定；契约→Schema→real/mock backend→MediaService 路由→IPC→preload→store→设置 UI→集成测试全链路（ModelProfile/UpsertModelProfileCommand/ModelProfileTestCommand/ActivateModelProfileCommand/TtsVoice/TtsPreviewCommand/SetTtsVoiceCommand/ActiveModelSelection，switch_model_result/set_tts_voice_result 事件 + server_info.services 激活来源 + 试听一次性 `tts-preview` media 路由 + credentialStatus 两态一次性提交）；D-8 关闭（后端 `556117a` 为 `dictation.start` 增加 `sttProfileId`，E-07 升 `[~]`）；**994 单测（88 files）+ 55 集成（13 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿**；阶段 4 新功能仍标「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方（下一轮）；决策见 `docs/review/2026-08-15-阶段4批次A-决策记录.md` | 已开发、未联调（真实联调待下一轮） |
| 2026-08-16 | **阶段 4 批次 B（语音：普通录音 + 实时语音会话 + 输入法转写 + TTS 自动朗读 + 设置持久化）落地并全量验证**：领域契约（`shared/contracts/voice.ts` 新 + events.ts +13 事件 + zod schema 镜像）→ raw 帧/mapper `stampEvent` → real-backend 三模式命令 + `sendAudioBytes` BINARY 上行（连接+活动会话双 guard）+ TTS base64 帧（`audio_start/audio/audio_end/audio_cancelled`，MediaService `tts-live` 路由）+ `voice.error` 语音族错误路由（D-P15）→ mock 语音/TTS 模拟（envelope 交错单调）→ Main 设置持久化（`settings.json` 原子写 + zod + 损坏隔离，D-P6）→ `voice:audio-chunk` 单向守卫（`registerOneWayHandler` 1 MiB，D-P18）+ 麦克风权限处理器（D-P7）→ Renderer `PcmCapture`（AudioWorklet/ScriptProcessor 降级）→ `voiceStore`/`settingsStore`/`messageStore`（`voice_session.turn` + `sendVoiceCommit`）→ UI（CyChatInput 三入口 + CyVoicePending/CyRealtimeBar/CyDictationHint + CyTtsPlayer + 语音子页 CyVoicePane + consent + 会话守卫）；**1245 单测（100 files）+ 70 集成（15 files）** + typecheck/lint/build + check:contract 全绿；阶段 4 新功能（A/B）仍标「已开发、未联调」（Mock 驱动），真实 Windows Electron（REAL）联调为验收方（下一轮）；决策见 `docs/review/2026-08-16-阶段4批次B-决策记录.md` | 已开发、未联调（真实联调待下一轮） |
| 2026-08-16 | **阶段 4 真实联调整改（普通录音异常清理 FE-S4-RUN-P0-01/P1-01/P1-02）落地并全量验证**：`voice.discard` 语义对齐配套后端修订 BE-S4-RUN-P0-01（可取消任意未提交阶段 RECORDING/TRANSCRIBING/PENDING + IDLE 迟到/重复幂等成功）；录音取消收敛单一 helper `discardRecord()`（recordingId 保留至取消帧发送 resolve/reject，发送失败 console.warn + 本地清态 + 连接 reset 收口，R-S4-01）；`record.awaitingTranscript` 等待态（停后「正在识别…」→ transcript/error/45s timeout 终态，45s 兜底「未识别，请重试」唯一翻转，R-S4-04/R-S4-07）+ `CyVoicePending` 渲染优先级 错误 > 字幕 > 正在识别 > 未识别（错误与字幕可并存，确认发送禁用无字幕）；`voice.error` recording 态消费门控（R-S4-06）；`MockBackend.discardVoice` 冻结契约五态建模（match 清 / mismatch 拒绝不误清 / realtime·dictation 拒绝不动 / IDLE 幂等成功，R-S4-03）+ `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` env（stopRecordVoice 控制帧立即 resolve、仅 transcript emit fire-and-forget 延迟，R-S4-05/R-S4-08）；real-backend 有状态协议桩（冻结契约序列 + 漂移 canary，R-S4-02）；**1284 单测（100 files）+ 73 集成（15 files）** + typecheck/lint/build 全绿；check:contract 待配套后端更新 `frontend_contract` discard 样例后复跑；阶段 4 新功能（A/B）仍标「已开发、未联调」，整改后仍待配套后端修复 SHA 真实 Windows Electron 复验（下一轮）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-16-phase4-voice-cleanup-fixes-*`，决策记录 §10 见 `docs/review/2026-08-16-阶段4批次B-决策记录.md` | 已开发、未联调（真实联调待下一轮，P0 复验依赖配套后端修订） |
| 2026-08-18 | **阶段 5 批次 B（Live2D 表现：状态映射 + 待机 + 动作/表情 + 参数回退 + 设置子页 + Panel）落地并全量验证**：`Live2DSettings` 扩全量 10 字段 + `PerformanceMode` 四值统一（旧三值 `high/low` 读回归一，`normalizePerformanceMode` schema 归一）+ settings patch 无默认子 schema（防单字段 patch clobber）；`Live2DAdapter` 参数通道 + motion/expression 加载播放 + Layout 装配；Controller 状态机收敛表（thinking→speaking→idle、error 打断、低优先不打断 3 级、同态幂等、结束回正确回退态）+ 待机眨眼/呼吸纯函数 + 无动作参数级回退（B4）+ `switchModel` 返回生效 id（D5B-10 竞态硬化）；动作调度仲裁（白名单/合并/超时/清队列/点击不打断）+ 情绪态→表情本地映射（happy/f01、sad/f02、surprised/f06，不命中落 B4）+ `live2dStateSource` 状态编排（connection/message/voice 读值组合，N1 情绪/error 超时回退）+ store 接线 + 设置子页 CyLive2DPane（模型/表现/互动/性能四组 + 恢复默认）+ CyLive2DPanel 状态徽标/缩放偏移手柄/鼠标跟随点击回正；Electron 集成新增 7 用例（状态驱动徽标 / Haru B3 动作播放 / 情绪 happy→表情 / 设置子页即时+重启持久化 / 性能模式四值+旧值回归 / 布局画幅 / 切换竞态三方一致）；mock env 桥 `CYRENE_MOCK_EMIT_DELAY_MS`（放宽 replay 间隔供状态断言）+ `CYRENE_MOCK_GENERATION_EMOTION`（generation.completed 情绪注入）；门禁 **1508 单测（114 files）+ 90 集成（16 files）** + typecheck/lint/build 全绿；三态标「已开发、未联调」，真实 Windows Electron（REAL）联调归批次 C；spec/plan 见 `docs/superpowers/specs|plans/2026-08-18-phase5-live2d-batchb-expression-*`，决策记录 D5B-01~10 由主会话落文 `docs/review/2026-08-18-阶段5批次B-决策记录.md` | 已开发、未联调（真实联调待批次 C） |
| 2026-08-18 | **阶段 5 批次 C（Live2D 收口代码批次：TTS 口型 + 性能降级 + 后端指令 + 防御加固 + 文档/联调清单）落地并全量验证**：C1 TTS 口型数据源（`computeMouthLevel` 包络纯函数（噪声门/攻放不对称/钳制/归零）+ `tts-mouth-source.ts`（MediaElementSource→Analyser RMS，每元素终生一次）+ 口部写出通用化（`updateAnimation` 对所有 ready 模型写 `ParamMouthOpenY`，B3 动作后写覆盖）+ `voiceStore.ttsAudioEl`/CyTtsPlayer 挂接 + `tick()` 采样 + `CYRENE_MOCK_MOUTH_LEVEL` env 桥）；C2 性能降级（`FrameBudget` 四值真实降帧（quality/balanced/low_power/auto 迟滞）+ GPU 丢失一次重建 `reset(modelId?)`（rebuildGuard finally 复位 + 重放 settings/CharacterState）+ `setVisibility` 接线 + `adapter.initialize` 半初始化兜底）+ C3 后端 `live2d.directive` 扁平冻结契约四件套（`raw-types.ts`/`raw-schemas.ts` `.strict()` 整帧拒/`FrameMapper`/`BackendEventSchema` 镜像；`state` 七值剔除 error + priority 建议强度钳制 ≤1 + durationMs 15s 封顶 + `pushDirective` 建议强度仲裁（永不覆盖 client 2/3 级现实态）+ 指令>emotion + 脱敏日志 + mock `CYRENE_MOCK_DIRECTIVE`/real 桩）+ 防御加固收口（M1 `%` 同口径 / M2 registry 强校验 / M3 空数组 / M4 reason 闭合枚举 / F2 blink 速率 / F3 expressions 空→B4 / restore 分叉 / 批次 A F2-F4 关单）+ 文档同步 + 决策记录 + 联调清单；Electron 集成新增 7 用例（C1 口型链路 / C2.1 四值切换+持久化 / C2.2 GPU 丢失重建一次 / C3.1 指令 happy+F01 / C3.2 非白名单脱敏 / C3.3 working 越界 / 收口回归），既有第 6 号「设备丢失」改写为一次重建；门禁 **1599 单测（119 files）+ 97 集成（16 files）** + typecheck/lint/build + check:contract（WS 28/28 + REST 15/15）全绿；三态标「已开发、未联调」，真实 Windows Electron（REAL）联调由开发者事后凭 `docs/review/2026-08-18-阶段5批次C-联调清单.md` 执行（通过后升「已真实联调」）；批次 commits：spec `3708f08` → plan `3cd374d` → Task1 `21bcda6` → Task2 `d6f9d58`+`2057a74`（F1）→ Task3 `fea778c` → Task4 `96283c3` → Task5 `328ce16`+`7065aee`（I-1）→ Task6 文档（HEAD）；spec/plan 见 `docs/superpowers/specs|plans/2026-08-18-phase5-live2d-batchc-closure-*`，决策记录 D5C-01~09 由主会话落文 `docs/review/2026-08-18-阶段5批次C-决策记录.md` | 已开发、未联调（真实联调待联调清单轮） |
| 2026-08-19 | **阶段 5 真实 Windows Electron（REAL）联调通过，三态升「已真实联调」**（验收 `docs/review/2026-08-19-阶段5-Live2D真实联调验收.md`；实测基线含 C2-2 真机 GPU context 恢复修复 `da7f617`）；联调前整改 F-1（后端 mood 自由文本 → `normalizeEmotionCode` 中英文归一，`4f0d627`）落地并全量验证；**CI 修复 5 轮**（`ad3d1e0` C1 稳健化 + Windows 单测兼容 / `4791e7e` backgroundThrottling:false / `f3475c0` mock WAV 0.0625s 时长修复 + 直轮询 + 诊断探针 / `664190a` 断言改持久标志 `mouthMoved/mouthSettled`）——本机门禁全绿（1612 单测 + 98 集成 + typecheck/lint/build + check:contract WS28/REST15）；**遗留待办：CI `test:integration` 的 C1 口型用例仍红（SwiftShader 渲染饱和 renderer 主线程 → 外部观察饿死，口部 attach 断链在 CI 未定位），暂缓修复，已记录 `docs/review/2026-08-19-阶段5批次C-C1集成测试CI失败-待办.md`——不影响生产（阶段 5 已真实联调）与阶段 6 开发，仅 CI 集成 job 保持红（1 用例）** | 阶段 5 已真实联调（C1 CI 待办挂起） |
| 2026-08-19 | **阶段 6 工具双轨统筹决策（方案 B）定案，仅文档批次**：核对结论（backend 工具实发 `action` 帧但前端未收录；一个回合一个 generation 且 `generation.completed` 无 `tool_calls`；ID 双轨断裂）→ 方案 B（Desktop `tool.request/tool.status` + Backend 新增 `tool.started/tool.completed`，前端领域层统一 `ToolCallRecord`，权威键 `sourceCallId`）→ §9 任务清单补 raw/领域四件套与归档配对；决策与 F-6-01~25/B-6-01~09 更新点见 `docs/review/2026-08-19-阶段6-工具双轨统筹决策记录.md`；**代码批尚未开始，阶段 6 三态保持「未开始」** | 未开始（方案 B 已定案，待契约批） |
| 2026-08-20 | **后端 B-6 批已落地并同步到前端文档（后端本地 HEAD `03a6e882`，领先 origin 13 commit 未 push）**：契约 `ToolRuntime` + `tool.started/tool.completed` + `tool.request.sourceCallId` 必填已合并，三产物再生成；v2 停发工具 `action`（v1 逐字节不变）；scheduler 线程化 `tc.id` 修复生产 `sourceCallId` 空串；`outputSummary` 2000 字符截断 + `inputSummary=_safe_arg_summary` + `reason` 缺省已按默认定案。后端门禁前端侧独立复跑：test-quick **3652 passed** / ruff / pyright **0** / check-types 全绿；前端 `check:contract` WS 28/28 + 12 帧有意滞后 warn（新帧待 F-6-01 收编）。**F-6 批次 A（raw/领域四件套 + 归档配对）可立即开；批次 B 仍待 F-06/F-07/F-09/F-10 拍板**；同步详情见 `docs/review/2026-08-19-阶段6-工具双轨统筹决策记录.md` §7 | 未开始（后端契约就绪，待前端 F-6 批次 A） |
| 2026-08-20 | **阶段 6 批次 A（工具契约与领域层）已落地并全量验证（三态=已开发、未联调）**：raw wire 四件套（`tool.request/started/completed` + `action` 兼容帧 + client `tool.status`，`.strict()` 镜像契约，WS 28→32/未纳 8）+ 领域事件三件套（`BackendEvent` + `BackendEventSchema` 镜像，tool.request 无安全元数据字段）+ `ToolCallRecord` 契约（id=sourceCallId 权威键，展示 8 态/协议 6 态分离）+ `ToolResult`→`ToolStatusCommand` 收敛 + 归档配对（`pairToolCalls` 纯函数：缺配对降级/error 优先/去重，REST 历史 + WS 回放双路径 → `Message.toolCalls`）+ mock 工具场景（`CYRENE_MOCK_TOOL_FLOW` 两 kind + `submitToolResult` 实装 + `CYRENE_MOCK_TOOL_HISTORY` seed）+ `refresh-wire-manifests.mjs` 脚本；门禁 **1639 单测（124 files）** + typecheck/lint + check:contract（WS 32/32 + 8 未纳 warn + REST 15/15）；spec/plan 各 2 轮 code-review APPROVE（`56ddce6`/`e43ae5a`），Task1~6 提交链 `319d8cf`→`c95b9c9`→`8cda431`→`b92d6f5`→`2d8e337`→`f9d4af5a`；集成用例按 R-A2 取舍跳过（mock 模式不经 rest-mapper，配对归 real/批次 C 联调）；决策记录 `docs/review/2026-08-20-阶段6批次A-决策记录.md`；**批次 B 仍待 F-06/F-07/F-09/F-10 拍板** | 已开发、未联调（批次 A 代码批完成） |
| 2026-08-20 | **阶段 6 批次 B（Main 工具服务/权限/四执行器/UI）已落地并全量验证（三态=已开发、未联调）**：F-6-07~18 + F-6-22/24 + 承载项（R-A3 `error:''` 加固、`MessageSchema` 补 `toolCalls`、jsdiff ^9.0.0）——tool-registry 静态注册表四工具 + `PATH_BLACKLIST_DEFAULTS`（realpath 段边界、含 /tmp 与用户敏感面/Windows 面，测试经 `CYRENE_MOCK_TOOL_ALLOW_ROOT` 放宽）+ tool-service 13 步决策链（paramHash canonical 固定向量校验/黑名单命中不弹窗/Wayland 授权前拒/write 授权前预读+Diff/awaiting FIFO 一次一个/shutdown 收尾）+ 四执行器（select selected-set TTL 豁免、read 2 MiB 上限+64 KiB 内联+附件上传+二进制拒+TOCTOU、write Diff+写前哈希 `FILE_CONFLICT`+原子替换+格式保留、capture Win+X11 desktopCapturer+Wayland 降级+子状态机钉死+两步确认）+ tool-status-sender（Main 缓存组装 + `adapter.submitToolResult`/`uploadToolAttachment`，上传时序 running 后 result 前）+ IPC 面（`PushChannels.tool:event` + `IpcChannels` 五 invoke，zod 双端 + `SCHEMA_VALIDATION_FAILED` + `isTrustedSender`）+ toolStore 三来路归一化 + 双区渲染（CyLiveToolCards 实时区 ≤3 + CyMessageBubble 归档只读卡片）+ CyToolCard/CyToolApproval（四问/初始焦点拒绝按钮/写 Diff+格式元信息/截图三步）+ Live2D `waiting_permission` 真实驱动 + mock 改接 `toolRequestSink` 统一入口 + 集成 electron-tools.spec.ts 6 用例（拒绝/允许/取消/写冲突/backend 只读/capture 软断言）；**F-06/F-07/F-09/F-10 预检拍板落地**（仅黑名单零预授权/仅一次+拒绝最小闭环/jsdiff/桌面捕获平台）；门禁 **1770 单测（136 files）+ 104 集成（17 files）** + typecheck/lint/build + check:contract（WS 32/32 + 8 未纳 warn + REST 15/15，**manifest 未刷新**——raw wire 未变）；spec/plan 各 2 轮 review APPROVE，Task1~8 提交链 + lint 清零 `c0e1167`；决策记录 `docs/review/2026-08-20-阶段6批次B-决策记录.md`；**批次 C 前置**：真实 Windows Electron 联调 + allow_scoped/授权管理页/命令模板空态（F-08 待确认）+ `GET /api/tools/calls/{callId}` + action 移除评估 + 跨页配对复核；（门禁计数最终值见 CLAUDE.md——主会话统一更新） | 已开发、未联调（批次 B 代码批完成） |
| 2026-08-21 | **阶段 6 批次 C（allow_scoped 目录授权 + 设置页授权管理 + 命令模板空态 + 复核项收口）已落地并全量验证（三态=已开发、未联调）**：settings.tools grants 子树（`PermissionGrant` 契约含 backendIdentity、`ToolsSettingsSchema.default({grants:[]})` version 保持 1、`SettingsService.save` 子树 merge）+ GrantStore（list/add/revoke/prune/matches + `grant:*` 审计（summary 无目录路径含 backendIdentity，F-5）+ 黑名单复核 + realpath 归一 + 段边界 + 身份匹配 + 幂等 N-6 + 装载期校验 N-8）+ tool-service 决策链 step 8 grant 匹配（grant 优先于豁免、黑名单优先、capture 恒确认、写命中只读 Diff F-4）+ 「允许指定目录」创建流（CyToolApproval 第三入口 + TTL select + `pickDirectory` 注入 + ttl 白名单双校验 F-3 + 断连不创建 + run 入口守卫）+ CySecurityPane 三分区（授权管理/审批历史（`tool:history` audit JSONL 回读、过滤搜索、跳转撤销 F-21）/命令模板空态 **F-08 关闭**）+ IPC 四通道（grant-directory/grants/grant-revoke/history）zod 双端 + L-1~L-8 收口（records 驱逐/init 水合先水合后订阅 F-15/run 入口守卫/tool.request try-catch/diff 截断 L-6/confirmUpload 顺序 L-7/decide.catch L-8）+ M-1 确认/M-3 否决 + 新文件写 TOCTOU 守卫 + GET /api/tools/calls/{callId} real 实现（`DesktopCallStatusSchema` repo 9 值 + rest-schemas.ts 导出 V-12，check:contract REST 段 15→16）+ mock 恒 `null` 降级 + reconnect queryStatus 三分支 + 装配顺序 V-4（settingsSvc 先于 toolSvc）；门禁：**1847 单测（142 files）**（实测）+ **111 集成（17 files）**（实测，electron-tools 增 7 用例）+ typecheck/lint/build + check:contract（WS 32/32 + 8 未纳 warn + REST 15/16，**manifest 未刷新**）全绿——**计数最终值以 CLAUDE.md 主会话统一为准**；决策记录 `docs/review/2026-08-20-阶段6批次C-决策记录.md`；**批次后前置**：真实 Windows Electron 联调（三态升「已真实联调」） | 已开发、未联调（批次 C 代码批完成，联调归开发者批次后） |
| 2026-08-21 | **阶段 6 真实联调条件复核 + 联调清单落盘（文档批次）**：前端 HEAD `1cc1d28` 独立复跑门禁全绿（1849 单测（142 files）/ 111 集成（17 files）/ typecheck / lint / build / check:contract WS 32/32 + 8 未纳 warn + REST 16/16）；后端 origin 已同步 `03a6e882` 并启动（/health /ready 200，四个 desktop 工具注册），真实后端 v2 冒烟收到 `tool.started→tool.completed{get_time}` 且 action=0；**联调条件 = 代码侧已具备，环境侧仅差前端 push（当前领先 origin 20）→ Windows pull + pnpm install（新增 jsdiff）+ build + REAL 启动**；联调清单 `docs/review/2026-08-21-阶段6-工具与权限-真实联调清单.md`（0 环境动作 + 1~8 十组用例 + 已知预期行为 + 三态升迁规则） | 已开发、未联调（代码侧联调条件已具备，待开发者 push 后真机执行） |
| 2026-08-21 | **阶段 6 真实联调收口修复（代码批，已落地待真机复验）**：① 回退 `cyrene` scheme `corsEnabled:false`（联调期曾临时打开；违反阶段 5 D-4 安全结论，handler 的 renderer-root/media 分支无 ACAO 白名单），单测恢复断言，联调清单 0.4 明确必须 preview/prod 同源启动；② 实时工具卡片会话隔离——`DesktopToolRequest/ToolRecord/PublicToolEvent` 增 `conversationId`，real/mock 从 `activeConversationId` 注入，toolStore 增 `setActiveConversationId` + `visibleLiveOrder` 过滤（未归属/活动会话未知兼容显示），`waitingForApproval`/`liveRecords` 只统计当前会话，bootstrap 在 connection state push 时同步；③ 验收记录矛盾与 60s 口径校正（后端 bridge 实为 120s，`desktop_calls.expires_at=created+120s`；剩余真机顺序改 preview 模式）；门禁：**1867 单测（143 files）/ 111 集成（17 files）** + typecheck/lint/build + check:contract（WS 35/35 + 5 未纳 warn + REST 16/16）全绿 | 已开发、未联调（真机待复验：4.3 同源媒体 + 会话隔离 + 8.3 语音） |
