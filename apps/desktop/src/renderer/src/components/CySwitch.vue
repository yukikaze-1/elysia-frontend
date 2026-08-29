<script setup lang="ts">
// CySwitch：布尔功能开关（启用/禁用语义）——替代设置页的方形 checkbox。
// - 原生 <input type="checkbox"> + role="switch" + aria-checked：鼠标/Space 原生支持，
//   Enter 经 keydown 显式切换；Tab/focus-visible 走原生焦点 + 全局 focus-visible 轮廓。
// - 视觉：关闭灰轨左滑块 / 开启蓝轨右滑块 + 滑块内蓝色对勾（纯 CSS，无图片）；~180ms 过渡。
// - 仅用于布尔功能开关；单选（radio）与多选（checkbox 语义组）不使用本组件。
// - 位置：与既有 <label> 行结构兼容（文字说明保持在开关右侧，由外层 label 承担点击切换）。
import { computed } from 'vue'

const props = withDefaults(defineProps<{ modelValue?: boolean; disabled?: boolean; ariaLabel?: string }>(), {
  modelValue: false,
  disabled: false,
  ariaLabel: undefined
})
const emit = defineEmits<{ 'update:modelValue': [boolean]; change: [boolean] }>()

const checked = computed(() => props.modelValue)

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
  emit('change', !props.modelValue)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    toggle()
  }
}
</script>

<template>
  <input
    class="cy-switch"
    type="checkbox"
    role="switch"
    :checked="checked"
    :aria-checked="checked ? 'true' : 'false'"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @change="toggle()"
    @keydown.enter.prevent="onKeydown"
  />
</template>

<style scoped>
.cy-switch {
  appearance: none;
  position: relative;
  flex: 0 0 auto;
  width: 40px;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--cy-border);
  border-radius: 999px;
  background: var(--cy-surface-hover);
  cursor: pointer;
  outline: 0;
  transition: background 0.18s ease, border-color 0.18s ease;
}

/* 滑块（白色圆点，左/右位移） */
.cy-switch::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--cy-surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
  transform: translateY(-50%);
  transition: transform 0.18s ease;
}

/* 开启：蓝色轨道；滑块移到右侧；滑块内显示小型蓝色对勾（纯 CSS 字符，非图片） */
.cy-switch:checked {
  background: var(--cy-accent-strong);
  border-color: var(--cy-accent-strong);
}

.cy-switch:checked::after {
  transform: translateY(-50%) translateX(18px);
}

.cy-switch:checked::before {
  content: '✓';
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--cy-accent-strong);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.cy-switch:focus-visible {
  outline: 2px solid var(--cy-accent-strong);
  outline-offset: 2px;
}

.cy-switch:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
