# Cyrene 前端开发环境隔离与资源登记

**文档状态：** 维护中
**最后核验：** 2026-09-12
**适用阶段：** 全阶段开发（含多项目并行开发）；阶段 8 发布基线尚未建立
**权威范围：** 本项目的开发端口分配、Electron 应用身份与 userData 隔离、本地数据落点、运行期版本锁定，以及新增本地服务时的登记规则

---

## 1. 这份文档解决什么问题

本机同时开发、运行多个 Electron 项目，每个项目都可能经 `pnpm dev` 启动。共享的开发资源一旦不做项目级隔离，
故障形态是「随机且难复现」的：端口抢占后静默漂移、两个项目写同一份 `settings.json`、单实例锁互相顶掉、
调试端口号撞车。本文记录**本项目的资源占用与隔离口径**，并给出新增本地服务时必须遵守的规则。

一句话原则：**一个配置值只有一个真正的来源；一个资源只属于一个项目。**

权威来源（本文只登记，不复制实现）：

| 项 | 唯一来源 |
|---|---|
| 开发端口常量与校验 | [`apps/desktop/src/main/config/dev-ports.ts`](../apps/desktop/src/main/config/dev-ports.ts) |
| Vite 端口下发 | [`apps/desktop/electron.vite.config.ts`](../apps/desktop/electron.vite.config.ts)（`renderer.server`） |
| userData 身份与落盘 | [`apps/desktop/src/main/app/lifecycle.ts`](../apps/desktop/src/main/app/lifecycle.ts) |
| userData 子目录创建 | [`apps/desktop/src/main/persistence/user-data-dirs.ts`](../apps/desktop/src/main/persistence/user-data-dirs.ts) |
| 调试开关安全门 | [`apps/desktop/src/main/config/debug-switches.ts`](../apps/desktop/src/main/config/debug-switches.ts) |
| 应用身份（打包） | [`apps/desktop/electron-builder.yml`](../apps/desktop/electron-builder.yml) |

## 2. Application Identity

```text
Package:            @cyrene/desktop（根包名 elysia-frontend，private）
Product:            Cyrene
appId:              com.cyrene.desktop
AppUserModelId:     com.cyrene.desktop
Dev userData:       %APPDATA%\Cyrene-Dev          （Windows）
                    $XDG_CONFIG_HOME/Cyrene-Dev   或 $HOME/.config/Cyrene-Dev（Linux）
                    ~/Library/Application Support/Cyrene-Dev（macOS）
Production userData: %APPDATA%\Cyrene             （打包产物；dev 不再写入此目录）
```

要点：

- **开发态与打包产物彻底分仓**（`Cyrene-Dev` vs `Cyrene`）。此前两者共用同一目录，`pnpm dev` 会直接改写用户
  正式版的连接凭据、`settings.json`、会话与草稿、Live2D 模型目录、日志与审计。
- 风味判定收敛在 `resolveAppDataFlavor(mode, isPackaged)`：**只有「未打包 + `development`」加 `-Dev` 后缀**。
  `--mode test` 不加后缀——集成 harness 已由 `CYRENE_TEST_APP_DATA` 把 appData 覆写到 mkdtemp 临时目录
  （test + harness + 未打包三重门），本身强于后缀隔离，且 `tests/integration/helpers/app.ts` 逐用例断言该路径。
- `app.setName('Cyrene')` **不随风味变化**：诊断导出与窗口标题口径依赖它；身份唯一性由 userData 路径承担。
- **调用顺序是安全不变式**：`installAppIdentity()`（内部 `app.setPath('userData')`）必须在
  `app.requestSingleInstanceLock()` 之前完成。Electron 的单实例锁由 `ProcessSingleton(app.getName(), app.getPath('userData'))`
  构造，**userData 路径是身份的承重项**（Windows 分支：`base::PathService::Get(chrome::DIR_USER_DATA)`）；顺序颠倒会让
  dev 与打包产物（乃至同机另一套 Electron 项目）互相认成同一实例而直接 `exit(0)`。因此 userData 分仓同时也是
  「dev 与正式版可同时运行」的前提（实测：`pnpm dev` 与已装配模型/凭据的正式版互不干扰）。
- 应用名 `Cyrene` 在本机并非全局唯一（另有一套独立的 `Cyrene-Agent` Electron 项目）。因此**不要**依赖名字做隔离；
  需要区分身份时一律看 userData 路径与 `appId`。

## 3. Development Ports

本项目的开发端口段为 **53xx**。

```text
Renderer:            5373   （Vite dev server + HMR WebSocket 同端口；http://127.0.0.1:5373）
Backend:             N/A    —— 本项目不自带后端；5380 为保留号位，不发号（见下）
WebSocket:           N/A    —— 后端 WS 复用后端 origin，前端无独立 WS 服务；5381 保留
MCP/Sidecar:         N/A    —— 无 MCP server、无 Python/Node sidecar；5382 保留
Remote Debugging:    N/A    —— 安全门恒关，见 §5
```

补充说明（这些不是"漏登记"，而是明确的不使用）：

| 资源 | 实际值 | 说明 |
|---|---|---|
| 本机真实后端 Endpoint 默认 | `http://127.0.0.1:8765` | **外部后端**（`elysia-agent` 的 `config.yaml` `server.port`），不属本项目号段；开发默认值登记在 `dev-ports.ts`，可用 `CYRENE_DEV_BACKEND_ORIGIN` 覆盖 |
| 自定义协议 | `cyrene://renderer` | 进程内协议 handler，**不监听端口** |
| IPC | Electron `ipcMain`/`ipcRenderer` | 无端口、无 named pipe |
| 本地数据库 | 无 SQLite / LevelDB / better-sqlite3 | 持久化全部是 userData 下的 JSON 文件 |
| Vite dev server 绑定地址 | `127.0.0.1` | 显式回环 IPv4：不绑 `0.0.0.0`（不暴露局域网、不触发防火墙提示），也不用 `localhost`（Windows 上可能先解析到 `::1` 而连不上） |

### 3.1 端口纪律

1. **固定端口 + `strictPort: true`**。端口被占用时 Vite 明确报错退出（实测 `Error: Port 5373 is already in use`，
   退出码 1），**绝不静默漂到 5374**。共享端口段下静默漂移最危险：主进程拿到的
   `ELECTRON_RENDERER_URL`、文档登记的 origin 与真实调试现场会三处不一致。
2. **单一来源**。`5373` 只在 `src/main/config/dev-ports.ts` 出现一次，由 `electron.vite.config.ts` 展开为
   `renderer.server`。不要在任何其它文件里再写一个端口字面量。
3. **启动期自检**。dev 形态下主进程回读 electron-vite 注入的 `ELECTRON_RENDERER_URL`，与常量比对；
   端口/host 不符即 `fatal` 退出（`assertDevServerOrigin`）。唯一例外是测试 harness
   （`CYRENE_TEST_HARNESS=1`，与调试门同一显式标记）：集成套件用 `port: 0` 起独立 dev server 以免与开发者正在跑的
   `pnpm dev` 抢 5373 —— 该例外**只放宽端口，不放宽回环**。
4. **选号避开高撞车号段**。`5173/5174`（Vite 默认）、`5273`、`3000/3001`、`4173`、`8000`、`8080`、`9222/9223`
   在本机多项目环境下都属高撞车号，已有 `dev-ports.spec.ts` 钉住本项目不使用它们。

### 3.2 给其它 Electron 项目的号段建议

同机并行开发时按项目划分号段，避免「先到先得」：

```text
本项目（elysia-frontend / Cyrene）  53xx    Renderer 5373
Cyrene-Agent（另一套 v1 原型）      5173    Vite 默认（strictPort: false，会静默加一）
```

> 注意 `Cyrene-Agent/vite.config.ts` 未开 `strictPort`，抢占 5173 后会静默切到 5174。本项目固定 5373
> 且开 `strictPort`，两者**不再争抢同一个号**，也不会互相触发对方的静默漂移。

## 4. Runtime

```text
Node:     22.23.0（仓库锁定：.nvmrc + engines ">=22.23.0 <23"）
pnpm:     11.20.0（根 package.json packageManager；pnpm-workspace.yaml 里 engineStrict=true、nodeLinker=hoisted）
Electron: 43.3.0（apps/desktop devDependencies，精确版本）
Vite:     8.2.1（electron-vite 5.x）
```

版本意图：`.nvmrc`、`engines`、`packageManager` 三者一致，`engineStrict` 与 `predev`/`prebuild`/`pretest` 的
`check:node` 共同保证「用错 Node 大版本不会静默跑起来」。多项目并行时这些是**项目级**锁定，
不受其它项目的全局 Node/pnpm 升级影响。Node 大版本升级须单独评估，不随开发隔离改动一起做。

## 5. Remote Debugging / DevTools

```text
Remote Debugging Port:  N/A（不使用，且被安全门拒绝）
DevTools:               F12 / 诊断设置页 devMode 开关（进程内，不占端口）
```

- 任何固定调试端口（含 `9222`、`9223`）都会被 `rejectForbiddenDebugSwitches`
  **在绑定前**拒绝，dev 与打包态一视同仁（安全基线见 doc 07）。
- 唯一放行形态是显式测试标记 `CYRENE_TEST_HARNESS=1` 下的随机端口（`=0` / pipe 语义），供 Playwright harness 使用。
- 因此本项目**不需要**为调试分配固定端口，也不应新增。
- 需要诊断时用项目 harness：

  ```powershell
  pnpm test:integration        # Playwright Electron，临时 appData 隔离；默认静默窗口（不打扰宿主桌面）
  pnpm test:integration:visible # 同上，但窗口真的显示——人工观察窗口/焦点/任务栏行为时用
  pnpm verify:artifact --smoke # 产物冒烟 + fuse 读回
  ```

  静默窗口模式的判据、环境变量与边界模块见
  [测试静默窗口模式决策记录](review/2026-09-12-测试静默窗口模式-决策记录.md)：
  `CYRENE_WINDOW_MODE=silent|visible`（缺省时 harness 进程为 silent），显式 `silent` 在无
  `CYRENE_TEST_HARNESS=1` 的进程里会被拒（dev / 打包产物绝不静默启动）。

## 6. Local Data

全部落点在 userData 之下，**userData 隔离后它们自然隔离**；没有任何绝对路径或公共目录写法。

| 类别 | 开发态落点 | 打包产物落点 | 来源 |
|---|---|---|---|
| 数据库 | 不使用 SQLite/LevelDB；持久化为 JSON 文件 | 同左 | doc 06 |
| config | `<userData>\config\`（`settings.json`、`credentials.json`） | `<userData>\config\` | `user-data-dirs.ts` |
| 会话/草稿缓存 | `<userData>\app-cache\` | 同左 | `session-store.ts` / `character-draft-store.ts` |
| models（Live2D） | `<userData>\models\<id>\` | 同左 | `model-registry.ts` |
| logs | `<userData>\logs\`（JSONL，保留 30 天） | 同左 | `diagnostics/logger.ts` |
| audit | `<userData>\audit\`（JSONL，按天） | 同左 | `diagnostics/audit.ts` |
| temp | `<userData>\temp\`（诊断导出等临时文件） | 同左 | `user-data-dirs.ts` |
| sandbox | `<userData>\sandbox\` | 同左 | `user-data-dirs.ts` |
| sessionData | `<userData>\`（Windows/macOS 即等于 userData；Linux 等同级） | 同左 | Electron 默认派生自 `app.setPath('userData')`——**不单独设置** |
| Chromium 会话 | `<userData>\Session Storage\`、`Local Storage\`、`Network\`、各类 Cache | 同左 | Electron（派生自 `app.setPath('userData')`） |

其中 `<userData>` 在开发态是 `%APPDATA%\Cyrene-Dev`、打包态是 `%APPDATA%\Cyrene`（Linux/macOS 见 §2）。

`sessionData` 这条由集成门禁钉住（`tests/integration/helpers/app.spec.ts`「sessionData 也在隔离根内」+
`helpers/app.ts` 的 fail-closed 校验）：**它不单独 setPath，只跟随 userData**——一旦有人显式改写它到公共目录，
多项目就会共用同一份 HTTP 缓存/Cookies/Service Worker，而只看 userData 断言是发现不了的。

Live2D 模型装配（`pnpm live2d:install`）默认写入**开发目录**，与 `pnpm dev` 一致：

```powershell
pnpm live2d:install --model-dir <目录> --id <slug> --display-name "<显示名>"              # → Cyrene-Dev\models
pnpm live2d:install --model-dir <目录> --id <slug> --display-name "<显示名>" --user-data default  # → Cyrene\models
```

> 迁移提示：开发分仓后，`Cyrene-Dev\models` 初始为空，`pnpm dev` 首次启动时角色面板会显示「模型不可用」——
> 这是预期现象。按上表重新装配到开发目录即可；打包产物用的 `Cyrene\models` 不受影响。

## 7. Notes —— 新增本地服务时的登记规则

新增任何会监听端口的服务（本地 HTTP/WS 代理、sidecar、MCP server、静态服务等）前，先在本节登记，再写代码：

1. **先取号，再实现**。从本项目号段 53xx 内取下一个空闲号位，写进 `src/main/config/dev-ports.ts` 并更新 §3 表格。
   不要在业务代码里就地写端口字面量。
2. **一个号位一个用途**。Renderer 5373 / Backend 5380 / WebSocket 5381 / MCP-Sidecar 5382 是**保留号位**：
   本项目当前没有这些服务，号位空着也不发号给别的用途。
3. **必须支持 `strictPort` 等价语义**：端口被占用时明确报错，不静默换号、不依赖操作系统随机分配。
4. **绑定回环**，除非有明确且经评审的理由需要局域网访问；默认 `127.0.0.1`。
5. **数据写进 userData**，不写绝对路径、不写公共目录（`%TEMP%`、桌面、仓库内 `tmp/`）。
6. **不要为自动化新开调试端口**：用既有 Playwright harness（§5）。
7. **改完更新本文档与 `dev-ports.spec.ts`**：端口段契约由单测钉住，新增号位时同步加断言。

跨项目协作补充：若同一台机器上另一个项目也要用同一个号位，先改本项目的号段，不要靠「谁先启动」决定归属。

## 8. 相关文档

- [doc 07 Electron 安全设计](07-Cyrene-Electron前端安全设计-v0.2.md)：信任边界、自定义协议与调试开关基线。
- [doc 06 状态管理与本地存储设计](06-Cyrene-前端状态管理与本地存储设计-v0.2.md)：userData 下各类数据的契约。
- [doc 17 开发环境与依赖安装记录](17-Cyrene-前端开发环境与依赖安装记录.md)：Windows/Linux 安装、启动与真实后端联调。
- [doc 16 实施任务清单与进度跟踪](16-Cyrene-前端实施任务清单与进度跟踪.md)：当前阶段与最近验证。
