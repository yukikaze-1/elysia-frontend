<#
.SYNOPSIS
  Cyrene 前端 Windows 首次环境准备与启动脚本。

.DESCRIPTION
  本脚本只做 README「快速开始」里那几条命令，不引入任何额外魔法：
    1. 检查 Node 版本是否满足 package.json 的 engines.node（借助仓库自带 check:node）
    2. 检查 pnpm 版本是否匹配 packageManager
    3. 首次（或缺依赖）时执行 pnpm install --frozen-lockfile
    4. 可选：启动 pnpm dev

  设计取向（刻意的限制）：
  - **不自动安装 fnm / Node / pnpm**。它们要改系统 PATH 或全局包，静默代劳会让新用户
    在出问题时不知道机器被改过什么。脚本只把「该装什么、装哪个版本」讲清楚。
  - **不吞掉失败**。任何一步失败即以非零码退出，并打印下一步该做什么。
  - 版本号单一来源：读 .nvmrc / package.json，不在此硬编码。

.PARAMETER Run
  环境检查与安装通过后，直接执行 pnpm dev。

.PARAMETER SkipInstall
  跳过 pnpm install（确认 node_modules 已是最新时用）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
  仅做环境检查与依赖安装。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Run
  检查 → 安装 → 启动开发环境。
#>
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Err  { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }

function Get-RequiredNodeVersion {
  $nvmrc = Join-Path $repoRoot '.nvmrc'
  if (Test-Path $nvmrc) { return (Get-Content $nvmrc -Raw).Trim() }
  return $null
}

function Get-RequiredPnpmVersion {
  $pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.packageManager -match '^pnpm@(.+)$') { return $Matches[1] }
  return $null
}

Write-Host 'Cyrene 前端 · Windows 环境准备' -ForegroundColor White
Write-Host "仓库: $repoRoot"

# ── 1. Node ────────────────────────────────────────────────────────────────
Write-Step '1/4 Node 版本'
$requiredNode = Get-RequiredNodeVersion
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Err '未找到 node。'
  Write-Host '  安装 Node 版本管理器后重开终端：' -ForegroundColor Yellow
  Write-Host '    winget install Schniz.fnm' -ForegroundColor Yellow
  Write-Host "    fnm install $requiredNode ; fnm use $requiredNode" -ForegroundColor Yellow
  exit 1
}
$currentNode = (& node --version).Trim()
Write-Host "  当前: $currentNode   要求: $requiredNode (.nvmrc) / engines.node 见 package.json"

# 以仓库自带门禁为准（engines 单一来源），避免本脚本与 check:node 判定漂移
& node apps/desktop/scripts/check-node-version.mjs 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Err 'Node 版本不满足要求。'
  $fnm = Get-Command fnm -ErrorAction SilentlyContinue
  if ($fnm) {
    Write-Host "  执行: fnm install $requiredNode ; fnm use $requiredNode" -ForegroundColor Yellow
    Write-Host '  （fnm 是 per-shell 的：每开一个新终端都要重新 fnm use）' -ForegroundColor Yellow
  } else {
    Write-Host '  未检测到 fnm。安装后重开终端：winget install Schniz.fnm' -ForegroundColor Yellow
  }
  exit 1
}
Write-Ok "Node $currentNode 满足要求"

# ── 2. pnpm ────────────────────────────────────────────────────────────────
Write-Step '2/4 pnpm 版本'
$requiredPnpm = Get-RequiredPnpmVersion
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
  Write-Err '未找到 pnpm。'
  Write-Host "  执行: npm install -g pnpm@$requiredPnpm" -ForegroundColor Yellow
  exit 1
}
$currentPnpm = (& pnpm --version).Trim()
if ($requiredPnpm -and $currentPnpm -ne $requiredPnpm) {
  Write-Err "pnpm 版本不匹配：当前 $currentPnpm，要求 $requiredPnpm（package.json 的 packageManager）"
  Write-Host "  执行: npm install -g pnpm@$requiredPnpm" -ForegroundColor Yellow
  exit 1
}
Write-Ok "pnpm $currentPnpm"

# ── 3. 依赖 ────────────────────────────────────────────────────────────────
Write-Step '3/4 依赖安装'
$nodeModules = Join-Path $repoRoot 'node_modules'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'

if ($SkipInstall) {
  Write-Warn '按 -SkipInstall 跳过 pnpm install'
} elseif (Test-Path $nodeModules) {
  # 锁文件可能已更新：--frozen-lockfile 幂等，已最新时只需数百毫秒
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Write-Err 'pnpm install 失败（见上方输出）'; exit 1 }
  Write-Ok '依赖已就绪'
} else {
  Write-Host '  首次安装会下载 Electron 二进制（约 215MB），耗时取决于网络——不是卡住。' -ForegroundColor Yellow
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Write-Err 'pnpm install 失败（见上方输出）'; exit 1 }
  Write-Ok '依赖安装完成'
}

if (-not (Test-Path $electronExe)) {
  Write-Warn '未找到 Electron 二进制（node_modules\electron\dist\electron.exe）——首次运行时会补下载或报错'
}

# ── 4. 提示 / 启动 ─────────────────────────────────────────────────────────
Write-Step '4/4 下一步'
Write-Host '  Live2D 模型不随仓库分发：未装配时角色面板显示「模型不可用」属预期。' -ForegroundColor Yellow
Write-Host '  装配（模型目录需含 model3.json / .moc3 / 至少一张贴图）：' -ForegroundColor Yellow
Write-Host '    pnpm live2d:install --model-dir <目录> --id <slug> --display-name "<显示名>"' -ForegroundColor Yellow
Write-Host '  模型授权见 doc 16 §4.1 的 EXT-01：只装配来源与授权明确的模型。' -ForegroundColor Yellow

if ($Run) {
  Write-Host "`n启动 pnpm dev（Ctrl+C 退出）..." -ForegroundColor Cyan
  & pnpm dev
  exit $LASTEXITCODE
}

Write-Host "`n环境就绪。启动开发环境：" -ForegroundColor Green
Write-Host '  pnpm dev' -ForegroundColor Green
Write-Host '（若这是新开的终端，先跑 fnm use ' -NoNewline; Write-Host $requiredNode -NoNewline; Write-Host '）'
exit 0
