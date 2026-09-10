# Stage H 真实联调 runner

这里存放可复跑的真实后端 Electron 联调基础设施。它与 `output/playwright/` 的现场证据分离：现场脚本、JSON、截图不应复制回本目录，也不应被 runner 覆盖。

## 当前范围

当前阶段只接入无后端 fixture 的两个自动化场景：

- `preflight`：启动真实 Electron，核对隔离 appData、连接状态、协议/能力、身份、角色目录和会话列表。
- `preview-validation`：选取参数指定或首个 active custom character，验证 draft 校验、preview 无副作用，以及非法保存被拒绝。

为后续阶段预留了 `pinned-follow`、`archive-default`、`tail-isolation` 场景名。它们在后端正式 fixture seed/cleanup 修复前会明确失败，不会假装通过，也不会由前端 runner 修改数据库。

## 前置条件

1. 操作者手动启动后端；runner 绝不启动、停止、重启或代理正式后端。
2. 使用正式入口时，`preintegration:stage-h` 会自动执行 `electron-vite build --mode test`，生成带有 test-mode appData 安全门的 `apps/desktop/out/` 构建产物：

   ```powershell
   pnpm --filter @cyrene/desktop integration:stage-h -- --help
   ```

   这一步即使只查看帮助也会重建 test 产物；不要用普通 `pnpm build` 代替。若直接调用
   `runner.ts`，必须先显式执行 `electron-vite build --mode test`，runner 会拒绝普通
   development/production 构建，避免测试 appData 覆盖静默失效。

3. 指定的 appData 必须由操作者预先创建，是系统临时目录下的独立真实子目录，目录本身不得是符号链接（Windows 示例见下方 `$env:TEMP`/`Join-Path`）。其中必须已经通过桌面客户端/Secret Store 配置好与本次 backend URL 相同端点的凭据；仅创建一个空目录不足以完成连接。token 不作为命令行参数、环境变量或 Playwright 参数传入；Electron Main 从 Secret Store 读取。不要传生产 appData，也不要让 runner 创建或清理这个目录。
4. backend URL 必须与隔离 appData 中保存的凭据绑定一致。若已有绑定指向另一地址，runner 会拒绝自动切换，避免清除凭据。

## 运行

PowerShell 示例分为“准备路径”和“运行”两步。路径由当前机器的 `$env:TEMP` 推导，不要使用生产 appData：

```powershell
# —— 准备路径 ——
$stageHAppData = Join-Path $env:TEMP 'cyrene-stage-h-ud'
$stageHEvidence = Join-Path $env:TEMP 'cyrene-stage-h-evidence'

# appData 必须在运行 runner 前已经存在，并已通过桌面客户端配置
# http://127.0.0.1:8765 对应凭据；仅 New-Item 创建空目录不能完成连接。
if (-not (Test-Path -LiteralPath $stageHAppData -PathType Container)) {
  throw "请先准备并配置隔离 appData：$stageHAppData"
}
New-Item -ItemType Directory -Force -Path $stageHEvidence | Out-Null

$env:STAGE_H_BACKEND_URL = 'http://127.0.0.1:8765'
$env:STAGE_H_APP_DATA = $stageHAppData
$env:STAGE_H_OUTPUT_DIR = $stageHEvidence

# —— 运行 ——
pnpm --filter @cyrene/desktop integration:stage-h -- `
  --scenario preflight

pnpm --filter @cyrene/desktop integration:stage-h -- `
  --scenario preview-validation `
  --character-id '<active-custom-character-id>' `
  --evidence-file preview.json
```

也可以全部使用参数：

```powershell
pnpm --filter @cyrene/desktop integration:stage-h -- `
  --scenario preflight `
  --backend-url 'http://127.0.0.1:8765' `
  --app-data $stageHAppData `
  --output-dir $stageHEvidence
```

查看帮助和场景：

```powershell
pnpm --filter @cyrene/desktop integration:stage-h -- --help
pnpm --filter @cyrene/desktop integration:stage-h -- --list-scenarios
```

失败、断言未通过、Electron 关闭失败或证据写入失败均返回非零退出码。每次成功或失败（只要输出目录可写）都会写一份 `stage-h-evidence-v1` 脱敏摘要，包含场景、开始/结束时间、前端 commit、后端协议/版本/build SHA、检查项和 `passed`。

## 参数与安全边界

- URL、隔离 appData、证据输出目录、角色/会话/实例 ID、marker 都是参数或环境变量；仓库不写死现场 ID、用户路径或 token。
- `output/playwright/` 被列为禁止输出目录，原有现场 JSON/截图不会被覆盖或纳入提交。
- `--backend-commit`/`STAGE_H_BACKEND_COMMIT` 表示期望值：握手或场景解析出的真实 build SHA 必须与它相等，否则检查失败；证据同时保留实际 SHA 和期望 SHA，runner 不会用期望值覆盖实际值。
- marker 只接受短的 ASCII 不透明标识符（不是自然语言或凭据）；如果后端把 marker 回显到回复、错误或清理异常，证据边界仍会精确脱敏。证据对 token、Bearer、凭据字段、绝对路径和 opaque ID 做脱敏；ID 只保留不可逆短 hash。
- 临时资源统一通过 `CleanupStack` LIFO 清理。未来代理、端口转发、子进程必须注册到同一栈，并在 `finally` 中关闭；本阶段 runner 只需清理 Electron。
- 当前 runner 不提供 `--token`，也不读取 `STAGE_H_ACCESS_TOKEN`；历史脚本若需要调试 API 的 token，不应被迁移进正式 runner。

## 与其他验收工作的边界

| 类型 | 入口/责任 | 当前状态 |
|---|---|---|
| 自动化回归 | 本目录 runner；后端已启动、appData 和凭据由操作者准备 | `preflight`、`preview-validation` |
| 后端 fixture | 后端仓库正式 seed/cleanup；前端 runner 后续消费公共 API | `pinned-follow`、`archive-default`、`tail-isolation` 预留 |
| 人工 UI 场景 | 操作者按联调清单检查设置页、连接提示、角色编辑和重连体验 | 不由本 runner 代替 |

轻量基础设施测试：

```powershell
pnpm --filter @cyrene/desktop test:stage-h-runner
```

该测试只覆盖参数校验、输出目录保护、脱敏、generationId 关联、失败判定和资源清理，不连接真实后端，也不修改数据库。
