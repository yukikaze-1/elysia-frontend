<script setup lang="ts">
// CyLive2DPane:设置中心「角色与外观」子页（阶段 5 批次 B，B5，spec §3.5 / doc 11 §7.1 全量）。
// 镜像 CyVoicePane/CyModelServicesPane 结构；改动即 setLive2d(patch) → settingsStore 500ms 防抖持久化 →
// Panel（常驻挂载）watch 设置变更并即时反映（controller.setAutoMotions/setLipSync/setPerformanceMode/
// setViewTransform；live2dShown 渲染由 Panel/App 既有编排承担）。
// 控件：
//  - enabled 全局开关（Panel onMounted watch：false→true 时重新 init 加载）；
//  - 模型列表：live2dStore.models 按 available 过滤 + preview 缩略图（cyrene:// 供给）+ 状态/错误；
//  - scale/offsetX/offsetY 滑块（D5B-08 安全钳制：scale∈[0.5,3]、offset∈[-2,2]，防模型完全移出画布）；
//  - mouseTracking/autoMotions/lipSync/reduceMotion 开关（lipSync = M5 口型独立门，与 autoMotions 正交）；
//  - performanceMode 四值下拉（doc11 §7.1「帧率」由本下拉承载一一 quality=60/balanced=30-60/low_power≤30/auto=动态，
//    实际降帧消费归批次 C，M-3）；
//  - 恢复默认 → live2d.restoreDefaults()（置 DEFAULT_LIVE2D；modelId 非 null 且已加载 ≠ 首个可用 → 切回首个可用，Task5 M2）。
// 保存失败回退（M-4）：沿用 settingsStore 既有持久化失败语义——保留内存态（即时预览已反映），重启后读回保存态。
import { computed } from 'vue'
import type { Live2DModelSummary, PerformanceMode } from '@shared/contracts'
import { useSettingsStore } from '../stores/settings.store'
import { useLive2dStore } from '../stores/live2d.store'

const settings = useSettingsStore()
const live2d = useLive2dStore()

/** cyrene:// live2d 供给前缀（与 adapter.ts LIVE2D_BASE / main protocol/live2d-path.ts 同一协议分支；
 *  预览图为模型目录内相对路径，经该协议供给）。 */
const LIVE2D_BASE = 'cyrene://renderer/__cyrene-live2d/'
const PERFORMANCE_OPTIONS: Array<{ value: PerformanceMode; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '动态' },
  { value: 'quality', label: '高质量', hint: '~60 帧' },
  { value: 'balanced', label: '均衡', hint: '30-60 帧' },
  { value: 'low_power', label: '低功耗', hint: '≤30 帧' }
]

/** 模型列表：available 过滤（不可用模型由面板下拉展示禁用态，这里只列可切换项） */
const availableModels = computed(() => live2d.models.filter((m) => m.available))

/** 相对 modelId 目录的 relPath → cyrene:// 供给 URL（逐段 encode，与协议层 percent-decode 对齐） */
function previewUrl(m: Live2DModelSummary): string | null {
  if (!m.preview) return null
  const rel = m.preview
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${LIVE2D_BASE}${m.id}/${rel}`
}

function onModelSelect(id: string): void {
  void live2d.switchModel(id) // switchModel 成功后持久化实际生效 id（D5B-10）
}

type L2DToggleKey = 'mouseTracking' | 'autoMotions' | 'lipSync' | 'reduceMotion'
function onToggle(key: L2DToggleKey, e: Event): void {
  settings.setLive2d({ [key]: (e.target as HTMLInputElement).checked })
}

function onEnabled(e: Event): void {
  settings.setLive2d({ enabled: (e.target as HTMLInputElement).checked })
}

function onSlider(key: 'scale' | 'offsetX' | 'offsetY', e: Event): void {
  settings.setLive2d({ [key]: Number((e.target as HTMLInputElement).value) })
}

function onPerformanceMode(e: Event): void {
  settings.setLive2d({ performanceMode: (e.target as HTMLSelectElement).value as PerformanceMode })
}

function restoreDefaults(): void {
  void live2d.restoreDefaults() // Task5 M2（批次 C）：restore 置 modelId:null 后若已加载 ≠ 首个可用 → switchModel 首个可用
}

const statusText = computed(() => {
  switch (live2d.status) {
    case 'ready': return 'Live2D 就绪'
    case 'loading': return '正在加载模型…'
    case 'failed': return '模型加载失败'
    case 'fallback': return '静态头像回退（GPU 不可用）'
    case 'unloaded': return 'Live2D 未加载'
    default: return 'Live2D 未加载'
  }
})
</script>

<template>
  <section class="cy-l2d-pane" aria-label="角色与外观（Live2D）">
    <h3 class="cy-l2d-title">角色与外观</h3>

    <div class="cy-l2d-group">
      <label class="cy-l2d-row">
        <input type="checkbox" :checked="settings.live2d.enabled" @change="onEnabled" />
        <span class="cy-l2d-label">启用 Live2D 角色<small>加载模型并显示在聊天右侧角色栏</small></span>
      </label>
    </div>

    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">模型</h4>
      <div v-if="live2d.error" class="cy-l2d-error" role="alert">{{ live2d.error }}</div>
      <div v-if="live2d.status !== 'ready'" class="cy-l2d-state">{{ statusText }}</div>
      <div v-if="availableModels.length === 0" class="cy-l2d-state">
        暂无可用模型（请先安装/校验模型）
      </div>
      <div v-else class="cy-l2d-models" role="group" aria-label="模型列表">
        <button
          v-for="m in availableModels"
          :key="m.id"
          type="button"
          class="cy-l2d-model"
          :class="{ active: live2d.modelId === m.id }"
          :disabled="!settings.live2d.enabled"
          :aria-pressed="live2d.modelId === m.id"
          @click="onModelSelect(m.id)"
        >
          <img v-if="previewUrl(m)" class="cy-l2d-model-preview" :src="previewUrl(m)!" alt="" />
          <span v-else class="cy-l2d-model-preview cy-l2d-model-nothumb" aria-hidden="true">无预览</span>
          <span class="cy-l2d-model-meta">
            <span class="cy-l2d-model-name">{{ m.displayName }}</span>
            <span class="cy-l2d-model-version">v{{ m.version }}</span>
          </span>
          <span v-if="live2d.modelId === m.id" class="cy-l2d-model-check" aria-hidden="true">✓</span>
        </button>
      </div>
    </div>

    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">表现</h4>
      <label class="cy-l2d-field">
        <span class="cy-l2d-field-label">大小</span>
        <span class="cy-l2d-field-control">
          <input
            type="range"
            min="0.5" max="3" step="0.05"
            :value="settings.live2d.scale"
            :disabled="!settings.live2d.enabled"
            @input="onSlider('scale', $event)"
          />
          <span class="cy-l2d-field-value">{{ settings.live2d.scale.toFixed(2) }}</span>
        </span>
      </label>
      <label class="cy-l2d-field">
        <span class="cy-l2d-field-label">水平偏移</span>
        <span class="cy-l2d-field-control">
          <input
            type="range"
            min="-2" max="2" step="0.05"
            :value="settings.live2d.offsetX"
            :disabled="!settings.live2d.enabled"
            @input="onSlider('offsetX', $event)"
          />
          <span class="cy-l2d-field-value">{{ settings.live2d.offsetX.toFixed(2) }}</span>
        </span>
      </label>
      <label class="cy-l2d-field">
        <span class="cy-l2d-field-label">垂直偏移</span>
        <span class="cy-l2d-field-control">
          <input
            type="range"
            min="-2" max="2" step="0.05"
            :value="settings.live2d.offsetY"
            :disabled="!settings.live2d.enabled"
            @input="onSlider('offsetY', $event)"
          />
          <span class="cy-l2d-field-value">{{ settings.live2d.offsetY.toFixed(2) }}</span>
        </span>
      </label>
      <p class="cy-l2d-hint">安全钳制：大小 0.5–3 倍、偏移 ±2（防模型完全移出画布）</p>
    </div>

    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">互动</h4>
      <label class="cy-l2d-row">
        <input
          type="checkbox"
          :checked="settings.live2d.mouseTracking"
          :disabled="!settings.live2d.enabled"
          @change="onToggle('mouseTracking', $event)"
        />
        <span class="cy-l2d-label">鼠标跟随<small>视线随光标移动，离开后平滑回正</small></span>
      </label>
      <label class="cy-l2d-row">
        <input
          type="checkbox"
          :checked="settings.live2d.autoMotions"
          :disabled="!settings.live2d.enabled"
          @change="onToggle('autoMotions', $event)"
        />
        <span class="cy-l2d-label">自动动作<small>待机眨眼/呼吸与状态动画调度</small></span>
      </label>
      <label class="cy-l2d-row">
        <input
          type="checkbox"
          :checked="settings.live2d.lipSync"
          :disabled="!settings.live2d.enabled"
          @change="onToggle('lipSync', $event)"
        />
        <span class="cy-l2d-label">口型同步<small>说话时嘴部随内容开合（与自动动作共同控制）</small></span>
      </label>
      <label class="cy-l2d-row">
        <input
          type="checkbox"
          :checked="settings.live2d.reduceMotion"
          :disabled="!settings.live2d.enabled"
          @change="onToggle('reduceMotion', $event)"
        />
        <span class="cy-l2d-label">减少动态<small>禁用鼠标跟随与点击动作（减轻晕动）</small></span>
      </label>
    </div>

    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">性能</h4>
      <label class="cy-l2d-field">
        <span class="cy-l2d-field-label">帧率模式</span>
        <select
          :value="settings.live2d.performanceMode"
          :disabled="!settings.live2d.enabled"
          @change="onPerformanceMode"
        >
          <option v-for="p in PERFORMANCE_OPTIONS" :key="p.value" :value="p.value">
            {{ p.label }}（{{ p.hint }}）
          </option>
        </select>
      </label>
    </div>

    <div class="cy-l2d-group cy-l2d-foot">
      <button class="cy-l2d-btn" :disabled="!settings.live2d.enabled" @click="restoreDefaults">恢复默认设置</button>
      <span class="cy-l2d-foot-note">修改即时预览，500ms 自动保存</span>
    </div>
  </section>
</template>

<style scoped>
.cy-l2d-pane { display: flex; flex-direction: column; gap: 16px; }

.cy-l2d-title { margin: 0; font-size: 15px; font-weight: 600; }

.cy-l2d-group { display: flex; flex-direction: column; gap: 9px; padding: 12px 14px; background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: 12px; }
.cy-l2d-sub { margin: 0 0 2px; font-size: 13px; font-weight: 600; color: var(--cy-muted); }

.cy-l2d-row { display: flex; align-items: center; gap: 9px; cursor: pointer; }
.cy-l2d-label { display: flex; flex-direction: column; gap: 1px; color: var(--cy-text); font-size: 13px; }
.cy-l2d-label small { color: var(--cy-muted); font-size: 11px; }

.cy-l2d-field { display: flex; flex-direction: column; gap: 5px; }
.cy-l2d-field-label { color: var(--cy-muted); font-size: 12px; }
.cy-l2d-field-control { display: flex; align-items: center; gap: 10px; }
.cy-l2d-field-control input[type='range'] { flex: 1; min-width: 0; accent-color: var(--cy-accent); }
.cy-l2d-field-value { flex: 0 0 44px; text-align: right; color: var(--cy-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.cy-l2d-field select { width: 100%; padding: 6px 9px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface-soft); color: var(--cy-text); font-size: 13px; }
.cy-l2d-hint { margin: 0; color: var(--cy-muted); font-size: 11px; }

.cy-l2d-models { display: flex; flex-direction: column; gap: 8px; }
.cy-l2d-model {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  border: 1px solid var(--cy-border); border-radius: 10px; background: var(--cy-surface-soft);
  color: var(--cy-text); font-size: 13px; text-align: left;
}
.cy-l2d-model:hover:not(:disabled) { background: var(--cy-surface-hover); }
.cy-l2d-model.active { border-color: var(--cy-accent); background: var(--cy-accent); color: var(--cy-accent-text); }
.cy-l2d-model:disabled { opacity: 0.55; cursor: not-allowed; }
.cy-l2d-model-preview { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex: none; background: var(--cy-surface); }
.cy-l2d-model-nothumb { display: grid; place-items: center; color: var(--cy-muted); font-size: 10px; }
.cy-l2d-model-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cy-l2d-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-l2d-model-version { color: var(--cy-muted); font-size: 11px; }
.cy-l2d-model.active .cy-l2d-model-version { color: inherit; opacity: 0.8; }
.cy-l2d-model-check { margin-left: auto; flex: none; font-weight: 700; }

.cy-l2d-state { padding: 10px 0; color: var(--cy-muted); text-align: center; font-size: 12px; }
.cy-l2d-error { padding: 8px 11px; color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: 10px; font-size: 12px; }

.cy-l2d-foot { flex-direction: row; align-items: center; gap: 12px; }
.cy-l2d-btn { padding: 6px 14px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface-soft); color: var(--cy-text); font-size: 12px; }
.cy-l2d-btn:hover:not(:disabled) { background: var(--cy-surface-hover); }
.cy-l2d-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cy-l2d-foot-note { color: var(--cy-muted); font-size: 11px; }

button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>