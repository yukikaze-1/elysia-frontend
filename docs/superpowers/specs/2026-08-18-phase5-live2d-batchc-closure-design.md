# 阶段 5（Live2D）批次 C：收口（代码批次）——TTS 口型 + 性能降级 + 后端指令 + 防御加固 + 文档/联调清单

**设计 spec（binding authority）**
**日期：** 2026-08-18
**批次：** 阶段 5 · 批次 C（共 A/B/C 三批次；A = 地基【已完成】，B = 表现【已完成】，C = 收口【本 spec】；批次 C 真实 Windows Electron REAL 联调由开发者事后执行，本批**只做代码批次**，三态=已开发、未联调）
**依据：** [05-Cyrene-Live2D前端接入设计-v0.2.md](../../05-Cyrene-Live2D前端接入设计-v0.2.md)（binding；§3 核心接口 / §6 状态来源与优先级 / §8 后端表现指令 / §10 基础口型同步 / §12 性能策略 / §12.2 自动降级 / §15 资源与许可）+ [02-Cyrene-前后端通信协议与前端数据结构-v0.2.md](../../02-Cyrene-前后端通信协议与前端数据结构-v0.2.md) §4（v2 扁平 wire）/§12（Live2D 指令契约）+ 批次 A/B spec 与决策记录（`../specs/2026-08-17-phase5-live2d-batcha-foundation-design.md`、`../specs/2026-08-18-phase5-live2d-batchb-expression-design.md`、`../review/2026-08-18-阶段5批次B-决策记录.md`、`../review/2026-08-17-阶段5批次A-决策记录.md`）+ 本会话预检决策集合（见 §0）

---

## 0. 决策集合（本批定案，预检已确认「按推荐拍板」；最终报告汇报）

| # | 决策 | 理由 |
|---|---|---|
| **D5C-01** | **口型数据源 = MediaElementSource + Analyser 挂现有 `<audio>`**（C1）：TTS `<audio>`（`cyrene://renderer/__cyrene-media/tts-live/{id}`，页面与资源同源）经 `createMediaElementSource` → AnalyserNode；帧采样复用既有 Panel rAF → `store.tick()` 链（**不新增独立 rAF**）；包络纯函数 → `controller.setMouthLevel(level)`。**保留 D-P8 播放/ended/error 流程与 autoReadReply 门不动**。**兜底**：若 cyrene:// 上 MediaElementSource 实测采样静音（Electron 自定义协议 CORS 特例），回退 `fetch→decodeAudioData→AudioBufferSourceNode` 全 WebAudio 播放（此时替换 `<audio>` 播放路径，ended 经 WebAudio ended 重接线）——实现先走 A，**可回退路径在 spec 记录、不阻断交付**（真实 RMS 准确性归联调肉眼验证） | 最小改动接入既有 TTS 播放链；同源资源理论无 CORS；Analyser 复用 tick 无需独立循环 |
| **D5C-02** | **包络→mouthLevel = 纯函数 + 口部写出对全部 ready 模型生效 + 统一门**（C1，spec 审查 C-1 修正）：新建 `mouth-level.ts` `computeMouthLevel(rms, prevLevel, {noiseFloor, attackMs, releaseMs, maxStepPerMs}) → [0,1]`（纯函数，同 param-anim 先例）。短窗 RMS（Analyser `fftSize=256`，`getFloatTimeDomainData` 均方根）；噪声门限（低于 floor → 0）；**attack 快（~50ms）/ release 慢（~250ms）**；最大变化率钳制。静音/暂停/`audio.session.cancelled`/`ended` → 归零。**关键修正（审查 C-1）**：电口写出（`mouthLevelTarget` → `ParamMouthOpenY`）从批次 B 的 `b4Params` no-motion 分支**提升为 updateAnimation 的通用口部步骤**——对所有 ready 模型生效（门=`autoMotions ∧ lipSync`，批次 B M5），有动作模型同样写；B3 动作后写（`adapter.update` 内 motion manager）**自然覆盖**电口（相同口部参数时动作值赢）。**lipSync 门定案（批次 B Task5 M3 关闭）**：lipSync 只门控 C1/B4 参数级电口；B3 动作口部不受 lipSync 门（模型作者编排，闭嘴门控记为后续需求） | doc 05 §10（短窗 RMS/噪声门/攻快放慢/最大变化率/静音归零）；审查 C-1：原 b4Params 只盖 no-motion 模型，主验收模型 Haru（有动作）电口不写、验收句不成立；P0-3 互斥口径（B3 后写优先、电口兜底） |
| **D5C-03** | **四值降帧真实消费 = tick 内 FrameBudget（纯逻辑类）**（C2）：新建 `perf.ts` `class FrameBudget`（状态机式纯 JS：注入时钟、单测覆盖）：按 `perfMode` 决定每帧是否推进 `controller.tick` 整段（动画+draw **原子跳过**，skip 帧不产生 draw）。quality=每 rAF 满帧；balanced=按近期实测 tick 耗时（EMA）在 60/30 间自适应；low_power=30fps 封顶；auto=带迟滞自选（连续超阈值降档、连续低耗时升档；**窗口可见性因子由 D5C-05 可见性门覆盖**，FrameBudget 只负责帧耗时维度）。**画布分辨率降级本批不做**（doc 05 §12.1 提及；批次 A D5A-11 显式赋 C2 项二度延后——record defer，决策记录承接说明：留待联调观测后定）。**系统低电量→切低功耗配置（doc 05 §12.2「系统低电量模式」、批次 A 赋 C2）本批显式 defer**（Electron powerMonitor 集成属额外面，记录 defer + 决策记录承接，联调观测后定）。skip 帧**仍执行**视线跟随 lerp（廉价、保平滑，Panel 侧） | doc 05 §12.1 四值行为 + §12.2；批次 B 只落枚举与持久化，本批消费；审查 M-8：auto 的可见性因子由 D5C-05 覆盖 |
| **D5C-04** | **GPU 重建一次 = device_lost → `reset(当前 modelId)` 一次**（C2）：`controller.reset(modelId?)` 扩展（缺省当前 modelId 优先，不可用回退首个可用；失败 → fallback）。store 侧：device_lost 事件 → **触发一次** `reset(currentModelId)`（防重入：重建中再 device_lost 不二次触发；guard 按「每次 lost 事件一次」非永久）→ 成功恢复 `ready` + **重放 settings/autoMotions/lipSync/performanceMode/当前 CharacterState**；失败 → fallback（静态头像，批次 A 既有路径）。重建经 `adapter.initialize` 重创建 GL context（`initialize` 幂等守卫靠 reset 先 unload→destroy 清 gl 才真重建）。**随重建核查批次 A Task5 P3「initialize 半初始化兜底」**（重建路径再走 initialize，缺失的 try/finally 兜底会复用旧问题——见 §7 风险） | doc 05 §12.2「GPU 上下文丢失：尝试重建一次，重建失败→静态头像」 |
| **D5C-05** | **`setVisibility` 收口 = 接线进 tick 门，非死面**（C2）：controller.tick 在 `!this.visible` 时提前 return（不产生帧）；live2dStore 将「布局可见（live2dShown）∧ enabled」镜像为 `controller.setVisibility(...)`（Panel 的 rAF 启停保持既有；双层门控无害）。消除批次 B Task5 M4 死面 | Task5 M4 deferred；单一可见性语义 |
| **D5C-06** | **C3 契约冻结（扁平帧）+ 桩 + schema 镜像**：冻结 `live2d.directive` **扁平 wire 帧** `{type:'live2d.directive', expression?, motion?, state?, priority?(0-3), durationMs?}`（对齐 doc 02 §4 v2 扁平 wire 约定 + §12 形状 + raw-schemas `.strict()` 惯例，**不用 payload 子对象**）。代码面（**链条四件套**）：① `shared/contracts/backend.ts` raw 帧类型；② `main/transport/protocol-v2/raw-schemas.ts` `live2d.directive` 判别联合成员（`.strict()`，**未知字段整帧拒 + 脱敏日志**，fail-closed）；③ `FrameMapper.mapFrame` 分支（raw→BackendEvent）；④ `shared/contracts/events.ts` BackendEvent 联合增 `Live2DDirectiveEvent` + `shared/schemas/events.ts` `BackendEventSchema` 增 `Live2DDirectiveEventSchema`（**缺镜像 → preload `parseBackendEvent` 丢弃，事件到不了 store**——P4-B 语音事件先例）。mock-backend 加 `CYRENE_MOCK_DIRECTIVE` env（JSON payload → 下一 `generation.completed` 后发射冻结帧）；real-backend 加解析桩（**缺省无帧**，若收到按冻结契约解析 + 漂移 canary 沿用 P4-B） | doc 02 §12 契约零接线现状；后端当前不发该帧，桩化使解析/校验/映射可全量开发与 Mock 验收；审查 M-2/M-3/R2-I2：payload 嵌套违反 v2 扁平 + `.strict()` 惯例，schema 镜像缺失事件被 preload 丢弃 |
| **D5C-07** | **指令校验 + 消费 + 优先级**（C3，审查 I-1/I-2/R2-I4 修正）：校验——`state` ∈ **七值** `idle/listening/thinking/speaking/happy/sad/surprised`（**剔除 `error`**：error 为 client 派生态，防 3 级错误态被任意注入覆盖 thinking/speaking；决策记录记「偏离 doc 02 §12 含 error」的理由：doc 05 §6 error=3 必须 client 驱动）；`expression/motion` ∈ 该模型白名单（controller 本地副本 + adapter assert + Main resolveModelFile 三层）；`priority` 客户端钳制 **≤1**（建议强度上限，doc 05 §6「1=后端情绪建议/用户互动」）；`durationMs` ∈ **[0, 30_000]**。消费——**pushDirective 以建议强度（clamp≤1）为覆盖比较基准**：仅当 建议强度 ≥ 当前机器优先级 才 push（否则丢弃/只记最新）；因强度恒 ≤1，指令**永不覆盖** client 2/3 级现实态（thinking/speaking/error/waiting_permission）——与 doc 05 §6「后端情绪建议=1、可被主要任务打断」一致；指令 state 的自然机器优先级只决定**表现**（thinking→B4 摆头、speaking→口型），不决定覆盖资格（消除 round-1 原文「2/3 级自然覆盖」误述）。超时回业务态（复用 N1 机制）。`expression` → `controller.setExpression(file)`；`motion` → `controller.playMotion(file, clampedPriority, durationMs?)`（**durationMs 以 min(durationMs, MOTION_MAX_MS=15s) 生效**，playMotion 扩第三参为本批改动）。**显式指令 > emotion 自动映射**（前端域字段 `emotion`，同帧共存指令 expression 优先发射；state 仍按上述仲裁）。**note（整帧拒后果）**：`.strict()` + 七值 enum 下，携带合法 expression/motion + `state:'error'` 的帧会**整帧拒**（fail-closed）而非仅弃 state 保留其余——决策记录明示此行为，防联调对「后端发 error 帧导致表情也丢」意外。无效/白名单未命中 → 忽略 + **脱敏日志**（落点 = `controller.setExpression/playMotion` 返回 boolean → `live2dStore.handleDirective` 脱敏 warn：不记 payload 原文，仅记 `modelId + 未命中码`；渲染层 console，审计级日志归 Main 为后续增强，本批无新 IPC） | doc 05 §6/§8 + doc 02 §12 校验规则；后端建议仅表现不决策；审查 I-1/I-2：setState 无仲裁（`state-machine` 直接采纳），error 可被注入，「2/3 级自然覆盖」无代码依据 |
| **D5C-08** | **收口 = 批次 A/B deferred 承接**（防御加固，逐条列 §3.4）：**批次 A 决策记录 §6 M-1/M-2/M-4/M-5 + F5（原「Task2 M1-M5」标签有误——批次 B 决策记录 §四沿用了错误标签，本批更正为真实来源批次 A Task2/3 防御项）**：resolveModelFile `%` 同口径（**放宽**——现状 `model-registry.ts` 对含字面 `%` 的 relPath 全拒，改为「仅拒合法 hex 残留 + 解码后同一字符串比对」，防 `%2F`/`%252F` 二次走私）/ registry 强制 `manifest.id===dirname` / integrity 空数组视为不完整（空对象 `{}` 已被 fail-closed 覆盖，真实缺口仅空数组 `files:[]`）/ `reason` 闭合枚举 / decode relPath 单测。+ **批次 B 最终 review F2**（param-anim blink 速率调制：thinking/speaking 加快眨眼，代固定间隔）+ **F3**（有动作但 expressions 空模型情绪态 → B4 参数级近似，门控口径定案）+ **批次 B Task5 M2**（「恢复默认」置 modelId:null 与画布分叉 → restore 后 switchModel 首个可用）+ **批次 B Task6 M2**（mock env parser 单测）/ **M3**（B4 滑块合成事件注释）+ **Task3 M2-M4**（onEvent force 口径注释 / wobbleT 重读时钟 / B4 注释名实相符）。**批次 A F2/F3/F4（协议细节：502 兜底不补 ACAO / net.fetch 404 / withCors Vary）经批次 A 评估无实害，本批不承接，关单**。**N1/N3 已在批次 B 完成（state-source 超时 timers / Panel lerp 回正），本批不重复收口**。需真机的 deferred 归联调清单（批次 B Task5 M1 视线纵轴反相 / **批次 A Task5 P2（Layout 画幅）经批次 B D5B-10 实现后的真机像素复核** / 口型肉眼 / 降帧实测 / sticky emotion 语义观察 / 批次 A 大纹理 8192 真机首帧 / dev 跨源 fetch 冒烟） | 批次 A/B 决策记录 + ledger 真实 deferred；可实现的收口，真机项如实归联调清单 |
| **D5C-09** | **文档 + 联调清单**（C5）：doc05 **§3 接口注记（`reset(modelId?)` 签名扩展 + `live2dStateSource.pushDirective` 落点 + **`playMotion` 扩第三参 durationMs（数值）与 `setExpression`/`playMotion` 返回 boolean + lipSync 门定案（Task5 M3 关闭）**）** + §18 状态表 + doc10/11/16 + README + CLAUDE 状态与计数更新；**doc02 §19 无条件记录 `live2d.directive` 映射**（raw 帧类型 + 前端事件字段映射）；**doc13 交叉 Review 结论**（C3 冻结新 wire 帧，wire 未真发、不触发全量重跑，决策记录注明）；决策记录 `docs/review/2026-08-18-阶段5批次C-决策记录.md`；**联调清单 `docs/review/2026-08-18-阶段5批次C-联调清单.md`**（对齐阶段 3/4 先例：冻结基线【前端 commit + 后端 runtime SHA + Electron 版本 + **protocol 版本占位**】+ 定向复验项 + 自动化门禁复跑 + **遗留说明节** + 三态升「已真实联调」口径）。doc 05 §15 许可发行复核仍 **defer**（发布前事项，本批仅台账记录） | 批次 C 只做代码批次；联调清单是代码批次给联调轮的交接物 |

**对批次 B / doc 05 的显式范围承接**：
- 批次 B 已落 `setMouthLevel` 写入原语 + 口部门（M5）；**C1 补数据源 + 口部写出提升为通用步骤**（审查 C-1：b4Params 只盖 no-motion 模型），不改 lipSync 门语义。
- 批次 B 的 `performanceMode` 四值枚举与持久化已就绪；**C2 只补消费**（FrameBudget）+ GPU 重建 + 可见性收口。
- 批次 B 的 emotion（**前端域字段名 `emotion`，非 `mood`**——`generation.completed.emotion`，doc 02 §19 D-3 记录 raw `mood`→前端 `emotion` 改名）→情绪→表情本地映射已消费真实后端；**C3 是新增的显式指令通道**（后端当前不发，桩化开发）。
- 批次 A/B 决策记录 deferred 逐条在本批 §3.4 承接；真机项如实归联调清单。

**范围外（本批不做）**：真实 Windows Electron REAL 联调（开发者事后，凭 §3.5 联调清单执行）；后端 `live2d.directive` 实发（后端侧，本批只做前端解析/校验/消费 + 桩）；`working/waiting_permission` 状态驱动源（阶段 6 工具）；画布分辨率降级与系统低电量降级（record defer，决策记录承接）；发布许可复核（defer）。

---

## 1. 目标

批次 C（代码批次）目标（一个验收句）：**已加载的 Live2D 模型在 TTS 播放时口部随音量包络开合（口部写出对所有 ready 模型生效，B3 动作后写自然覆盖）；性能四值真实降帧消费且 GPU 丢失自动重建一次后仍失败才落静态头像；后端 `live2d.directive` 建议帧经冻结扁平契约校验后安全映射表现（白名单三层 + 建议强度钳制 + 时长钳制 + 无效忽略脱敏）；批次 A/B 防御遗留收口；产出联调清单供开发者事后真实 Windows Electron 联调升三态。**

拆解为可验证子目标：

1. TTS 播放时口部电平随包络驱动（纯函数单测 + 集成链路，`CYRENE_MOCK_MOUTH_LEVEL` 注入确定性采样），停止/取消归零；
2. `FrameBudget` 按四值真实降帧（纯逻辑单测），GPU 丢失触发一次重建后成功恢复 / 失败落静态头像；
3. `live2d.directive` 扁平冻结帧 → raw-schema → FrameMapper → BackendEventSchema → store 校验 → controller 消费（Mock 驱动全链路 + schema 镜像）；无效指令忽略 + 脱敏日志；
4. 批次 A/B deferred 防御项收口（reason 闭合枚举 / registry 强校验 / 空数组防御 / `%` 同口径 / blink 速率调制 / expressions 空→B4 / restore 分叉等）；
5. 文档同步 + 决策记录 + 联调清单交付；
6. 三态 = **已开发、未联调**。

## 2. 分层架构（批次 B 之上扩展）

```text
CyTtsPlayer（隐藏 <audio>，D-P8）── ttsAudioEl(voiceStore ref) ──► TtsMouthSource（Analyser）
        │  voiceStore.tts.playing（autoReadReply 门）
Live2DStore ── tick() 采样 mouth → controller.setMouthLevel
        │  live2dStore.handleDirective(Live2DDirectiveEvent) → 校验 → stateSource.pushDirective / controller.setExpression/playMotion
live2dStateSource（+ pushDirective 瞬态覆盖：建议强度≤1 与机器自然优先级仲裁【比较基准=建议强度】，复用 N1 超时）
Live2DController（FrameBudget 降帧门 + tick 可见性门 + reset(modelId?) 重建 + 口部门【通用口部写出】+ B3/B4 路由【含 F3 expressions 空→B4】）
Live2DAdapter（Analyser 无关；motion/expr 白名单 + 参数通道不变）
        │  cyrene:// fetch（白名单 = manifest.motions/expressions）
Main：raw-schemas(.strict) → FrameMapper → parseBackendEvent（schema 镜像）→ preload 校验
        mock-backend（CYRENE_MOCK_DIRECTIVE / CYRENE_MOCK_MOUTH_LEVEL 桩）/ real-backend（解析桩 + canary）
        模型注册表（registry 强校验 / reason 闭合 / resolveModelFile % 同口径）
```

信任边界与批次 A/B 相同：renderer 只经 cyrene:// 消费已校验资源；指令/表情/动作一律白名单（controller + adapter assert + Main resolveModelFile 三层）；C3 走既有 BackendEvent → preload → store 分发路径（doc 02 IPC 表 `live2d.directive → Live2D Store`），**不新增 IPC 通道**。

## 3. 组件设计

### 3.1 C1 — TTS 音量口型数据源

- **`mouth-level.ts`（新建，纯函数）**：`computeMouthLevel(rms: number, prevLevel: number, opts): number`——噪声门限（`noiseFloor` 缺省 ~0.02，低于 → 0）；attack/release 一阶平滑（attackMs ~50、releaseMs ~250）；最大变化率钳制；返回 `[0,1]`。单测：门限/攻放不对称/钳制/归零。
- **`tts-mouth-source.ts`（新建，renderer 服务，非纯）**：接口 `MouthLevelSource { attach(el: HTMLAudioElement): void; detach(): void; sample(): number; dispose(): void }`——`attach`：懒建 `AudioContext` + `createMediaElementSource(el)`（**每元素仅一次**，重复 attach 幂等）+ `AnalyserNode({fftSize:256})` + 连 `destination`（`el.volume` 保持播放可闻，口型旁路采样不断播放）；`sample()`：`getFloatTimeDomainData` → 均方根 → 过 `computeMouthLevel`（内部持 prevLevel 平滑态）；`detach`：断开 graph、`suspend()` context、平滑态复位；`dispose`：`close()` context。**可注入**（`createTtsMouthSource(analyserFactory?)`）。
- **接线**：`voiceStore` 增 `ttsAudioEl: Ref<HTMLAudioElement|null>`（CyTtsPlayer `onMounted` 赋值 / `onUnmounted` 清空）。`live2dStore` 持有 `TtsMouthSource` 实例 + watch `[voiceStore.tts.playing, voiceStore.ttsAudioEl]` → playing∧有元素 attach、否则 detach。**采样在 `live2dStore.tick()`**：`const level = mouthSource.sample(); controller.setMouthLevel(level)`（skip 帧语义：FrameBudget 在 controller.tick 内部原子跳过 draw，mouth 电平仍更新——无害，下一渲染帧用最新值）。停止/取消：detach + `sample()` 归 0（`computeMouthLevel(0, prev, …)` 走 release 平滑归零）。
- **口部写出（D5C-02 修正，审查 C-1/R2-D）**：`controller.updateAnimation` 内 **通用口部步骤**——`ParamMouthOpenY` 存在时按 `mouthLevelTarget(this.lipSync && this.autoMotions ? this.mouthLevel : 0, paramIds)` 写入（**所有 ready 模型**，不再限于 `b4Params` no-motion 分支；**以本步骤替换 controller.ts:430-432 旧 M5 门块，不叠加双写**）；随后 `adapter.update()` 的 motion manager **后写覆盖**（相同口部参数动作值赢）。单测用 fake handle 断言「有动作模型电口也被写 + 被动作覆盖」顺序；`lipSync`/`autoMotions` 关时电口写 0 清态（不残留上一帧电平；B3 动作口部不受门，Task5 M3 定案）。
- **集成注入（审查 R2-I5/R2-A 修正）**：`CYRENE_MOCK_MOUTH_LEVEL` env（如 `'step'`/`'sine'`）——**renderer 无法读 env（sandbox），须经 Main→renderer 桥**：Main 读该 env（mock 模式）→ 经既有运行信息水合通道（`getRuntimeInfo`/bootstrap 载荷扩展窄字段 `mockMouthLevel`，仅 mock 模式填充）下发 → `live2dStore` 据此选**合成包络源**（`MouthLevelSource` 假实现返回确定性采样序列）——CI 不依赖真实 Analyser/音频设备（mock TTS 是静音 WAV，RMS≈0 无法断言）。真实 Analyser RMS 准确性归联调肉眼验证。

### 3.2 C2 — 性能降级 + GPU 重建 + 可见性收口

- **`perf.ts`（新建，纯逻辑类）**：`class FrameBudget { constructor(mode, now?, opts?); shouldDraw(now): boolean; setMode(mode); feedCost(costMs): void }`——注入时钟（单测确定性）。规则：
  - `quality`：恒 true（满帧）；
  - `low_power`：距上次 draw ≥ ~33ms 才 draw（30fps 封顶）；
  - `balanced`：按 EMA 帧耗时——`costMs < 8` → 60fps（每 rAF draw）；否则 30fps；
  - `auto`：迟滞自选——EMA cost 连续超阈值（如 > 16ms，N 帧窗口）降档 30fps；连续低（< 8ms）升档 60fps；初始 60fps；**窗口可见性因子由 D5C-05 门覆盖**（FrameBudget 只做帧耗时维度）。
  - 阈值/窗口为 spec 缺省，plan 定具体常数；纯逻辑单测覆盖四值 + 迟滞 + 时钟推进。
- **Controller 消费**：`controller` 持 `FrameBudget`（`setPerformanceMode` 时重建/`setMode`）；`tick()` 首行 `if (!this.visible) return`（D5C-05）→ `if (!budget.shouldDraw(now)) return`（skip 帧：不 updateAnimation、不 adapter.update，**不产生 draw**）→ 执行 tick 并 `budget.feedCost(实测耗时)`。**视线 lerp 在 Panel 侧，skip 帧仍执行**（廉价、保平滑，Panel loop 的 `applyLookTween` 不受 controller skip 影响）。
- **GPU 重建一次（D5C-04）**：`controller.reset(modelId?)`——现有 reset（unload → `adapter.initialize` → list → 首个可用）扩展：`modelId` 有值且仍 available → 重载该模型；否则回退首个可用；失败 → `fallback`。`live2dStore`：`controller.on('device_lost')` → 若 `rebuildGuard` 未置位 → 置位 → `await controller.reset(当前 modelId)` → 成功恢复 `ready` + **重放 settings（autoMotions/lipSync/performanceMode/scale/offset/lookTarget）+ 当前 CharacterState**（复用 init 的重放点，live2d.store.ts 既有 159-162 路径）；失败或 guard 已置位 → 镜像 `fallback`（批次 A 既有）。重建成功后再 device_lost → 仍走一次重建（guard 按「每次 lost 事件一次」，非永久）。**重建路径复用 adapter.initialize，随批次 A Task5 P3 核查半初始化兜底**（§7）。
  - 时序注意（审查 R2-M9）：controller.tick catch 中 **emit('device_lost') 之后** setStatus('fallback')（controller.ts:216-217）——重建路径覆盖该 fallback 镜像；`await` 期间 status 走 fallback→loading→ready，Panel `active` 门（live2dShown∧enabled∧status）在 loading 时**不启 rAF**，需在重建成功后显式重启渲染循环（Panel watch active 或 store 通知）。
- **可见性收口（D5C-05）**：`live2dStore` 在 init/startStop 相关 watcher 处将「布局可见 ∧ enabled」→ `controller.setVisibility(v)`；controller.tick 门消费之（消除 Task5 M4 死面）。Panel rAF 启停保持既有（双层门控无害）。

### 3.3 C3 — 后端 Live2DDirective

- **契约（冻结，扁平帧）**：
  - raw 帧（`shared/contracts/backend.ts` 类型 + `main/transport/protocol-v2/raw-schemas.ts` schema）：`{ type: 'live2d.directive', expression?: string; motion?: string; state?: DirectiveState; priority?: 0|1|2|3; durationMs?: number }`——**扁平**（对齐 doc 02 §4 v2 扁平 wire + §12 形状 + raw-schemas `.strict()` 惯例）；`DirectiveState = 'idle'|'listening'|'thinking'|'speaking'|'happy'|'sad'|'surprised'`（**七值，剔除 error**，D5C-07）。`.strict()` 下**未知字段整帧拒**（fail-closed）+ 脱敏日志。
  - **事件链四件套**（缺任一 → 事件到不了 store）：
    1. `shared/contracts/backend.ts` raw 帧类型 + `raw-schemas.ts` 判别联合成员（`parseRawFrame` 识别 `live2d.directive`）；
    2. `FrameMapper.mapFrame` 分支（`frame-mapper.ts`，raw→BackendEvent，映射表在 doc 02 §19 无条件记录）；
    3. `shared/contracts/events.ts` **扁平前端事件**（与 events.ts 全部成员扁平惯例一致，无 payload 包装）`interface Live2DDirectiveEvent extends BackendEventEnvelope { event: 'live2d.directive'; expression?: string; motion?: string; state?: DirectiveState; priority?: 0|1|2|3; durationMs?: number }` + `BackendEvent` 联合增成员；
    4. `shared/schemas/events.ts` `BackendEventSchema` 增 `Live2DDirectiveEventSchema`（**缺镜像 → preload `parseBackendEvent` 丢弃**，P4-B 先例）。
- **桩**：
  - `mock-backend.ts`：env `CYRENE_MOCK_DIRECTIVE`（JSON payload 字符串，如 `'{"state":"happy","expression":"expressions/F01.exp3.json","priority":1}'`）→ 下一 `generation.completed` 后发射一帧冻结契约 `live2d.directive`（对齐 P4-B env 桥先例：仅 env 设置生效、缺省不发射；非法 JSON 缺省不发射）。parser 复用既有 env 解析器模式（Task6 M2 补单测）。
  - `real-backend.ts`：`live2d.directive` 帧分支——**缺省后端不发**；若收到，按冻结契约解析（严格字段校验），形状不符 → 忽略 + CANARY（漂移 canary 沿用 P4-B）。不主动请求、不 mock 后端无该帧时行为不变。
- **store 消费**：`live2dStore.handleDirective(event: Live2DDirectiveEvent)`（事件经 preload 校验后到达，扁平字段直取）：
  1. 校验（D5C-07）：state ∈ 七值；priority ∈ 0-3 且 **clamp ≤1**（建议强度）；durationMs ∈ [0, 30_000]（对 motion/state 生效时长取 `min(durationMs, MOTION_MAX_MS=15s)`）；expression/motion 路径不校验（controller 白名单兜底）；
  2. `state` → `stateSource.pushDirective(state, clampedStrength, durationMs)`——**建议强度仲裁**：仅当 `clampedStrength（≤1）≥ 当前机器优先级` 才 push；否则丢弃/只记最新；因强度恒 ≤1，指令**永不覆盖** client 2/3 级现实态（thinking/speaking/error/waiting_permission）；指令 state 的自然机器优先级只决定表现（thinking→B4 摆头、speaking→口型）；超时回业务态（复用 N1 机制，error 已剔除故无 3 级注入面）；
  3. `expression` → `controller.setExpression(file)`（返回 boolean：白名单命中执行、未命中 false）；
  4. `motion` → `controller.playMotion(file, clampedPriority, durationMs)`（**playMotion 扩第三参 durationMs（数值）**为批次 C 改动；durationMs 钳制 `min(durationMs, MOTION_MAX_MS)`；返回 boolean 同 expression）；
  5. **脱敏日志落点**：未命中/无效 → `live2dStore` 输出脱敏 warn（不记 payload 原文，仅 `modelId + 未命中码`；渲染层 console，审计级归 Main 为后续增强）；
  6. 全部字段无效 → 忽略 + 脱敏日志（不报错、不影响消息展示）。
- **state-source 扩展**：`live2dStateSource` 增 `pushDirective(state, strength, durationMs?)`——瞬态覆盖（语义同 emotion，建议强度按传入 clamp≤1）：置入 → 重组合 → 到 durationMs 或超时（缺省沿用 N1 ~2s/3s 机制）→ `pushRecomposed()` 回当前业务态。**指令永不覆盖 client 2/3 级**（入口守卫拒绝，见 D5C-07）；client 2/3 级到来时 watch 重组合自然覆盖指令瞬态（**守卫在前、重组合在后**，非「按自然优先级自然覆盖」）。**实现精度**：① 优先级读源 = state-source 自身 `currentState` + 优先级镜像（或注入 `getCurrentPriority` getter，单写者 N2 保证镜像一致）；② pushDirective 置入前**先清既有 emotion/error timer**（对齐 handleCompose 的 timer 管理，防旧 timer 中途 `pushRecomposed` 提前打断指令瞬态）；③ 「丢弃 vs 挂起待降档补发」取**丢弃**（doc 05 §9「只记录最新业务状态，不缓存全部动作」）。

### 3.4 收口 — 批次 A/B deferred 承接（防御加固）

- **M1 resolveModelFile `%` 同口径（放宽，文件归属修正）**：`main/live2d/model-registry.ts:156` 现状对**任何**含字面 `%` 的 relPath 直接拒（`relPath.includes('%')`）——改为「仅拒合法 hex 残留」，白名单匹配用**解码后同一字符串比对**（`%25` 解码出的字面 `%` 放行、`%2F`/`%252F`/非法序列仍拒）；`main/protocol/live2d-path.ts` 只做 parser（协议层已逐段 decode 并拒 `%2F/%5C/%00/%2e%2e`），归属 `model-registry.ts`。补单测（`%25`/`%252F`/非法序列）。
- **M2 registry 强制 `manifest.id===dirname`**：`main/live2d/model-registry.ts` 加载时校验 manifest.id 与目录名一致，不一致 → `available=false`（reason 闭合枚举）。
- **M3 integrity 空数组防御**：`integrity.json` 空数组 `files:[]` → 视为不完整 → unavailable（空对象 `{}` 已被 `integritySchema` fail-closed 覆盖）；顺带修「列表 available=true 但 resolveModelFile 恒 null」的列表/请求可用性不一致。
- **M4 `reason` 闭合枚举**：`shared/contracts/live2d.ts` `Live2DModelSummary.reason?: string` → **`reason?: 'missing_file'|'size_mismatch'|'hash_mismatch'`**（闭合联合 + schema 同步）；消费端随枚举收窄。
- **F2 blink 速率调制**：`param-anim.ts` blink 调度支持状态相关 `rate`（thinking/speaking 间隔缩短，如 ~1.5-4s，代批次 B 固定 2.5-7s）——纯函数签名扩参（可注入时钟），单测断言不同 rate 序列；Controller `updateAnimation` 按当前态传 rate（批次 B F2「thinking 眨眼加快」落地）。
- **F3 有动作但 expressions 空 → B4**：`controller.ts` 情绪态路由——`expressionWhitelist.size === 0`（有动作但无表情）→ 情绪态（happy/sad/surprised）走 **B4 参数级近似**（笑眼/瞪眼等），不做空表情。门控口径在决策记录定案（批次 B 决策记录 §四 F3）。
- **Task5 M2 restore 分叉**：「恢复默认」置 `modelId:null` 后，若已加载模型仍显示而设置已重置 → 语义分叉。修复：restore 后若 modelId 从非 null → null 且当前已加载 ≠ 首个可用 → store `switchModel(首个 available)`（消除分叉；若当前已是首个可用则不重载）。
- **Task6 M2**：mock env parser（`CYRENE_MOCK_EMIT_DELAY_MS` / `CYRENE_MOCK_GENERATION_EMOTION` / `CYRENE_MOCK_DIRECTIVE` / `CYRENE_MOCK_MOUTH_LEVEL`）补单测（缺省/非法/边界）。
- **Task6 M3**：electron-live2d 集成测试 B4 滑块用例的 evaluate 合成事件加注释（headless SwiftShader 合理性说明）。
- **Task3 M2-M4**：onEvent `force('idle')` 可清 3 级瞬态——注释钉死「生产只走 setState（N2），onEvent 为测试/外部命令面」；wobbleT 时钟重读注释；B4「thinking 眨眼加快」注释随 F2 实现改为名实相符。
- **关单行**：批次 A F2/F3/F4（协议细节：502 兜底不补 ACAO / net.fetch 失败映射 404 / withCors `Vary` 替换）经批次 A 评估无实害，本批不承接关单；N1/N3（state-source timers / Panel lerp）批次 B 已完成，不重复收口。
- **归联调清单（本批不修）**：批次 B Task5 M1 视线纵轴反相（需真机肉眼）、批次 A Task5 P2（Layout 画幅，经批次 B D5B-10 实现后）真机像素复核、口型肉眼、降帧实测、sticky emotion 语义观察、批次 A 大纹理 8192 真机首帧、dev 跨源 fetch 冒烟。

### 3.5 文档 + 联调清单

- **文档同步**：doc05 **§3 接口注记**（`reset(modelId?)` 签名扩展 + `live2dStateSource.pushDirective` 落点 + `playMotion` 扩第三参 durationMs 与 `setExpression`/`playMotion` 返回 boolean + lipSync 门定案）+ §18（批次 C 落地状态表）、doc10 §8/状态注记、doc11（如有涉及）、doc16 进度、README/CLAUDE 三态与计数；doc02 §19 映射表**无条件**记录 `live2d.directive`（raw 帧类型 + 前端事件字段映射）；**doc02 §12 同步**——`Live2DDirective.state` 枚举更正为七值（剔除 `error`）并附偏离注记（error=3 必须 client 驱动，D5C-07）；**doc02 §4 张力注记**——raw 帧经 `.strict()` fail-closed 拒未知字段，与「前端事件忽略可选字段」分层（消除 §4「未识别可选字段忽略」与 `.strict()` 整帧拒的口径歧义）；**doc13 处理结论**（C3 冻结新 wire 帧但 wire 未真发，不触发全量交叉重跑，决策记录注明）。
- **决策记录**：`docs/review/2026-08-18-阶段5批次C-决策记录.md`——D5C-01~09 + Rulings + 执行期中途决策（按 /goal 纪律）+ deferred 汇总（画布分辨率降级 / 系统低电量降级 / 真实 RMS / 许可复核 / 真机项）。
- **联调清单**：`docs/review/2026-08-18-阶段5批次C-联调清单.md`——对齐阶段 3/4 先例结构：**冻结基线**（前端 commit + 后端 runtime SHA + Electron 版本 + **protocol 版本占位**）+ **定向复验项**（C1 口型肉眼：TTS 播放嘴动/停止归零；C2 降帧实测：四值帧率观察 + GPU-lost 重建；C3 指令：真实 emotion→情绪→表情路径【后端无 directive 帧时的防御路径】+ 未知帧忽略不崩；**归真机 deferred**：批次 B Task5 M1 视线纵轴反相定案、批次 A Task5 P2（Layout 画幅，经批次 B D5B-10 实现后）像素复核、批次 A 大纹理 8192 真机首帧、dev 跨源 fetch 冒烟、sticky emotion 观察）+ **自动化门禁复跑**（typecheck/lint/test/test:integration/build/check:contract）+ **遗留说明节**（未决项/已知限制留档）+ 三态升「已真实联调」口径。

## 4. 安全设计

- 不变：renderer 只消费 cyrene:// 已校验资源；参数 Id 字符串；动作/表情文件只从白名单。
- **新增面（C3）**：`live2d.directive` 帧——`state` **七值冻结**（`error` 剔除，client 派生态不可注入）；`expression/motion` 白名单三层（controller 本地副本 + adapter `assertMotion/ExpressionAllowed` + Main `resolveModelFile` integrity）；`priority` 客户端钳制 ≤1（建议强度）；`durationMs` 钳制 [0,30_000] 且对 motion 以 15s 硬上限封顶；`.strict()` 未知字段整帧拒（fail-closed）；无效指令忽略 + **脱敏日志**（不记完整 payload，渲染层 console.warn；审计级归 Main 为后续增强，本批无新 IPC）；后端不能提供本地资源路径/URL/脚本（白名单外路径拒绝）。
- **新增面（收口）**：`reason` 闭合枚举（防字符串注入 UI 提示）；registry `manifest.id===dirname`（防目录/清单错配加载）；integrity 空数组视为不完整；resolveModelFile `%` 同口径（解码后同一字符串比对，防 `%` 编码逃逸变体）。
- 无新增 IPC 通道（C3 走既有 `chat:event` push 通道 + preload `parseBackendEvent` 校验）；设置持久化走既有 settings 通道。

## 5. 测试策略

单测（fake adapter/GL + 可注入时钟 + 内存 fixture）：

| 面 | 用例 |
|---|---|
| 包络（C1） | `computeMouthLevel`：噪声门限（<floor→0）、attack/release 不对称平滑、最大变化率钳制、归零（rms=0 沿 release 归 0）、边界 [0,1] |
| 口部写出（C1） | **所有 ready 模型** updateAnimation 写 `ParamMouthOpenY`（有动作 fake 也写）；B3 动作后写覆盖电口顺序（fake handle 断言写入序列：anim 写 → adapter.update 覆盖）；`lipSync` 关 → 电口写 0；`autoMotions` 关 → 写 0 清态（不残留上一帧电平）；旧 M5 门块替换后无双写 |
| FrameBudget（C2） | 四值：quality 恒 draw / low_power 30fps 封顶（注入时钟断言跳过帧） / balanced 60↔30 按 cost 切换 / auto 迟滞升档降档；`setMode` 热切换；skip 不产生 draw |
| GPU 重建（C2） | `reset(modelId?)`：当前可用→重载该模型；不可用→首个可用；initialize 失败→fallback；store device_lost 一次重建 + 防重入（guard）；重建成功重放 settings/CharacterState；重建路径 initialize 半初始化兜底（若批次 A P3 修复落地则断言无半初始化泄漏） |
| 可见性（C2） | `setVisibility(false)` → tick 不 draw（fake 计数）；true 恢复 |
| 指令校验（C3） | state 七值枚举（error/offline/working/waiting_permission 拒绝）；priority clamp ≤1；durationMs 越界 clamp/丢弃（>30s / <0）；`.strict()` 未知字段整帧拒；expression/motion 白名单命中/未命中（返回 boolean + 脱敏日志落点断言）；全无效 → 忽略不抛错 |
| 指令消费（C3） | **pushDirective 建议强度仲裁**：idle(0) 时 happy(1)/thinking(1) 指令 push（表现按指令 state）；speaking(2) 时 happy(1)/thinking(1) 指令**不覆盖**；happy(1) 时 sad(1) 可替换；超时回业务态；expression→setExpression；motion→playMotion(file, priority, durationMs) 且 durationMs 以 min(durationMs, 15000) 生效；**指令 > emotion 自动映射**（同帧共存断言） |
| 指令→事件链（C3） | raw-schema 判别联合识别 `live2d.directive`（合法帧通过 / 未知字段拒 / 类型不符拒）；FrameMapper.mapFrame 分支映射正确；`BackendEventSchema` 镜像**通过**（parseBackendEvent 收得）；**未镜像则丢弃**（负向用例：移除镜像 → preload 丢弃，P4-B 先例） |
| 收口 | reason 闭合枚举 schema；registry manifest.id!==dirname→unavailable；integrity 空数组→unavailable（空对象 fail-closed 回归）；resolveModelFile `%` 同口径（%25 放行 / %2F、%252F、非法序列拒）；blink rate 调制序列；expressions 空→B4；restore modelId:null→switchModel 首个可用；mock env parser（CYRENE_MOCK_* 四枚）缺省/非法/边界 |

集成（Playwright `_electron` + xvfb/SwiftShader，扩 `electron-live2d.spec.ts`）：

| 面 | 用例 |
|---|---|
| 口型链路（C1） | `CYRENE_MOCK_MOUTH_LEVEL` env 注入合成包络 → autoReadReply 驱动 `audio.session.ready` → `setMouthLevel` 被调用且值随合成采样变化；停止 → 归 0。**真实 Analyser RMS 归联调肉眼验证** |
| 性能模式（C2） | 四值切换持久化 + 切换后渲染仍正常（无崩）；`setPerformanceMode('low_power')` → FrameBudget 生效（时序单测覆盖，集成仅断言无回归） |
| GPU 重建（C2） | 触发 `webglcontextlost` → 断言一次重建（status 回 ready 或 fallback）不崩（SwiftShader 下以「不崩 + 状态机合法」为准）；重建成功渲染恢复 |
| 指令消费（C3） | `CYRENE_MOCK_DIRECTIVE` env 注入 → generation.completed 后 → 情绪态/表情/动作被消费（store 状态 + 画布非空断言）；**无效指令**（注入非白名单 expression 或 `state:'working'`）→ 不崩 + 走脱敏路径（doc 05 §16「后端发送未知表情或动作」） |
| 收口回归 | reason 枚举不破坏既有模型列表；restore 默认 → switchModel 首个可用（画布与持久化一致） |

## 6. 验收清单（批次 C 代码批次）

- [ ] TTS 播放时口部随包络开合（注入采样链路断言 + 纯函数单测，**对所有 ready 模型生效**），停止/取消归零；B3 动作后写覆盖顺序钉死；
- [ ] `FrameBudget` 四值真实降帧（纯逻辑单测），GPU 丢失一次重建成功恢复 / 失败落静态头像；`setVisibility` 接线非死面；
- [ ] `live2d.directive` 扁平冻结契约 → raw-schema → FrameMapper → BackendEventSchema 镜像 → store 校验 → controller 消费全链路（Mock 驱动）；`state` 七值（error 不可注入）；建议强度钳制；时长以 15s 封顶；无效/未命中忽略 + 脱敏日志；指令 > emotion；
- [ ] 批次 A/B deferred 防御项收口（reason 闭合 / registry 强校验 / 空数组防御 / `%` 同口径 / blink 速率调制 / expressions 空→B4 / restore 分叉）；
- [ ] 全文档计数/状态同步（doc05 §3+§18 / doc10 / doc11 / doc16 / README / CLAUDE / 决策记录 / 联调清单 / doc02 §12+§19+§4，按既定纪律）；
- [ ] 门禁：**typecheck/lint/单测/集成/build 全绿**；**check:contract 复跑**（C3 新增 `live2d.directive` 属前端超集——后端 contract 未含该帧类型不报错，**预期通过**；如 `frontend_contract` 夹具需同步则一并处理）；
- [ ] 三态 = **已开发、未联调**（真实 Windows Electron 联调由开发者事后按联调清单执行）。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| cyrene:// 上 MediaElementSource 采样静音（自定义协议特例） | D5C-01 记录回退路径（decodeAudioData 全 WebAudio）；集成用 `CYRENE_MOCK_MOUTH_LEVEL` 注入采样断言链路，真实 RMS 归联调 |
| 口部写出提升为通用步骤改变批次 B 行为（有动作模型口部动） | D5C-02 审查 C-1 修正：B3 动作后写自然覆盖（motion 参数后写），无动作模型行为不变；单测固定写入顺序 |
| FrameBudget 时序在 headless SwiftShader 不稳定 | 纯逻辑单测注入时钟全覆盖；集成仅断言无回归 + 持久化 |
| GPU 重建在 SwiftShader 语义差异 | 集成以「不崩 + 状态机合法」为准；真机联调实测重建一次 |
| 重建路径复用 adapter.initialize 遇半初始化（批次 A Task5 P3） | D5C-04 + §7：重建路径核查/修复半初始化兜底（try/finally），单测断言无泄漏 |
| C3 后端当前无 directive 帧 | 冻结契约 + 四件套镜像 + mock 桩 + real 桩 canary 全量开发；联调验证防御路径（未知帧忽略不崩）+ 真实 emotion 路径 |
| `state='error'` 注入被剔除（偏离 doc 02 §12） | D5C-07 决策记录记偏离理由（error 必须 client 驱动）；前端收窄不破坏消息展示 |
| 口部门/B3 覆盖序语义误读 | D5C-02 注释 + 单测固定「motion 后写覆盖」顺序；决策记录留档 |
| deferred 真机项被误标「已修」 | D5C-08 明确真机项归联调清单（视线纵轴 / Layout 像素 / 大纹理 / 口型肉眼 / 降帧实测 / sticky emotion / dev 跨源），代码批次只收口可实现项 |

## 8. 需要记录到最终报告的中途决策（批次 C 执行中若出现）

- 任何对 §0 决策的偏离（如 MediaElementSource 实际回退触发、FrameBudget 常数调整、directive 校验边界、收口项取舍、raw 帧字段名与真实后端差异、error 剔除的联调反馈）均按既定流程：**按推荐执行 → 记入决策记录 → 最终报告汇报**。
