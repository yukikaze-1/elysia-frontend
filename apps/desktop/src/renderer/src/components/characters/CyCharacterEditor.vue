<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { CharacterDetail, CharacterDraft, CharacterStatePolicy, CharacterValidationResult } from '@shared/contracts'
import type { PublicError } from '../../utils/public-error'
import { useCharacterEditorStore } from '../../stores/character-editor.store'
import { characterErrorMessage } from './character-error'
import CyCharacterPromptFields from './CyCharacterPromptFields.vue'
import CyCharacterPresentationFields from './CyCharacterPresentationFields.vue'
import CyCharacterValidation from './CyCharacterValidation.vue'
import CyCharacterPreview from './CyCharacterPreview.vue'

const props = defineProps<{ detail?: CharacterDetail; busy?: boolean }>()
const emit = defineEmits<{ back: []; saved: []; reload: [] }>()
const editor = useCharacterEditorStore()

const modeLabel = computed(() => {
  if (editor.mode === 'create') return '新建角色'
  if (editor.mode === 'clone') return '克隆并自定义'
  return '编辑角色'
})
const baselineLabel = computed(() => editor.mode === 'create'
  ? '尚未创建远端角色'
  : `基线 revision ${editor.baseRevision ?? '未知'}`)
const saveDisabled = computed(() => !editor.hasEditor || !editor.dirty || editor.saveStatus === 'saving' || props.busy === true || !editor.remoteAvailable)
const saveError = computed<PublicError | undefined>(() => editor.saveError ?? editor.persistenceError)
const saveErrorMessage = computed(() => characterErrorMessage(saveError.value, '保存失败，请检查校验结果后重试。'))
const validationErrorMessage = computed(() => characterErrorMessage(editor.validationError, '角色校验失败，请稍后重试。'))
const conflictMessage = computed(() => characterErrorMessage(
  editor.conflict ? { code: 'BACKEND_REJECTED', backendCode: editor.conflict.backendCode, message: editor.conflict.message } : undefined,
  '远端角色已被更新，当前草稿未覆盖远端内容。'
))

// 原生约束拦截的非空提示与就地校验结果。
//
// 2026-09-10 修复：表单原先把保存的反馈完全交给浏览器原生约束校验，而本表单的无效字段
// 可能藏在折叠的 `<details>`（高级：主动对话）里——Chrome 既不展开该区域，也不移动
// 焦点，控件仍在 `display:none` 子树中导致原生气泡无处渲染。用户看到的是「点保存没反应
// 且零提示」。表单加 `novalidate` 后原生气泡消失，因此这里必须自己把原因说出来。
const blockedMessage = ref('')
const localValidation = ref<CharacterValidationResult>()

/** 表单里可参与约束校验的控件 */
type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

/** 字段级原生约束原因的可读说明 */
const NATIVE_REASON: Record<string, string> = {
  valueMissing: '为必填项',
  rangeUnderflow: '小于允许的最小值',
  rangeOverflow: '大于允许的最大值',
  stepMismatch: '不是允许的步进值',
  typeMismatch: '格式不正确',
  patternMismatch: '格式不正确',
  tooLong: '超出长度上限',
  tooShort: '短于长度下限',
  badInput: '不是有效数值'
}

/** 相对表单的字段定位（标签文本 + 字段名），不依赖任何选择器 */
function fieldLabel(control: FormControl): string {
  const name = control.getAttribute('data-field-path') ?? control.getAttribute('name') ?? '未知字段'
  const wrapper = control.closest('label')
  const text = wrapper?.querySelector('span')?.textContent?.trim().replace(/\s*\*\s*$/, '') ?? ''
  return text ? `${text}（${name}）` : name
}

/** 失败字段藏在折叠区时先展开，使错误信息可见（与 focusPath 同一策略） */
function revealInvalid(target: HTMLElement): void {
  target.closest('details')?.setAttribute('open', '')
}

/**
 * 提交前检查未通过的原生约束。
 *
 * `novalidate` 抑制的是「浏览器在提交时自动校验并弹气泡」，`checkValidity()` 触发的
 * `invalid` 事件仍然会派发（见 HTML 规范 form 提交算法的 interactivity 分支），
 * 因此这里仍能拿到精确的失败字段。
 */
function checkNativeBlock(form: HTMLFormElement): boolean {
  const invalid = new Set<FormControl>()
  const onInvalid = (event: Event): void => {
    // 捕获阶段挂在 form 上，因此 currentTarget 恒为 form、target 恒为失败控件
    invalid.add(event.target as FormControl)
    event.preventDefault() // 关掉浏览器自带的「第一个无效字段」气泡
  }
  form.addEventListener('invalid', onInvalid, true)
  const valid = form.checkValidity()
  form.removeEventListener('invalid', onInvalid, true)
  if (valid) {
    blockedMessage.value = ''
    localValidation.value = undefined
    return false
  }
  const issues: CharacterValidationResult['issues'] = []
  let first: FormControl | undefined
  // first 取第一个失败控件（不要求它有 data-field-path）；issues 只登记能定位的字段。
  // 两者分开的理由：提示（含展开折叠区）必须覆盖所有失败控件，否则会回到「静默不保存」——
  // 那正是本次修复要消灭的失效模式。
  for (const control of invalid) {
    first ??= control
    const path = control.getAttribute('data-field-path')
    const reasons: string[] = []
    if (control.validity.valueMissing) reasons.push(NATIVE_REASON.valueMissing)
    if (control.validity.rangeUnderflow || control.validity.rangeOverflow) {
      const bound = control.validity.rangeUnderflow ? control.getAttribute('min') : control.getAttribute('max')
      reasons.push(`${control.validity.rangeUnderflow ? '不能小于' : '不能大于'} ${bound ?? ''}`.trim())
    }
    for (const key of ['stepMismatch', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'badInput'] as const) {
      if (control.validity[key]) reasons.push(NATIVE_REASON[key])
    }
    if (path) issues.push({ severity: 'error', code: 'NATIVE_CONSTRAINT', path, message: reasons.join('、') || '不符合输入要求' })
  }
  blockedMessage.value = first
    ? `${fieldLabel(first)} 不符合输入要求，已阻止保存：请修正后重试。`
    : '表单存在不符合输入要求的字段，已阻止保存：请检查后重试。'
  if (first) revealInvalid(first)
  localValidation.value = { valid: false, issues }
  return true
}

function updateField(path: string, value: unknown): void {
  // Store.updateField deliberately refuses to create arbitrary object keys. The
  // editor still needs to author optional contract fields, so add only this
  // explicit allow-list through updateDraft (never accept an arbitrary path).
  const draft = editor.draft
  if (!draft) return
  if (path === 'openingMessage') {
    editor.updateDraft({ openingMessage: typeof value === 'string' && value ? value : undefined })
    return
  }
  const optionalPaths = new Set([
    'runtimeDefaults.voice.providerId', 'runtimeDefaults.voice.voiceId',
    'presentation.avatarAssetId', 'presentation.live2dModelId', 'presentation.themeColor'
  ])
  if (optionalPaths.has(path)) {
    const [group, section, field] = path.split('.')
    if (group === 'runtimeDefaults' && section === 'voice' && field) {
      editor.updateDraft({ runtimeDefaults: { ...draft.runtimeDefaults, voice: { ...draft.runtimeDefaults.voice, [field]: typeof value === 'string' && value ? value : undefined } } })
    } else if (group === 'presentation' && section) {
      editor.updateDraft({ presentation: { ...draft.presentation, [section]: typeof value === 'string' && value ? value : undefined } })
    }
    return
  }
  editor.updateField(path, value)
}

function updateBasic(path: keyof CharacterDraft, event: Event): void {
  updateField(path, (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}

function updateAliases(event: Event): void {
  const aliases = (event.target as HTMLInputElement).value.split(',').map((item) => item.trim()).filter(Boolean)
  updateField('aliases', aliases)
}

function aliasesValue(): string {
  return editor.draft?.aliases.join(', ') ?? ''
}

async function validate(): Promise<void> {
  try { await editor.validate() } catch { /* Store exposes the safe public error. */ }
}

function pathSegments(path: string): string[] {
  const source = path.trim()
  if (!source) return []
  if (source.startsWith('/')) {
    return source.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).filter(Boolean)
  }
  return source.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
}

function focusPath(path: string): void {
  const issue = pathSegments(path)
  if (issue.length === 0) {
    document.querySelector<HTMLElement>('.cy-character-editor-form')?.focus()
    return
  }
  const fields = [...document.querySelectorAll<HTMLElement>('[data-field-path]')]
    .map((field) => ({ field, segments: pathSegments(field.dataset.fieldPath ?? '') }))
    .filter(({ segments }) => segments.length > 0)
  const startsWith = (whole: string[], prefix: string[]): boolean => prefix.every((part, index) => whole[index] === part)
  // Prefer an exact field, then the nearest descendant for container issues
  // (/presentation, /promptProfile/examples), then the deepest known ancestor
  // for leaf/extra-index issues. This never builds a selector from backend data.
  const exact = fields.find(({ segments }) => segments.length === issue.length && startsWith(segments, issue))
  const descendant = fields
    .filter(({ segments }) => segments.length > issue.length && startsWith(segments, issue))
    .sort((left, right) => left.segments.length - right.segments.length)[0]
  const ancestor = fields
    .filter(({ segments }) => segments.length < issue.length && startsWith(issue, segments))
    .sort((left, right) => right.segments.length - left.segments.length)[0]
  const target = exact?.field ?? descendant?.field ?? ancestor?.field
  if (target) {
    target.closest('details')?.setAttribute('open', '')
    target.focus()
    target.scrollIntoView?.({ block: 'center' })
    return
  }
  // Unknown paths are still safe to show in the issue list; focus the form
  // instead of attempting to construct a selector from untrusted backend data.
  document.querySelector<HTMLElement>('.cy-character-editor-form')?.focus()
}

function confirm(message: string): boolean {
  return typeof window.confirm !== 'function' || window.confirm(message)
}

async function save(): Promise<void> {
  if (saveDisabled.value) return
  const form = document.querySelector<HTMLFormElement>('.cy-character-editor-form')
  // 原生约束未通过时不进入确认弹窗：先在表单内说明原因，绝不静默返回。
  if (form && checkNativeBlock(form)) return
  const policyMessage = editor.mode === 'edit' && editor.statePolicy === 'reset_evolution'
    ? '将以当前 revision 为基线保存，并按后端返回的范围重置演化状态。确定继续吗？'
    : editor.mode === 'edit'
      ? `将以 expected revision ${editor.baseRevision ?? '未知'} 保存新版本，已有会话继续沿用其绑定。确定继续吗？`
      : '将创建一个新的自定义角色。确定保存吗？'
  if (!confirm(policyMessage)) return
  try {
    const result = await editor.save()
    if (result && !editor.dirty) emit('saved')
  } catch { /* Error status is rendered below. */ }
}

async function discard(): Promise<void> {
  if (!editor.dirty || !confirm('确定放弃当前未保存的角色修改吗？本地恢复草稿也会被删除。')) return
  await editor.discardDraft()
  emit('back')
}

function reloadLatest(): void {
  if (!props.detail || !editor.remoteAvailable || !confirm('重新加载最新版本会丢弃当前编辑内容，确定继续吗？')) return
  emit('reload')
}

async function saveAsNew(): Promise<void> {
  if (!editor.remoteAvailable) return
  if (!confirm('将当前内容另存为一个新的自定义角色，不覆盖远端历史。确定继续吗？')) return
  try {
    const result = await editor.saveAsNew()
    if (result && !editor.dirty) emit('saved')
  } catch { /* Error status is rendered below. */ }
}

function policyChanged(event: Event): void {
  editor.setStatePolicy((event.target as HTMLSelectElement).value as CharacterStatePolicy)
}

function showSuccess(): boolean {
  return editor.saveStatus === 'success' && !editor.dirty
}

onMounted(() => {
  void nextTick(() => {
    document.querySelector<HTMLElement>('.cy-character-editor-form input, .cy-character-editor-form textarea')?.focus()
  })
})
</script>

<template>
  <section class="cy-character-editor" aria-labelledby="cy-character-editor-title">
    <header class="cy-editor-heading">
      <div>
        <button type="button" class="cy-back" @click="emit('back')">← 返回</button>
        <h2 id="cy-character-editor-title">{{ modeLabel }}</h2>
        <p>{{ baselineLabel }} · <span :class="{ dirty: editor.dirty }">{{ editor.dirty ? '有未保存修改' : '未修改' }}</span></p>
      </div>
      <div class="cy-editor-status" aria-live="polite">
        <span v-if="editor.remoteAvailable" class="online">已连接</span>
        <span v-else class="offline">离线：可编辑并保存本地草稿</span>
        <span v-if="editor.persistenceStatus === 'loading'">本地草稿保存中…</span>
        <span v-else-if="editor.persistenceStatus === 'success' && editor.lastPersistedAt">草稿已保存 {{ new Date(editor.lastPersistedAt).toLocaleTimeString() }}</span>
        <span v-else-if="editor.persistenceStatus === 'error'">本地草稿保存失败，可稍后重试</span>
      </div>
    </header>

    <div v-if="editor.mode === 'clone'" class="cy-editor-note" role="status">这是从现有角色复制出的新草稿，首次保存会创建新角色。</div>
    <div v-if="!editor.remoteAvailable" class="cy-editor-note offline-note" role="status">当前无法执行远端校验、预览或保存；继续编辑会保存在本地恢复草稿中。</div>

    <form class="cy-character-editor-form" tabindex="-1" novalidate @submit.prevent="save">
      <fieldset class="cy-basic-fields">
        <legend>基本信息</legend>
        <label>
          <span>角色名称 <em>*</em></span>
          <input data-field-path="/displayName" :value="editor.draft?.displayName ?? ''" name="displayName" maxlength="120" required @input="updateBasic('displayName', $event)" />
        </label>
        <label>
          <span>简介</span>
          <textarea data-field-path="/description" :value="editor.draft?.description ?? ''" rows="3" maxlength="2000" @input="updateBasic('description', $event)" />
        </label>
        <label>
          <span>别名（逗号分隔）</span>
          <input data-field-path="/aliases" :value="aliasesValue()" maxlength="500" @input="updateAliases" />
        </label>
        <label>
          <span>开场白</span>
          <textarea data-field-path="/openingMessage" :value="editor.draft?.openingMessage ?? ''" rows="3" maxlength="4000" @input="updateBasic('openingMessage', $event)" />
        </label>
      </fieldset>

      <CyCharacterPromptFields v-if="editor.draft" :draft="editor.draft" @update="updateField" />
      <CyCharacterPresentationFields v-if="editor.draft" :draft="editor.draft" @update="updateField" />

      <CyCharacterValidation
        :result="blockedMessage ? localValidation : editor.validation"
        :error="editor.validationError ? { ...editor.validationError, message: validationErrorMessage } : undefined"
        :status="editor.validationStatus"
        @validate="validate"
        @focus="focusPath"
      />
      <CyCharacterPreview />

      <div v-if="blockedMessage" class="cy-editor-error native-block" role="alert">{{ blockedMessage }}</div>
      <div v-if="editor.saveStatus === 'conflict'" class="cy-editor-error conflict" role="alert">
        <strong>角色版本发生冲突</strong>
        <span>{{ conflictMessage }}{{ editor.conflict?.currentRevision ? ` 当前 revision：${editor.conflict.currentRevision}` : '' }}</span>
        <div>
          <button type="button" :disabled="busy || !editor.remoteAvailable" @click="reloadLatest">重新加载（丢弃当前草稿）</button>
          <button type="button" :disabled="busy || !editor.remoteAvailable" @click="saveAsNew">另存为新角色</button>
        </div>
      </div>
      <div v-else-if="editor.saveStatus === 'error'" class="cy-editor-error" role="alert">{{ saveErrorMessage }}</div>
      <div v-else-if="showSuccess()" class="cy-editor-success" role="status">角色已保存为 revision {{ editor.baseRevision }}。</div>

      <footer class="cy-editor-actions">
        <div>
          <button type="button" @click="emit('back')">返回</button>
          <button type="button" :disabled="!editor.dirty || editor.saveStatus === 'saving'" @click="discard">放弃修改</button>
        </div>
        <div class="cy-save-group">
          <label>
            <span>演化状态策略</span>
            <select :value="editor.statePolicy" :disabled="editor.saveStatus === 'saving'" @change="policyChanged">
              <option value="preserve">保留现有演化状态</option>
              <option value="reset_evolution">按后端范围重置演化状态</option>
            </select>
          </label>
          <button type="submit" class="primary" :disabled="saveDisabled">
            {{ editor.saveStatus === 'saving' ? '保存中…' : editor.remoteAvailable ? '保存角色' : '离线不可保存' }}
          </button>
        </div>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.cy-character-editor { display: flex; min-width: 0; flex-direction: column; gap: var(--cy-space-6); }
.cy-editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cy-space-7); }
.cy-editor-heading h2 { margin: var(--cy-space-1-5) 0 0; color: var(--cy-text); font-size: 18px; }
.cy-editor-heading p { margin: var(--cy-space-2) 0 0; color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-back { padding: 0; border: 0; background: transparent; color: var(--cy-accent-strong); }
.cy-editor-status { display: grid; justify-items: end; gap: var(--cy-space-1-5); color: var(--cy-muted); font-size: var(--cy-font-xs); text-align: right; }
.online { color: var(--cy-success); }
.offline, .offline-note { color: var(--cy-warning); }
.dirty { color: var(--cy-warning); }
.cy-editor-note, .cy-editor-error, .cy-editor-success { padding: var(--cy-space-5) var(--cy-space-6); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-5); background: var(--cy-surface-soft); color: var(--cy-muted); font-size: var(--cy-font-sm); line-height: 1.5; }
.cy-editor-error { display: grid; gap: var(--cy-space-3); color: var(--cy-danger); border-style: dashed; border-color: color-mix(in srgb, var(--cy-danger) 55%, var(--cy-border)); }
.cy-editor-error.conflict { color: var(--cy-warning); }
.cy-editor-error.native-block { color: var(--cy-danger); font-weight: 600; }
.cy-editor-error div { display: flex; gap: var(--cy-space-3-5); flex-wrap: wrap; }
.cy-editor-success { color: var(--cy-success); }
.cy-character-editor-form { display: grid; gap: var(--cy-space-6); min-width: 0; outline: none; }
.cy-basic-fields { display: grid; gap: var(--cy-space-5-5); min-width: 0; padding: var(--cy-space-6-5) var(--cy-space-7); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); background: var(--cy-surface); }
legend { padding: 0 var(--cy-space-2-5); color: var(--cy-text); font-size: var(--cy-font-lg); font-weight: 650; }
label { display: grid; gap: var(--cy-space-2-5); min-width: 0; color: var(--cy-muted); font-size: var(--cy-font-sm); }
em { color: var(--cy-danger); font-style: normal; }
input, textarea, select { width: 100%; box-sizing: border-box; padding: var(--cy-space-4) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4-5); background: var(--cy-pane); color: var(--cy-text); font: inherit; }
textarea { resize: vertical; line-height: 1.5; }
.cy-editor-actions { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--cy-space-6); padding: var(--cy-space-6) 0 var(--cy-space-1); border-top: 1px solid var(--cy-border); }
.cy-editor-actions > div { display: flex; align-items: flex-end; gap: var(--cy-space-4); }
.cy-save-group { flex-wrap: wrap; justify-content: flex-end; }
.cy-save-group label { min-width: 190px; }
button { padding: var(--cy-space-3) var(--cy-space-5-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-pane); color: var(--cy-text); font-size: var(--cy-font-md); }
button.primary { border-color: var(--cy-accent-strong); color: var(--cy-accent-strong); }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) {
  .cy-editor-heading { flex-direction: column; }
  .cy-editor-status { justify-items: start; text-align: left; }
  .cy-editor-actions { align-items: stretch; flex-direction: column; }
  .cy-editor-actions > div { justify-content: flex-end; }
}
</style>
