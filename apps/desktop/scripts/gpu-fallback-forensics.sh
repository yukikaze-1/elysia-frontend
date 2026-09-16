#!/usr/bin/env bash
# apps/desktop/scripts/gpu-fallback-forensics.sh
#
# 用途：在**真实的 Linux 机器**上，为「无 GPU 环境自动回退」这条判据取证。
#
# 为什么需要它：判据（`src/main/config/gpu-mode.ts`：Linux 且 `/dev/dri` 下没有 `card*`/`renderD*`
# ⇒ 应用 `--disable-gpu`）在本机（Windows）**无法验证 Linux 分支的真实表现**，判定矩阵此前只有
# 注入式单测 + 「开关落到了命令行」的集成断言。本脚本把「在一台真正没有 GPU 设备的机器上应该看到
# 什么、要留下哪些原始输出」固定下来，使那台机器上的取证可复现、可比对。
#
# ⚠️ 它能主张什么、不能主张什么（**先读这段**）：
#   · 能主张：**这一台机器、这一次启动**上，判据按预期触发（或未触发），且应用没有因为 GPU 进程
#     崩溃被杀掉。
#   · 不能主张：「无 GPU 的 Linux 已被支持」。单机单次不等于全矩阵；发行版/驱动/会话类型都会变。
#   · 也不能主张：它覆盖了「有 `/dev/dri` 节点但该会话里 GPU 用不了」那一档——**X99 就是这一档**
#     （2026-09-16 实测：`card0/card1/renderD128/renderD129` 齐全、内核已加载 nvidia+amdgpu，而
#     当初测到 GPU 进程在 Mesa 软件光栅器里段错误的就是它）。那一档需要另一套判据，见 doc 09 §8。
#
# 用法：
#   bash apps/desktop/scripts/gpu-fallback-forensics.sh                 # 只采集环境事实与期望值（不启动应用）
#   bash apps/desktop/scripts/gpu-fallback-forensics.sh --launch        # 额外以静默 harness 模式启动一次应用并采日志
#   bash apps/desktop/scripts/gpu-fallback-forensics.sh --launch --timeout 25
# 产物：当前目录下的 `gpu-forensics-<host>-<时间戳>.txt`（原始输出，可直接归档）
# 影响：默认**只读**；`--launch` 会启动一次应用（silent 模式：不显示窗口、不抢焦点、不弹原生对话框），
#       并在超时后结束它。它不会修改仓库、不会写任何全局配置。
set -uo pipefail

LAUNCH=0
TIMEOUT_S=20
while [ $# -gt 0 ]; do
  case "$1" in
    --launch) LAUNCH=1; shift ;;
    --timeout) TIMEOUT_S="${2:-20}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 64 ;;
  esac
done

HOST="$(hostname -s 2>/dev/null || echo host)"
OUT="gpu-forensics-${HOST}-$(date +%Y%m%d-%H%M%S).txt"

# 证据落盘：所有输出同时进 stdout 与文件（bash 进程替换；不可用时退化为只进 stdout，不静默丢证据）
if [ -n "${BASH_VERSION:-}" ]; then exec > >(tee "$OUT") 2>&1; fi

say() { printf '\n=== %s ===\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
say "0. 适用性"
if [ "$(uname -s)" != "Linux" ]; then
  echo "非 Linux（$(uname -s)）⇒ 本脚本不适用：这条判据只在 Linux 分支生效。"
  echo "本次不构成任何取证；证据文件：$OUT"
  exit 2
fi
echo "Linux ✓  host=$HOST  bash=${BASH_VERSION:-unknown}"
echo "证据文件：$OUT"

# ---------------------------------------------------------------------------
say "1. 系统与桌面会话"
( [ -f /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release ) || echo "无 /etc/os-release"
uname -a
echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-<未设>}"
echo "DISPLAY=${DISPLAY:-<未设>}  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<未设>}"
if have systemctl; then systemctl is-system-running 2>/dev/null || true; fi

# ---------------------------------------------------------------------------
say "2. 判据的输入：/dev/dri 与内核 GPU 驱动"
echo "--- ls -l /dev/dri ---"
ls -l /dev/dri 2>&1 || echo "NO_DRI_DIR（/dev/dri 不存在或不可读）"
DRI_NODES="$(ls /dev/dri 2>/dev/null | grep -E '^(card|renderD)[0-9]+$' || true)"
if [ -n "$DRI_NODES" ]; then
  echo "--- 命中判据的设备节点 ---"
  echo "$DRI_NODES"
  EXPECT_DISABLE=0
else
  echo "NO_DEVICE_NODE（没有 card*/renderD* 条目）"
  EXPECT_DISABLE=1
fi
echo "--- lsmod（GPU 相关内核驱动）---"
( have lsmod && lsmod | grep -Ei 'amdgpu|i915|nouveau|nvidia|virtio_gpu|radeon|vmwgfx' ) || echo "（无匹配或不支持 lsmod）"
echo "--- lspci（显示设备）---"
( have lspci && lspci | grep -Ei 'vga|3d|display' ) || echo "（无 lspci 或无匹配）"

# ---------------------------------------------------------------------------
say "3. 期望值（判据算出来的，不是猜的）"
echo "规则（src/main/config/gpu-mode.ts）："
echo "  CYRENE_GPU_MODE=disable            → 强制回退（任意平台）"
echo "  CYRENE_GPU_MODE=auto 或未设 且 Linux 且无设备节点 → 回退，source='no-device-node'"
echo "  其余                                → 不干预，source='default'"
echo "本次环境期望：CYRENE_GPU_MODE=${CYRENE_GPU_MODE:-<未设>}  ⇒ 期望 disableHardwareAcceleration=${EXPECT_DISABLE}"
echo "（注意：这是**由环境事实推出的期望**。实际是否生效，以第 4 节的启动日志为准。）"

# ---------------------------------------------------------------------------
# 标题里的状态用显式分支：`${LAUNCH:+x}${LAUNCH:-y}` 对 LAUNCH=0 会走 `:-`（0 视为"已设"）而打印 "0"，
# 这正是首次在 X99 上跑出来的那处显示缺陷（已修）。
if [ "$LAUNCH" -eq 1 ]; then LAUNCH_LABEL="已请求"; else LAUNCH_LABEL="未请求：加 --launch 才做"; fi
say "4. 应用启动取证（$LAUNCH_LABEL）"
if [ "$LAUNCH" -eq 0 ]; then
  echo "跳过（未传 --launch）。这一步才是「开关真的落到了命令行、且应用没被 GPU 崩溃杀掉」的证据。"
else
  APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  echo "应用目录：$APP_DIR"
  if [ ! -f "$APP_DIR/package.json" ]; then
    # 实测（2026-09-16，脚本被拷到 /tmp 跑时）：`$0` 在别处 ⇒ `..` 会解析成 `/`，接着报一句难懂的
    # "缺 //out/main"。这里显式识别并给出可执行的提示，而不是让人去猜路径。
    echo "⚠️ 该目录下没有 package.json ⇒ 脚本似乎**不在仓库里**（它的真实位置是 apps/desktop/scripts/）。"
    echo "   请从仓库内运行：bash apps/desktop/scripts/gpu-fallback-forensics.sh --launch"
    echo "   （第 4 节跳过；第 0–3 节的环境事实与期望值仍然有效。）"
    APP_DIR=""
  fi
  ELECTRON_BIN=""
  if [ -n "$APP_DIR" ] && [ -x "$APP_DIR/node_modules/electron/dist/electron" ]; then
    ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
  fi
  if [ -z "$APP_DIR" ]; then
    :   # 已给出提示
  elif [ ! -d "$APP_DIR/out/main" ]; then
    echo "缺 $APP_DIR/out/main ⇒ 先构建：pnpm -F @cyrene/desktop exec electron-vite build --mode test"
  elif [ -z "$ELECTRON_BIN" ]; then
    echo "缺 electron 二进制 ⇒ 先：pnpm -F @cyrene/desktop ensure:electron"
  else
    LOG="$(mktemp -t cyrene-gpu-forensics-XXXXXX.log)"
    RUN=(env CYRENE_TEST_HARNESS=1 CYRENE_WINDOW_MODE=silent "$ELECTRON_BIN" "$APP_DIR")
    if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
      if have xvfb-run; then echo "无显示会话 ⇒ 用 xvfb-run -a 包一层"; RUN=(xvfb-run -a "${RUN[@]}")
      else echo "无显示会话且无 xvfb-run ⇒ 无法可靠启动（请装 xvfb 或提供 DISPLAY）"; fi
    fi
    echo "启动命令：${RUN[*]}"
    echo "（silent 模式：不显示窗口、不抢焦点、不弹原生对话框；${TIMEOUT_S}s 后结束）"
    timeout -s TERM "$TIMEOUT_S" "${RUN[@]}" >"$LOG" 2>&1
    echo "退出码：$?（124 = 到点被 timeout 结束，属正常；其它值请结合日志判断）"
    echo "--- stdout 里的关键行 ---"
    grep -E 'gpu:runtime-mode|GPU process|FATAL|segfault|app:started|window:runtime-mode' "$LOG" || echo "（未匹配到关键行）"
    if have journalctl; then
      echo "--- 本次窗口内的内核 segfault/swrast 记录 ---"
      journalctl -k --since "-${TIMEOUT_S} seconds" 2>/dev/null | grep -Ei 'segfault|swrast|dri' | tail -20 || echo "（无匹配或不可读）"
    fi
    echo "--- 应用日志文件里的 gpu:runtime-mode（userData 下 logs/）---"
    find "${HOME}/.config" -maxdepth 3 -path '*Cyrene*logs*' -name '*.log' -newermt "-5 minutes" 2>/dev/null \
      | while read -r f; do echo "[$f]"; grep -h 'gpu:runtime-mode' "$f" | tail -3; done || true
    echo "原始启动日志留存：$LOG"
  fi
fi

# ---------------------------------------------------------------------------
say "5. 本次取证能主张什么"
echo "· 能主张：本节机器/本次启动的判据输入（第 2 节）与期望值（第 3 节）一致；若第 4 节显示"
echo "  'gpu:runtime-mode ... disabled: true, source: no-device-node' 且没有 'GPU process isn't usable'，"
echo "  则该次启动确实以软件渲染启动成功。"
echo "· 不能主张：无 GPU Linux 已被支持（单机单次）；也不能主张覆盖了「有 /dev/dri 但该会话 GPU 不可用」"
echo "  那一档（X99 形态，见 doc 09 §8 的 2026-09-16 补记）。"
echo "· 把 $OUT 归档到 docs/review/ 的对应取证记录里，并在 doc 16 §4.2 把对应条目从 NOT VERIFIED 改成实测结论。"
