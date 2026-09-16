# Cyrene 前端构建、打包与发布设计

**文档状态：** 维护中（阶段 8 恢复前必须复核）
**最后核验：** 2026-08-29
**适用阶段：** 阶段 8
**权威范围：** 构建、产物、签名、发布和回滚设计；不表示阶段 8 已开工
**初始文档日期：** 2026-08-03

> **状态说明：** 正文中的带日期实施/联调注记只代表当时快照；当前阶段、阻塞项和最近验证统一读取 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。

> **阶段 8 当前决策：** 暂缓、尚未进入。恢复条件见 [阶段 8 暂缓决策记录](review/2026-08-29-阶段8暂缓决策记录.md)；本文只保留恢复后需要复核的发布设计基线。

---

## 1. 目标

- 开发、测试和发布环境相互隔离；
- Windows 和 Ubuntu 使用同一代码基线；
- 构建结果可追溯到代码版本；
- 后端地址、协议开关和秘密配置不硬编码；
- 发布包默认关闭开发者模式和 DevTools，永远关闭远程调试端口；如产品允许显式开启开发者模式，仍需通过脱敏和安全检查；
- Demo 可以稳定安装、启动、诊断和卸载。

## 2. 构建基线

建议：

```text
Electron
Vue 3
TypeScript
Vite
electron-builder
pnpm
Vitest
Playwright
```

> **F-11/G-1 裁决（2026-09-15）：打包工具统一为 electron-builder，不切 Electron Forge。**
> 本文原写 `Electron Forge`（与 `docs/10:91`、`docs/13:250`、`docs/19:27` 的 electron-builder 分叉）。
> 裁决理由：全仓 `**/forge.config.*` **0 命中**，打包身份全在 `apps/desktop/electron-builder.yml`，
> `package.json` 依赖是 `electron-builder ^26.15.3`，`scripts/package-app.mjs` 实调 `electron-builder --dir`；
> 而 `verify:artifact` 的 **Fuses 读回断言**（三项 DISABLE）依赖 electron-builder 产物布局，切 Forge 会作废
> 这条已验证链路。⇒ **本文三处 Forge 表述已按裁决改写**；`make` 保持「阶段 8 占位、非零退出」不变。

实际版本在仓库中统一锁定，不在本文写死具体版本号。选型时使用仍处于 Electron 官方支持窗口的稳定版本，并建立升级节奏；升级 Electron、Live2D SDK 或打包工具时单独验证 Windows、Linux、CSP、沙箱、Preload API 和图形兼容性。

## 3. 环境划分

| 环境 | 用途 | 特点 |
|---|---|---|
| development | 本地开发 | DevTools、详细日志、Mock Backend |
| test | 自动化测试 | 固定夹具、临时数据目录 |
| staging | 与测试后端联调 | 接近生产安全配置 |
| production | Demo/正式发布 | 开发者模式默认关闭、无远程调试、固定更新源、最小脱敏日志 |

环境差异通过构建配置和运行时安全配置注入，不通过修改源代码切换。

**已落地（阶段 1 块 A，2026-08-09）：** dev/test/prod 三环境经 electron-vite `define` 构建时烘焙 `__APP_MODE__`（`dev` 默认 development、`build` 默认 production、`build --mode test` 为 test）；运行时 `resolveAppConfig(mode, isPackaged, env)` 纯函数解析——**缺失/未知 mode 一律归 `production`**（不信任 `NODE_ENV` env，防 env 翻转 mode）；`devToolsAllowed = !isPackaged`（打包恒关，与构建 mode 无关），`logLevel` 打包恒 info、非打包可经 `CYRENE_LOG_LEVEL` 白名单覆盖。staging 留阶段 2（B-01 测试环境地址未到位）。

## 4. 配置模型

### 4.1 构建时配置

- 应用名称和 ID；
- 版本和提交号；
- 更新通道；
- 是否允许 DevTools；
- 日志级别上限；
- 功能编译开关；
- CSP 模板；
- Renderer 自定义协议及 Electron Fuses 策略；
- Live2D 内置资源清单。

### 4.2 运行时配置

- 后端地址；
- 用户凭据状态；
- Live2D 和聊天设置；
- 本地缓存上限；
- 非安全功能开关。
- LLM、直接语音 STT、TTS 及输入法转写专用 STT Profile ID；
- 普通录音输入、实时语音会话、字体、强调色和 Live2D 选择；
- 沙盒、黑名单和历史授权由 Main 的安全策略存储管理。

### 4.3 秘密

- 不把 Token 写入 `.env` 后随 Renderer 打包；
- 模型服务密钥不随 Profile 明文打包或返回 Renderer；
- CI 秘密只在需要的发布步骤可见；
- 构建日志不输出秘密；
- 客户端内置的字符串不能当作真正秘密；
- 代码签名凭据由 CI 安全存储管理。

## 5. 构建命令语义

仓库应提供稳定脚本名称，例如：

```text
dev             启动开发环境
typecheck       TypeScript 检查
lint            静态检查
test            单元测试
test:integration 集成测试
test:e2e        端到端测试
package         生成未分发包
make            阶段 8 占位（未实现，非零退出防假绿）
verify:artifact 校验产物内容和安全配置
```

具体命令由项目 `package.json` 实现，开发者不需要记住长参数。

**已落地（阶段 1 块 A，2026-08-09）：**

- `package` = `electron-vite build && node scripts/package-app.mjs` —— **未分发包**（Linux 输出 `dist/linux-unpacked/`，`appId=com.cyrene.desktop`、`productName=Cyrene`、`files:[out/**,package.json]`、`asar:false`、`executableName:Cyrene` 固定 Linux 二进制名）；**全量安装包（asar/NSIS/AppImage）留阶段 8，工具同为 electron-builder**（原文写「Forge 全量安装包」，2026-09-15 按 F-11 裁决改写）；
  > **2026-09-12 变更（P2-4）**：原为直接调 `electron-builder --dir`，现经 `scripts/package-app.mjs` 包装。
  > 唯一原因是评审记录的**已观察偶发**：Windows 上首次打包在 `@electron/fuses` 写 wire 时
  > `ENOENT … Cyrene.exe`，重跑即过（该步骤由 electron-builder 内部执行）。脚本**只**对"ENOENT 且指向
  > `.exe`/`win-unpacked`"这一形态重试一次，其它失败立刻原样失败（不做无条件重试——那会把真实失败
  > 掩盖成"第一次不算"）；发生重试时会显式打印，便于日后核对频率。**注意：本机无法复现该偶发，
  > 故这是依据记录的防御而非实测失败驱动的修复。**
- `verify:artifact` = `node scripts/verify-artifact.cjs` —— 静态检查（out/ 三产物存在、index.html 保留 CSP meta 且无 `unsafe-eval`、`.env`/Token/`Bearer ` 模式扫描、version 可读、未分发包存在时**读回 fuse wire 断言三项 DISABLE**）+ `--smoke` Playwright `_electron` 启动冒烟（优先未分发包，缺失回退 out/；断言协议 `cyrene:`、严格 CSP 响应头、Vue 挂载、`getAppInfo`、普通浏览器 `desktopApi` undefined 信任边界、打包调试门负路径）；
- `make`（**阶段 8 打包入口，工具为 electron-builder**；2026-09-15 前此处写「Forge 打包」）与 `test:e2e` 仍为占位脚本（非零退出防假绿）。

**生产依赖归类（2026-09-12，P2-3）：**

- `dependencies` **只保留 main/preload 运行时会 `require` 的包**，当前为 **`diff` / `ws` / `zod`** 三个。依据是实测而非推断：`out/main/index.js` 的裸 require 集合 = `diff, electron, ws, zod`（其余为 Node 内建），`out/preload/index.js` 只 require `electron`（`zod` 按 `externalizeDepsPlugin({ exclude: ['zod'] })` 显式 bundle）。
- **只被 renderer 使用的包一律放 `devDependencies`**（`vue`/`pinia`/`marked`/`dompurify`）——它们由 Vite 打进 renderer chunk，放进 `dependencies` 只会让 electron-builder 把整棵依赖树**再装一份**进 `resources/app/node_modules`。实测该目录由 **20.87 MB 降到 4.61 MB（−16.26 MB）**，剩余恰为上述三个包；同时核对四个包的代码**仍在 renderer chunk 内**（`createElementBlock`/`createPinia`/`marked`/`DOMPurify` 均命中），故无功能回退。
- **门禁**：`tests/unit/dependency-classification.spec.ts` 双向断言——① `dependencies` 里每个包都必须真被 main/preload 用到（防死重回潮）；② main/preload 用到的包必须在 `dependencies` 里（防打包缺模块）。依据：`externalizeDepsPlugin()` 只外置 `dependencies`，**devDependency 会被 bundle**（实测：临时把 `semver` import 进 main，产物里没有 `require("semver")` 而是内联）。

## 6. 版本策略

应用版本使用语义化版本：

```text
MAJOR.MINOR.PATCH
```

Demo 可以使用 `0.x.y`。每个发布产物同时记录：

- 应用版本；
- Git 提交号；
- 构建时间；
- 构建环境；
- Electron 版本；
- 前端协议版本；
- 内置模型资源版本。

协议版本与应用版本分开，避免小版本升级被误判为协议不兼容。

## 7. Windows 产物

Demo 至少提供一种可安装产物。候选格式根据团队发布方式选择，不在 v0.1 同时维护多套安装器。

需要验证：

- Windows 10/11 x64；
- 安装、覆盖升级和卸载；
- 用户数据目录是否保留；
- 快捷方式和开始菜单；
- 高 DPI；
- 防火墙或安全软件提示；
- 凭据存储；
- 多显示器截图；
- 安装路径包含中文和空格。

正式外部分发前应配置代码签名。内部 Demo 未签名时必须记录系统警告和安装说明。

## 8. Ubuntu 产物

Demo 选择一种主安装格式，并可附加一种便携格式。需要验证：

- Ubuntu 22.04 LTS；
- Ubuntu 24.04 LTS 至少一次兼容验证；
- GNOME、X11 和 Wayland；
- 桌面图标和启动菜单；
- 系统依赖提示；
- Secret Service；
- GPU/软件渲染差异；
- 截图 Portal；
- 安装、升级和卸载后数据目录行为。

不要假设一个 Linux 产物在全部发行版均可工作。

> **支持边界（2026-09-16 审计 P2 / 立项「A + B」的 B 半边，据实写清）：**
> **Linux 侧当前只支持"有硬件 GL 的桌面"，无 GPU 的环境靠自动回退降级为软件渲染；两者都不是"已验证支持"。**
> 逐条事实与口径：
> - 崩溃机制（X99 取证）：无 DRI 时 Mesa 软件光栅器在 GPU 进程里**确定性段错误**，Chromium 重试耗尽后
>   `FATAL: GPU process isn't usable. Goodbye.` **杀掉整个应用**；`--no-sandbox` / `GALLIUM_DRIVER=llvmpipe|softpipe` /
>   `LIBGL_ALWAYS_SOFTWARE=1` 均无效，`--disable-gpu` 与 SwiftShader 有效。
> - **产品侧现在有回退了**：`src/main` 在 `app.whenReady()` **之前**判定——Linux 且探测不到可用 GPU 设备节点
>   （`/dev/dri` 下无 `card*`/`renderD*`）⇒ 自动加 `--disable-gpu`，并写一条 `gpu:runtime-mode` 诊断日志
>   （含 `disabled`/`mode`/`source`/`platform`）。可用 `CYRENE_GPU_MODE=disable` 强制、`=auto` 走自动判定。
>   有设备节点的桌面**行为逐字不变**（不干预）。
> - **但这不等于"无 GPU 的 Linux 已被验证支持"**：回退是启发式（少数有 DRI 但驱动仍崩的环境仍会崩），
>   且**本机是 Windows，无法验证 Linux 分支的真实表现**——判定矩阵由注入式单测覆盖，应用层只验到
>   "开关确实落到了命令行"（集成用例）。真实无 GPU 环境的端到端表现**仍是 NOT VERIFIED**。
> - **2026-09-16 补记（"有 DRI 但驱动仍崩"从 caveat 升级为已实测实例）**：X99 就是这一档，而不是无 GPU 机器
>   ——`/dev/dri/` 下 `card0`/`card1`/`renderD128`/`renderD129` **四个节点齐全**，内核已加载
>   `nvidia`/`nvidia_drm`/`amdgpu`；而**当初测到"GPU 进程在 Mesa 软件光栅器里确定性段错误"的正是这台机器**。
>   故判据（Linux 且**无** `card*`/`renderD*` 才回退）在 X99 上**不触发** ⇒ 产品侧自动回退**覆盖不到
>   我们真正观测到崩溃的那一档环境**；CI 保持绿色靠的是**测试脚手架**注入的 `--disable-gpu`，不是这条产品规则。
>   在拿到覆盖该档的更强判据之前（例如按"GPU 进程异常退出"再重启—禁用这类新机制），**不得**把本回退读作
>   "Linux GPU 崩溃已解决"。
> - **2026-09-16 补充的取证工具与更精确的失败形状**：`apps/desktop/scripts/gpu-fallback-forensics.sh`
>   ——在一台 Linux 机器上采集判据输入（`/dev/dri`、内核 GPU 驱动、`lspci`、会话类型）+ 由规则推出的
>   期望值，可用 `--launch` 额外以 silent harness 模式启动一次应用并抓 `gpu:runtime-mode` 日志。
>   它在**真 Linux（X99）上已实跑验证**（第 0–3/5 节；`--launch` 的引导分支也走到过），
>   **但"启动应用并抓到日志"那一段尚未被任何一次真实运行走到**——需要一台把仓库构建好、
>   有 electron 与显示/xvfb 的机器。
> - 同一次实跑把失败形状钉得更准：X99 是 **`XDG_SESSION_TYPE=tty`、`DISPLAY` 未设**（无桌面会话），
>   而 `lspci` 显示 GTX 1660 Ti + Radeon 都在 ⇒ 真实形状是「**设备与驱动都在、但没有可用显示会话**」
>   ⇒ Electron 走软件光栅器 ⇒ 段错误。这为将来"换一套判据"提示了一个候选方向（判**会话/显示可用性**，
>   而不是只判 `/dev/dri` 节点），但**本版未实现**——属新机制，须另行决策。
> - 上表「GPU/软件渲染差异」一项因此按**部分覆盖**读：拿到的是回退路径的存在性与可诊断性，不是全矩阵验证。


## 9. 应用数据目录

目录根由 Main 在运行时使用 Electron 的用户数据目录能力解析，不写死 `%APPDATA%`、`~/.config`、当前工作目录或安装目录。设置页只通过具名接口获取可展示路径并请求系统文件管理器打开，Renderer 不自行拼接操作系统路径。

应用数据按用途分开：

```text
config/        非敏感版本化设置
app-cache/     可清除会话缓存
logs/          轮转脱敏日志
audit/         脱敏工具记录
temp/          上传和截图临时文件
models/        经验证的模型资源（如允许扩展）
sandbox/       隔离渲染进程（Electron sandbox）用的进程数据目录
```

> **更正（2026-09-14 评审报告 §16.2 G-2）：** 上块原先写的 `cache/` 已更正为 **`app-cache/`**（缓存目录的线上名带 `app-` 前缀），并补上原先漏列的 **`sandbox/`**。两处依据 `src/main/persistence/user-data-dirs.ts:20` 的 `LEAF_NAMES` 常量（`config`／`app-cache`／`logs`／`audit`／`temp`／`models`／`sandbox`，共 7 项，与该接口的 7 个字段 `config`／`appCache`／`logs`／`audit`／`temp`／`models`／`sandbox` 一一对应）。

卸载策略必须明确：程序卸载是否保留用户数据；清除凭据应通过应用内明确操作或卸载选项完成。

## 10. 打包内容控制

发布包只包含：

- 编译后的 Main、Preload、Renderer；
- 运行所需依赖；
- 已获授权的 Live2D 资源；
- 必需许可和声明；
- 平台资源和图标。

不得包含：

- `.env`、Token、测试账号；
- 源码映射中的敏感路径或秘密；
- Mock Backend 数据；
- 开发证书；
- 不需要的测试、示例和临时文件；
- 未获分发授权的模型；
- DevTools 扩展。

## 11. 发布流水线

```text
代码提交
  ↓
安装锁定依赖
  ↓
类型检查 + Lint + 单元测试
  ↓
集成与关键 E2E
  ↓
平台构建
  ↓
产物内容/安全检查
  ↓
签名或完整性校验
  ↓
安装冒烟测试
  ↓
生成校验和、版本说明、已知问题
  ↓
发布到指定渠道
```

Windows 和 Linux 最好在对应操作系统 Runner 上构建和冒烟验证。

## 12. 产物验证

自动检查：

- 文件名和版本；
- 校验和；
- 包内无 `.env`、Token 模式和测试凭据；
- 生产配置默认关闭开发者模式和 DevTools，且未启用远程调试端口；
- CSP 存在；
- Renderer 未通过任意 `file://` 路径加载资源；
- Electron Fuses 与发布安全策略一致；
- Source Map 策略正确；
- 许可文件存在；
- Live2D Manifest 资源完整；
- 应用可以启动到主窗口；
- 版本和提交号可在诊断页查看。

## 13. 自动更新

自动更新可放入 P1，但 v0.1 先确定边界：

- 更新源固定；
- 通过 HTTPS；
- 更新包签名或完整性可验证；
- 支持稳定/测试通道；
- 不允许后端聊天接口动态指定更新 URL；
- 下载失败不破坏当前版本；
- 安装更新前处理正在执行的工具；
- 更新后执行本地数据迁移；
- 提供失败诊断和回退策略。

Demo 阶段如不做自动更新，应使用清晰的手动升级说明。

## 14. 日志和诊断

发布构建保留必要的脱敏日志：

- 应用版本和平台；
- 启动阶段；
- 后端连接状态和错误码；
- 工具状态和耗时；
- Live2D 加载阶段；
- 崩溃摘要。

诊断页支持导出脱敏诊断包，默认不包含聊天正文、文件内容、截图、Token 或敏感路径。

前端日志目录应在设置中可查看和打开。生产构建默认关闭开发者模式；若允许用户开启，应用日志、内置诊断面板和导出包仍必须隐藏凭据、完整消息、Inner Voice、Public Reply、录音和工具原始参数。DevTools 可看到当前渲染内容的风险需单独告知，远程调试端口始终关闭。

## 15. 回滚与兼容

- 每次发布保留前一稳定安装包和校验和；
- 配置迁移前创建可恢复备份；
- 新版本写入的数据结构应记录最低兼容版本；
- 回滚不能把安全凭据导出为明文；
- 协议不兼容时提示升级或降级为普通聊天；
- 数据迁移不可逆时必须在发布说明中明确。

## 16. 发布说明

每次 Demo 发布记录：

- 版本和日期；
- 支持平台；
- 对应后端环境和协议版本；
- 新增与变更；
- 修复；
- 已知问题；
- 安装或升级步骤；
- 文件校验和；
- Live2D 资源和许可说明；
- 日志和反馈方式。

## 17. 发布验收标准

- [ ] 构建来自锁定依赖和干净环境；
- [ ] 类型检查、测试和安全门槛通过；
- [ ] Windows 安装包完成冒烟测试；
- [ ] Ubuntu 安装包完成冒烟测试；
- [ ] 生产包不含秘密、Mock 数据和开发扩展；
- [ ] 生产包默认关闭开发者模式，开启后的诊断信息仍通过脱敏检查；
- [ ] LLM、STT、TTS Profile 及输入法转写专用 STT 选择不泄漏密钥或临时音频；
- [ ] 应用版本、提交号和协议版本可追溯；
- [ ] 安装、升级和卸载行为已记录；
- [ ] Live2D 资源许可随发布检查；
- [ ] Live2D AI/Chatbot/Expandable Application 的发布分类与必要审批结论已留档；
- [ ] 校验和与发布说明已生成；
- [ ] 已知问题和回滚方式明确。

## 2026-09-16 落地注记（A/B/C 批的打包面）

- `verify-artifact.cjs` 新增 **dist 与 out 同源**校验：逐字节比对 `out/{main,preload,renderer}` 与打包产物 `resources/app/out/**`（asar:false 下打包即复制），不一致即红并提示重新 package。
- 打包态承认 harness 需 `CYRENE_PACKAGED_HARNESS=1`（`--smoke` 已设）；冒烟另加端到端断言：只设单变量时调试门仍须拒绝。
- CI 的 `Clean + package` 步骤原先清的是仓库根（no-op），已修到 `apps/desktop/{out,dist}`。
- 详见 [A/B/C 三批决策与变异记录](review/2026-09-16-审计剩余项ABC三批落地-决策与变异记录.md)。
