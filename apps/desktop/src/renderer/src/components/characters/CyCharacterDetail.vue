<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CharacterDetail, CharacterStatePolicy } from '@shared/contracts'
import type { PublicError } from '../../utils/public-error'
import { useIdentityStore } from '../../stores/identity.store'
import CyCharacterRevisionList from './CyCharacterRevisionList.vue'
import { characterErrorMessage } from './character-error'

const props = defineProps<{
  detail?: CharacterDetail
  loading?: boolean
  error?: PublicError
  actionError?: PublicError
  remoteAvailable?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{
  back: []
  retry: []
  edit: []
  clone: []
  archive: []
  rollback: [request: { revision: number; statePolicy: CharacterStatePolicy }]
}>()
const identity = useIdentityStore()
type DefaultActionState = 'idle' | 'saving' | 'success' | 'conflict' | 'error'
const defaultActionState = ref<DefaultActionState>('idle')
const defaultActionError = ref<PublicError>()

const isDefault = computed(() => props.detail?.summary.characterId === identity.defaultCharacterId)
const sourceLabel = computed(() => props.detail?.summary.source === 'builtin' ? '内置角色' : '自定义角色')
const isActive = computed(() => props.detail?.summary.status === 'active')
const canClone = computed(() => props.detail?.summary.source === 'builtin' && isActive.value)
const canEdit = computed(() => props.detail?.summary.source === 'custom' && props.detail?.summary.mutable === true && isActive.value)
const canArchive = computed(() => canEdit.value)
const actionErrorMessage = computed(() => characterErrorMessage(props.actionError, '角色操作失败，请稍后重试。'))

watch(() => props.detail?.summary.characterId, () => {
  defaultActionState.value = 'idle'
  defaultActionError.value = undefined
})

watch(() => identity.connectionEpoch, () => {
  defaultActionState.value = 'idle'
  defaultActionError.value = undefined
})

async function setDefault(): Promise<void> {
  const id = props.detail?.summary.characterId
  if (!id || props.remoteAvailable !== true || defaultActionState.value === 'saving' || identity.saveStatus === 'saving') return
  defaultActionState.value = 'saving'
  defaultActionError.value = undefined
  const success = await identity.setDefaultCharacter(id)
  if (success) {
    defaultActionState.value = 'success'
    return
  }
  defaultActionError.value = identity.saveError
  defaultActionState.value = identity.saveStatus === 'conflict' ? 'conflict' : 'error'
}
</script>

<template>
  <section class="cy-character-detail" aria-labelledby="cy-character-detail-title">
    <button type="button" class="cy-back" @click="emit('back')">← 返回角色目录</button>

    <div v-if="loading" class="cy-detail-state" role="status">正在读取角色详情…</div>
    <div v-else-if="error" class="cy-detail-state error" role="alert">
      <strong>详情加载失败</strong>
      <span>{{ error.message }}</span>
      <button type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else-if="detail">
      <header class="cy-detail-header">
        <div class="cy-detail-avatar" :style="detail.summary.presentation.themeColor ? { backgroundColor: detail.summary.presentation.themeColor } : undefined" aria-hidden="true">
          {{ Array.from(detail.summary.displayName)[0] ?? '角' }}
        </div>
        <div class="cy-detail-title">
          <div>
            <h2 id="cy-character-detail-title">{{ detail.summary.displayName }}</h2>
            <span>{{ sourceLabel }}</span>
            <span>revision {{ detail.summary.currentRevision }}</span>
            <span v-if="detail.summary.status === 'archived'">已归档</span>
          </div>
          <p>{{ detail.summary.description || '暂无简介' }}</p>
        </div>
        <div class="cy-detail-actions">
          <button
            v-if="canClone"
            type="button"
            :disabled="busy"
            @click="emit('clone')"
          >{{ busy ? '处理中…' : '克隆并自定义' }}</button>
          <button
            v-if="canEdit"
            type="button"
            :disabled="busy"
            @click="emit('edit')"
          >编辑</button>
          <button
            v-if="canArchive"
            type="button"
            class="danger"
            :disabled="busy || !remoteAvailable"
            @click="emit('archive')"
          >归档</button>
          <button
            v-if="detail.summary.status === 'active'"
          type="button"
          class="cy-default-action"
          :disabled="isDefault || defaultActionState === 'saving' || identity.saveStatus === 'saving' || !identity.profile || remoteAvailable !== true"
          @click="setDefault"
        >
          {{ isDefault ? '当前默认角色' : defaultActionState === 'saving' ? '设置中…' : '设为默认角色' }}
          </button>
        </div>
      </header>

      <div v-if="defaultActionState === 'conflict'" class="cy-detail-notice error" role="alert">档案版本发生冲突，默认角色尚未更新。请先到“我的档案”刷新确认。</div>
      <div v-else-if="defaultActionState === 'error'" class="cy-detail-notice error" role="alert">{{ defaultActionError?.message ?? '设置默认角色失败。' }}</div>
      <div v-else-if="defaultActionState === 'success'" class="cy-detail-notice success" role="status">已设为默认角色。</div>
      <div v-if="actionError" class="cy-detail-notice error" role="alert">{{ actionErrorMessage }}</div>

      <section class="cy-detail-section">
        <h3>基本信息</h3>
        <dl>
          <div><dt>别名</dt><dd>{{ detail.current.aliases.length ? detail.current.aliases.join('、') : '无' }}</dd></div>
          <div><dt>开场白</dt><dd class="preserve">{{ detail.current.openingMessage || '未设置' }}</dd></div>
          <div><dt>角色来源</dt><dd>{{ sourceLabel }} · {{ detail.summary.mutable ? '后续版本可编辑' : '定义只读' }}</dd></div>
        </dl>
        <p class="cy-readonly-note">
          {{ detail.summary.status === 'archived' ? '已归档角色仍可查看既有会话，但不能用于新会话或继续编辑。' : detail.summary.source === 'builtin' ? '内置角色定义保持只读；如需调整，请克隆为自定义角色。' : '自定义角色会以不可变 revision 保存；后续修改会创建新版本。' }}
        </p>
      </section>

      <section class="cy-detail-section">
        <h3>声音与呈现摘要</h3>
        <dl>
          <div><dt>主题色</dt><dd>{{ detail.current.presentation.themeColor || '跟随应用主题' }}</dd></div>
          <div><dt>头像资源</dt><dd>{{ detail.current.presentation.avatarAssetId || '使用名称占位头像' }}</dd></div>
          <div><dt>Live2D 建议</dt><dd>{{ detail.current.presentation.live2dModelId || '未指定' }}</dd></div>
          <div><dt>声音</dt><dd>{{ detail.current.runtimeDefaults.voice.voiceId || '未指定' }}</dd></div>
        </dl>
      </section>

      <details class="cy-prompt-details">
        <summary>查看 authored 人格设定（只读）</summary>
        <div class="cy-prompt-grid">
          <section><h3>核心人格</h3><p>{{ detail.current.promptProfile.corePersonality }}</p></section>
          <section><h3>关系方式</h3><p>{{ detail.current.promptProfile.relationshipStyle }}</p></section>
          <section><h3>情绪风格</h3><p>{{ detail.current.promptProfile.emotionStyle || '未单独设置' }}</p></section>
          <section><h3>表达方式</h3><p>{{ detail.current.promptProfile.speakingStyle }}</p></section>
          <section><h3>对话主动性</h3><p>{{ detail.current.promptProfile.conversationInitiative || '未单独设置' }}</p></section>
          <section v-if="detail.current.promptProfile.examples.length">
            <h3>示例对话</h3>
            <ol>
              <li v-for="(example, index) in detail.current.promptProfile.examples" :key="index">
                <p><strong>我：</strong>{{ example.user }}</p>
                <p><strong>角色：</strong>{{ example.assistant }}</p>
              </li>
            </ol>
          </section>
        </div>
      </details>

      <CyCharacterRevisionList
        :character-id="detail.summary.characterId"
        :current-revision="detail.current.revision"
        :enabled="remoteAvailable === true && detail.summary.source === 'custom' && detail.summary.status === 'active'"
        :busy="busy"
        @rollback="emit('rollback', $event)"
      />
    </template>
  </section>
</template>

<style scoped>
.cy-character-detail { display: flex; flex-direction: column; gap: 13px; min-width: 0; }
.cy-back { align-self: flex-start; border: 0; background: transparent; color: var(--cy-accent-strong); }
.cy-detail-state, .cy-detail-notice { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface-soft); color: var(--cy-muted); font-size: 12px; }
.cy-detail-state.error, .cy-detail-notice.error { color: var(--cy-danger); border-style: dashed; border-color: color-mix(in srgb, var(--cy-danger) 55%, var(--cy-border)); }
.cy-detail-notice.success { color: var(--cy-success); }
.cy-detail-header { display: flex; align-items: flex-start; gap: 13px; min-width: 0; }
.cy-detail-avatar { display: grid; flex: 0 0 54px; width: 54px; height: 54px; place-items: center; border: 1px solid var(--cy-border); border-radius: 16px; background: var(--cy-accent); color: var(--cy-accent-text); font-size: 18px; font-weight: 650; }
.cy-detail-title { flex: 1 1 auto; min-width: 0; }
.cy-detail-title > div { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.cy-detail-title h2 { margin: 0; color: var(--cy-text); font-size: 18px; }
.cy-detail-title span { padding: 1px 7px; border: 1px solid var(--cy-border); border-radius: 999px; color: var(--cy-muted); font-size: 10px; }
.cy-detail-title p { margin: 7px 0 0; color: var(--cy-muted); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.cy-detail-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.cy-detail-actions .danger { color: var(--cy-danger); }
.cy-default-action { flex: 0 0 auto; }
.cy-detail-section, .cy-prompt-details { padding: 13px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface); }
.cy-detail-section h3, .cy-prompt-grid h3 { margin: 0 0 9px; color: var(--cy-text); font-size: 13px; }
dl { display: grid; gap: 8px; margin: 0; }
dl > div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; }
dt { color: var(--cy-muted); font-size: 11px; }
dd { margin: 0; color: var(--cy-text); font-size: 12px; overflow-wrap: anywhere; }
.preserve, .cy-prompt-grid p { white-space: pre-wrap; }
.cy-readonly-note { margin: 10px 0 0; color: var(--cy-muted); font-size: 11px; }
.cy-prompt-details summary { cursor: pointer; color: var(--cy-text); font-size: 13px; font-weight: 600; }
.cy-prompt-grid { display: grid; gap: 12px; margin-top: 13px; }
.cy-prompt-grid section { padding-top: 10px; border-top: 1px solid var(--cy-border); }
.cy-prompt-grid p { margin: 0; color: var(--cy-text); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.cy-prompt-grid ol { display: grid; gap: 10px; margin: 0; padding-left: 20px; }
.cy-prompt-grid li p + p { margin-top: 4px; }
button { padding: 6px 11px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-pane); color: var(--cy-text); font-size: 12px; }
button:disabled { opacity: 0.5; cursor: default; }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) {
  .cy-detail-header { flex-wrap: wrap; }
  .cy-detail-actions { width: 100%; justify-content: flex-start; }
  dl > div { grid-template-columns: 1fr; gap: 3px; }
}
</style>
