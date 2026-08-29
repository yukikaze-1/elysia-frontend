<script setup lang="ts">
// CyProfileWizard:自定义模型 Profile 向导（阶段 4 批次 A，spec §5.4 + brief Step 7）。
// 安全红线：apiKey 仅存于组件局部 ref（apiKeyRef），绝不写入 store/drafts；提交成功或失败后清空；
// 编辑 custom 不回填已存密钥（仅显示 credentialStatus 提示）。
// 草稿经 modelStore.drafts[draftKey] 读写（'new' 新建 / profile.model 编辑/复制）；关闭向导时 cancelEdit 清理草稿槽，
// 防止 'new' 或重命名后旧 key 残留泄漏。后端 baseUrl 必填；desktop/local_worker 不提供（P4-A 仅 backend）。
import { computed, nextTick, onMounted, ref } from 'vue'
import type { ModelProfile, ModelServiceType } from '@shared/contracts'
import { useModelServiceStore } from '../stores/model-service.store'

const props = defineProps<{
  profile?: ModelProfile       // 有值=编辑/复制；无值=新建
  copyMode?: boolean
  initialType?: ModelServiceType   // 新建时预选类型（来自 pane 当前 tab）
}>()
const emit = defineEmits<{ close: [] }>()

const modelStore = useModelServiceStore()

/** 草稿槽 key：'new'（新建）/ profile.model（编辑与复制——复制改名仍驻原 key，关闭时统一清理） */
const draftKey = computed(() => (props.profile ? props.profile.model : 'new'))

// 同步初始化草稿（setup 期执行，避免首帧 draft 未定义）
if (props.profile && props.profile.source === 'custom') {
  modelStore.startEdit(props.profile)
  if (props.copyMode) modelStore.updateDraft(draftKey.value, { name: `${props.profile.model} 副本` })
} else {
  modelStore.startEdit()
  const t = props.profile?.type ?? props.initialType ?? 'llm'
  modelStore.updateDraft(draftKey.value, { type: t })
}

const draft = computed(() => modelStore.drafts[draftKey.value])

const isEditMode = computed(() => Boolean(props.profile))
const credNote = computed(() => {
  if (!props.profile) return ''
  return props.profile.credentialStatus === 'configured'
    ? '凭据已配置（编辑不回显密钥，留空则保持原密钥）'
    : '凭据未配置'
})

// —— 表单字段（经 store draft 读写；apiKey 除外）——
const typeModel = computed({
  get: () => draft.value?.type ?? 'llm',
  set: (v: ModelServiceType) => modelStore.updateDraft(draftKey.value, { type: v })
})
const nameModel = computed({
  get: () => draft.value?.name ?? '',
  set: (v: string) => modelStore.updateDraft(draftKey.value, { name: v })
})
const baseUrlModel = computed({
  get: () => draft.value?.baseUrl ?? '',
  set: (v: string) => modelStore.updateDraft(draftKey.value, { baseUrl: v })
})
const modelsText = computed({
  get: () => (draft.value?.models ?? []).join(', '),
  set: (v: string) => modelStore.updateDraft(draftKey.value, { models: splitList(v) })
})
const capsText = computed({
  get: () => (draft.value?.capabilities ?? []).join(', '),
  set: (v: string) => modelStore.updateDraft(draftKey.value, { capabilities: splitList(v) })
})
function splitList(v: string): string[] { return v.split(',').map((s) => s.trim()).filter(Boolean) }

// —— apiKey 一次性输入：组件局部 ref，绝不入 store ——
const apiKeyRef = ref('')

const nameInput = ref<HTMLInputElement>()
onMounted(() => { void nextTick(() => nameInput.value?.focus()) })

const testBusy = computed(() => {
  const d = draft.value
  if (!d) return false
  return modelStore.testing[`custom/${d.name.trim()}|connectivity`] === 'running' || modelStore.saving
})
const saveActiveBusy = computed(() => modelStore.saving || (draft.value ? modelStore.activating[draft.value.type] : false))

function validate(): boolean {
  const d = draft.value
  if (!d || !d.name.trim()) {
    modelStore.error = { code: 'VALIDATION', message: '请填写自定义模型名称' }
    return false
  }
  if (!d.baseUrl || !d.baseUrl.trim()) {
    modelStore.error = { code: 'VALIDATION', message: '请填写 Endpoint（baseUrl，以 https:// 开头）' }
    return false
  }
  return true
}

/** 测试并保存：先 connectivity 测试（带局部 apiKey + draft.baseUrl），通过后 saveProfile；失败保留表单（error 已展示）。 */
async function onTestAndSave(): Promise<void> {
  if (!validate()) { apiKeyRef.value = ''; return }
  const d = draft.value!
  const name = d.name.trim()
  const keyInput = apiKeyRef.value
  const baseUrlInput = d.baseUrl?.trim() || undefined   // P4-A final review：新 custom 未持久化 YAML，test 需透传 baseUrl 才能构造请求
  await modelStore.testProfile({ type: d.type, provider: 'custom', model: name }, 'connectivity', keyInput || undefined, baseUrlInput)
  const r = modelStore.testResult[`custom/${name}|connectivity`]
  apiKeyRef.value = ''   // 提交成功/失败后一律清空一次性密钥
  if (r?.ok && !modelStore.error) {
    await modelStore.saveProfile({ ...d, name }, keyInput || undefined)
    if (!modelStore.error) closeWizard()
  }
  // 失败保留表单
}

/** 保存并设为当前：saveProfile 成功后 activate（store 无 makeActive 透传，经两次动作完成）。 */
async function onSaveAndActivate(): Promise<void> {
  if (!validate()) { apiKeyRef.value = ''; return }
  const d = draft.value!
  const name = d.name.trim()
  const keyInput = apiKeyRef.value
  await modelStore.saveProfile({ ...d, name }, keyInput || undefined)
  apiKeyRef.value = ''
  if (!modelStore.error) {
    await modelStore.activate({ id: `custom/${name}`, type: d.type })
    if (!modelStore.error) closeWizard()
  }
}

/** 关闭向导：清理草稿槽（含 'new' 泄漏防护）+ 清 apiKey + 通知 pane 关闭 */
function closeWizard(): void {
  modelStore.cancelEdit(draftKey.value)
  apiKeyRef.value = ''
  emit('close')
}

/** Esc 关闭；stopPropagation 防止冒泡到设置 overlay（先关向导，不关整个设置中心） */
function onKeydown(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') { e.preventDefault(); closeWizard() }
}
</script>

<template>
  <div class="cy-wizard-overlay" role="dialog" aria-modal="true" aria-label="自定义模型向导" @keydown="onKeydown">
    <div class="cy-wizard">
      <header class="cy-wizard-header">
        <strong>{{ profile ? (copyMode ? '复制自定义模型' : '编辑自定义模型') : '添加自定义模型' }}</strong>
        <button class="cy-close-btn" aria-label="关闭向导" @click="closeWizard">✕</button>
      </header>

      <div v-if="modelStore.error" class="cy-ms-error" role="alert">{{ modelStore.error.message }}</div>

      <form class="cy-wizard-form" @submit.prevent="onTestAndSave()">
        <label class="cy-field">
          <span>类型</span>
          <select v-model="typeModel" :disabled="isEditMode" aria-label="模型服务类型">
            <option value="llm">LLM（大语言模型）</option>
            <option value="stt">STT（语音识别）</option>
            <option value="tts">TTS（语音合成）</option>
          </select>
        </label>

        <!-- UII-QQ 设置页批次：表单按「Provider 连接信息 / 模型信息 / capabilities」分区——
             在线获取模型、协议（Chat Completions/Responses）选择等待后端正式契约，本轮不做假实现 -->
        <div class="cy-wizard-group" role="group" aria-label="Provider 连接信息">
          <div class="cy-wizard-group-title">Provider 连接信息</div>
          <label class="cy-field">
            <span>Endpoint（baseUrl）<em class="cy-req">*</em></span>
            <input v-model="baseUrlModel" type="text" placeholder="https://" />
          </label>
          <label class="cy-field">
            <span>apiKey（一次性提交，不保存不回显）</span>
            <input v-model="apiKeyRef" type="password" placeholder="sk-…" autocomplete="off" />
          </label>
          <p v-if="isEditMode" class="cy-wizard-crednote">{{ credNote }}</p>
        </div>

        <div class="cy-wizard-group" role="group" aria-label="模型信息">
          <div class="cy-wizard-group-title">模型信息</div>
          <label class="cy-field">
            <span>名称 <em class="cy-req">*</em></span>
            <input ref="nameInput" v-model="nameModel" type="text" placeholder="例如 my-llm" />
          </label>
          <label class="cy-field">
            <span>模型 ID（逗号分隔，可选）</span>
            <input v-model="modelsText" type="text" placeholder="model-a, model-b" />
          </label>
          <p class="cy-wizard-note">在线获取 Provider 支持的模型列表需要后端正式契约，暂未开放——当前请手动填写模型 ID。</p>
        </div>

        <div class="cy-wizard-group" role="group" aria-label="能力声明">
          <div class="cy-wizard-group-title">能力声明</div>
          <label class="cy-field">
            <span>capabilities（逗号分隔，可选）</span>
            <input v-model="capsText" type="text" placeholder="auth=api_key, stream" />
          </label>
        </div>

        <div class="cy-wizard-actions">
          <button type="button" class="cy-profile-btn" @click="closeWizard()">取消</button>
          <button type="submit" class="cy-profile-btn cy-profile-primary" :disabled="testBusy">
            测试并保存
          </button>
          <button type="button" class="cy-profile-btn cy-profile-activate" :disabled="saveActiveBusy" @click="onSaveAndActivate()">
            保存并设为当前
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.cy-wizard-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;             /* 高于设置 overlay(z-50)：向导是设置中心的子模态 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--cy-overlay);
}
.cy-wizard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(480px, 90vw);
  max-height: 84vh;
  overflow-y: auto;
  padding: 16px;
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
  box-shadow: var(--cy-shadow);
}
.cy-wizard-header { display: flex; align-items: center; justify-content: space-between; }
.cy-wizard-header strong { font-size: 15px; }
.cy-close-btn { padding: 4px 10px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); }
.cy-ms-error { display: flex; align-items: center; gap: 8px; padding: 8px 11px; color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: 10px; font-size: 12px; }
 .cy-wizard-form { display: flex; flex-direction: column; gap: 10px; }
/* UII-QQ 设置页批次：表单分区（Provider 连接 / 模型信息 / 能力声明） */
.cy-wizard-group { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; background: var(--cy-surface-soft); border: 1px solid var(--cy-border); border-radius: 10px; }
.cy-wizard-group-title { color: var(--cy-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.cy-wizard-note { margin: 0; font-size: 11px; color: var(--cy-muted); }
.cy-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--cy-muted); }
.cy-field input, .cy-field select { padding: 7px 9px; border: 1px solid var(--cy-border); border-radius: 9px; background: var(--cy-surface); color: var(--cy-text); font-size: 13px; }
.cy-field select:disabled { opacity: 0.6; }
.cy-req { color: var(--cy-danger); font-style: normal; }
.cy-wizard-crednote { margin: 0; font-size: 11px; color: var(--cy-muted); }
.cy-wizard-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.cy-profile-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 13px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-text); font-size: 12px; }
.cy-profile-btn:disabled { opacity: 0.55; cursor: default; }
.cy-profile-btn:hover:not(:disabled) { background: var(--cy-surface-hover); }
.cy-profile-primary { border-color: var(--cy-accent-strong); color: var(--cy-accent-strong); }
.cy-profile-activate { border-color: var(--cy-accent-strong); color: var(--cy-accent-strong); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
