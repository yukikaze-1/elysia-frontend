<script setup lang="ts">
// CyModelServicesPane:模型服务页（阶段 4 批次 A，spec §5.4）——LLM/STT/TTS 三 tab + 按 provider 分组 Profile 卡片 +
// 「添加自定义模型」向导 + TTS 声音/试听。挂载即 load() + listVoices()；错误横幅渲染 PublicError.message。
import { computed, onMounted, ref } from 'vue'
import type { ModelProfile, ModelServiceType } from '@shared/contracts'
import { useModelServiceStore } from '../stores/model-service.store'
import CyProfileCard from './CyProfileCard.vue'
import CyProfileWizard from './CyProfileWizard.vue'
import CyTtsVoices from './CyTtsVoices.vue'
import { errorMessage } from '../utils/error-message'

const modelStore = useModelServiceStore()

// 多套 UI 基础：错误文案统一走映射器（store 只产 code）
const errorText = computed(() => errorMessage(modelStore.error, '模型服务操作失败，请稍后重试。'))

const tab = ref<ModelServiceType>('llm')
const TABS: Array<{ key: ModelServiceType; label: string }> = [
  { key: 'llm', label: 'LLM' },
  { key: 'stt', label: 'STT' },
  { key: 'tts', label: 'TTS' }
]

const wizardOpen = ref(false)
const wizardProfile = ref<ModelProfile | undefined>()
const wizardCopy = ref(false)

function openCreate(): void {
  wizardProfile.value = undefined
  wizardCopy.value = false
  wizardOpen.value = true
}
function openEdit(p: ModelProfile): void {
  wizardProfile.value = p
  wizardCopy.value = false
  wizardOpen.value = true
}
function openCopy(p: ModelProfile): void {
  wizardProfile.value = p
  wizardCopy.value = true
  wizardOpen.value = true
}

onMounted(() => {
  void modelStore.load()
  void modelStore.listVoices()
})

/** 按 provider 分组（spec D-A3：内置按 provider 名、custom 归「自定义」组；组内每 model 一条卡片） */
function groupedByProvider(type: ModelServiceType): Array<{ provider: string; label: string; profiles: ModelProfile[] }> {
  const map = new Map<string, ModelProfile[]>()
  for (const p of modelStore.byType(type)) {
    const list = map.get(p.provider) ?? []
    list.push(p)
    map.set(p.provider, list)
  }
  return [...map.entries()].map(([provider, profiles]) => ({
    provider,
    label: provider === 'custom' ? '自定义' : provider,
    profiles
  }))
}

const emptyStateText = computed(() => `暂无 ${TABS.find((t) => t.key === tab.value)?.label ?? ''} Profile，可点击右上角「添加自定义模型」创建`)
</script>

<template>
  <section class="cy-model-services" aria-label="模型服务">
    <div class="cy-ms-top">
      <div class="cy-ms-tabs" role="tablist" aria-label="模型服务类型">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="cy-ms-tab"
          :class="{ active: tab === t.key }"
          role="tab"
          :aria-selected="tab === t.key"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>
      <button class="cy-ms-add" @click="openCreate()">添加自定义模型</button>
    </div>

    <div v-if="modelStore.error" class="cy-ms-error" role="alert">
      <span>{{ errorText }}</span>
      <button class="cy-ms-error-close" aria-label="关闭错误提示" @click="modelStore.error = undefined">✕</button>
    </div>

    <div v-if="modelStore.loading" class="cy-ms-state">正在加载模型 Profile…</div>

    <template v-else>
      <div v-for="g in groupedByProvider(tab)" :key="g.provider" class="cy-ms-group">
        <h3 class="cy-ms-group-title">{{ g.label }}</h3>
        <CyProfileCard
          v-for="p in g.profiles"
          :key="p.id"
          :profile="p"
          @edit="openEdit(p)"
          @copy="openCopy(p)"
        />
      </div>
      <div v-if="groupedByProvider(tab).length === 0" class="cy-ms-state">{{ emptyStateText }}</div>

      <CyTtsVoices v-if="tab === 'tts'" />
    </template>

    <CyProfileWizard
      v-if="wizardOpen"
      :profile="wizardProfile"
      :copy-mode="wizardCopy"
      :initial-type="tab"
      @close="wizardOpen = false"
    />
  </section>
</template>

<style scoped>
.cy-model-services { display: flex; flex-direction: column; gap: var(--cy-space-6); min-height: 0; }
.cy-ms-top { display: flex; align-items: center; justify-content: space-between; gap: var(--cy-space-5); flex-wrap: wrap; }
.cy-ms-tabs { display: flex; gap: var(--cy-space-3); }
.cy-ms-tab { padding: var(--cy-space-2-5) var(--cy-space-7); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-pill); background: var(--cy-surface); color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-ms-tab.active { background: var(--cy-accent); color: var(--cy-accent-text); border-color: var(--cy-accent); }
.cy-ms-add { padding: var(--cy-space-3) var(--cy-space-7); border: 0; border-radius: var(--cy-radius-4-5); background: var(--cy-accent); color: var(--cy-accent-text); font-size: var(--cy-font-md); }
.cy-ms-error { display: flex; align-items: center; gap: var(--cy-space-4); padding: var(--cy-space-4) var(--cy-space-5-5); color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: var(--cy-radius-5); font-size: var(--cy-font-md); }
.cy-ms-error-close { margin-left: auto; padding: var(--cy-space-1) var(--cy-space-4); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3-5); background: var(--cy-surface); color: var(--cy-muted); }
.cy-ms-state { padding: 28px 0; color: var(--cy-muted); text-align: center; font-size: var(--cy-font-lg); }
.cy-ms-group { display: flex; flex-direction: column; gap: var(--cy-space-4); }
.cy-ms-group-title { margin: var(--cy-space-3) 0 0; font-size: var(--cy-font-lg); color: var(--cy-muted); font-weight: 600; }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
