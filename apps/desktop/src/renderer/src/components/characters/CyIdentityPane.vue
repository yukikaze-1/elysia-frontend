<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import type { IdentityDraft } from '../../stores/identity.store'
import { useIdentityStore } from '../../stores/identity.store'
import { useCharacterCatalogStore } from '../../stores/character-catalog.store'

const IDENTITY_CATALOG_LIMIT = 100

const identity = useIdentityStore()
const catalog = useCharacterCatalogStore()

const activeCharacters = computed(() => catalog.summaries.filter((item) => item.status === 'active'))
const displayNameValid = computed(() => (identity.draft?.displayName.trim().length ?? 0) > 0)
const localeValid = computed(() => (identity.draft?.locale.trim().length ?? 0) > 0)
const timezoneValid = computed(() => (identity.draft?.timezone.trim().length ?? 0) > 0)
const canSave = computed(() => identity.status === 'ready'
  && identity.dirty
  && displayNameValid.value
  && localeValid.value
  && timezoneValid.value
  && identity.saveStatus !== 'saving')

watch(() => identity.profile, (profile) => {
  if (profile && !identity.draft) identity.beginEdit(profile.timezone)
}, { immediate: true })

onMounted(() => {
  if (identity.status === 'idle') void identity.load()
  ensureCandidateCatalog()
})

function hasCanonicalCandidateQuery(): boolean {
  const last = catalog.lastQuery
  return last.status === 'active'
    && last.source === undefined
    && last.search === undefined
    && last.limit === IDENTITY_CATALOG_LIMIT
    && last.cursor === undefined
}

function ensureCandidateCatalog(force = false): void {
  const canonical = hasCanonicalCandidateQuery()
  if (!canonical || catalog.status === 'idle' || catalog.status === 'stale' || force) {
    void catalog.loadList({ status: 'active', limit: IDENTITY_CATALOG_LIMIT }, { force: force || catalog.status === 'stale' })
  }
}

function fieldValue(field: keyof IdentityDraft): string {
  const value = identity.draft?.[field]
  return typeof value === 'string' ? value : ''
}

function updateRequired(field: 'displayName' | 'locale' | 'timezone', event: Event): void {
  identity.updateDraft({ [field]: (event.target as HTMLInputElement).value })
}

function updateOptional(field: 'preferredAddress' | 'pronouns' | 'defaultCharacterId', event: Event): void {
  const value = (event.target as HTMLInputElement | HTMLSelectElement).value.trim()
  identity.updateDraft({ [field]: value || undefined })
}

function retryLoad(): void {
  void identity.load(true)
}

function save(): void {
  void identity.save()
}

function loadMoreCandidates(): void {
  void catalog.loadNextPage()
}

function retryCandidateCatalog(): void {
  ensureCandidateCatalog(true)
}
</script>

<template>
  <section class="cy-identity-pane" aria-labelledby="cy-identity-title">
    <header class="cy-pane-heading">
      <div>
        <h2 id="cy-identity-title">我的档案</h2>
        <p>这些信息帮助角色知道如何称呼你。档案由后端保存，不会写入本地会话缓存。</p>
      </div>
      <span v-if="identity.profile && !identity.initialized" class="cy-status-chip warning">未完成初始化</span>
      <span v-else-if="identity.initialized" class="cy-status-chip">已确认</span>
    </header>

    <div v-if="identity.status === 'idle'" class="cy-state-card" role="status">
      <strong>档案正在等待连接</strong>
      <span>连接恢复后可重新读取你的档案。</span>
      <button type="button" @click="retryLoad">重试读取</button>
    </div>
    <div v-else-if="identity.status === 'loading'" class="cy-state-card" role="status">正在读取档案…</div>
    <div v-else-if="identity.status === 'error'" class="cy-state-card error" role="alert">
      <strong>当前无法使用角色档案</strong>
      <span>{{ identity.error?.message ?? '角色档案能力尚未启用或连接不可用。' }}</span>
      <button type="button" @click="retryLoad">重试</button>
    </div>

    <template v-else-if="identity.profile && identity.draft">
      <div v-if="!identity.initialized" class="cy-onboarding" role="status">
        <strong>先简单介绍一下自己</strong>
        <p>只需确认最小档案即可。你也可以稍后处理，旧会话仍然可以浏览。</p>
      </div>

      <form class="cy-identity-form" @submit.prevent="save">
        <label class="cy-field">
          <span>显示名 <em>*</em></span>
          <input
            :value="fieldValue('displayName')"
            name="displayName"
            autocomplete="name"
            maxlength="80"
            required
            :aria-invalid="!displayNameValid"
            @input="updateRequired('displayName', $event)"
          />
          <small v-if="!displayNameValid">显示名不能为空。</small>
        </label>

        <div class="cy-field-row">
          <label class="cy-field">
            <span>希望角色如何称呼你</span>
            <input
              :value="fieldValue('preferredAddress')"
              name="preferredAddress"
              maxlength="80"
              placeholder="例如：小雨、你"
              @input="updateOptional('preferredAddress', $event)"
            />
          </label>
          <label class="cy-field">
            <span>代词 / 称谓</span>
            <input
              :value="fieldValue('pronouns')"
              name="pronouns"
              maxlength="80"
              placeholder="可选，自由文本"
              @input="updateOptional('pronouns', $event)"
            />
          </label>
        </div>

        <div class="cy-field-row">
          <label class="cy-field">
            <span>语言</span>
            <input
              :value="fieldValue('locale')"
              name="locale"
              maxlength="35"
              placeholder="zh-CN"
              required
              :aria-invalid="!localeValid"
              @input="updateRequired('locale', $event)"
            />
            <small v-if="!localeValid">语言不能为空。</small>
          </label>
          <label class="cy-field">
            <span>时区</span>
            <input
              :value="fieldValue('timezone')"
              name="timezone"
              maxlength="100"
              placeholder="Asia/Shanghai"
              required
              :aria-invalid="!timezoneValid"
              @input="updateRequired('timezone', $event)"
            />
            <small v-if="!timezoneValid">时区不能为空。</small>
          </label>
        </div>

        <label class="cy-field">
          <span>默认角色</span>
          <select :value="fieldValue('defaultCharacterId')" name="defaultCharacterId" @change="updateOptional('defaultCharacterId', $event)">
            <option value="">使用后端默认角色</option>
            <option v-for="character in activeCharacters" :key="character.characterId" :value="character.characterId">
              {{ character.displayName }}（{{ character.source === 'builtin' ? '内置' : '自定义' }}）
            </option>
          </select>
          <div v-if="catalog.status === 'error'" class="cy-candidate-error" role="alert">
            <small>角色目录当前不可用，仍可保存其他档案字段。</small>
            <button type="button" @click="retryCandidateCatalog">重试角色目录</button>
          </div>
          <button
            v-if="catalog.hasMore"
            type="button"
            class="cy-load-more-candidates"
            :disabled="catalog.status === 'loading'"
            @click="loadMoreCandidates"
          >{{ catalog.status === 'loading' ? '正在加载角色…' : '加载更多可用角色' }}</button>
        </label>

        <div v-if="identity.saveStatus === 'conflict'" class="cy-save-message conflict" role="alert">
          <strong>档案版本发生冲突</strong>
          <span>你的输入已保留。请刷新最新档案，确认后再保存。</span>
          <button type="button" @click="retryLoad">刷新档案</button>
        </div>
        <div v-else-if="identity.saveStatus === 'error'" class="cy-save-message error" role="alert">
          {{ identity.saveError?.message ?? '保存失败，请稍后重试。' }}
        </div>
        <div v-else-if="identity.saveStatus === 'success'" class="cy-save-message success" role="status">档案已保存。</div>

        <footer class="cy-form-actions">
          <p>修改从下一轮对话起生效，不会改写历史消息。</p>
          <div>
            <button type="button" :disabled="!identity.dirty || identity.saveStatus === 'saving'" @click="identity.discardDraft()">撤销修改</button>
            <button type="submit" class="primary" :disabled="!canSave">
              {{ identity.saveStatus === 'saving' ? '保存中…' : identity.initialized ? '保存档案' : '确认并完成初始化' }}
            </button>
          </div>
        </footer>
      </form>
    </template>
  </section>
</template>

<style scoped>
.cy-identity-pane { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.cy-pane-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cy-pane-heading h2 { margin: 0; color: var(--cy-text); font-size: 17px; }
.cy-pane-heading p, .cy-onboarding p, .cy-form-actions p { margin: 4px 0 0; color: var(--cy-muted); font-size: 12px; line-height: 1.55; }
.cy-status-chip { flex: 0 0 auto; padding: 3px 9px; border: 1px solid color-mix(in srgb, var(--cy-success) 45%, transparent); border-radius: 999px; color: var(--cy-success); font-size: 11px; }
.cy-status-chip.warning { color: var(--cy-warning); border-color: color-mix(in srgb, var(--cy-warning) 45%, transparent); }
.cy-state-card, .cy-onboarding, .cy-save-message { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface-soft); color: var(--cy-muted); font-size: 12px; }
.cy-state-card.error, .cy-save-message.error, .cy-save-message.conflict { color: var(--cy-danger); border-style: dashed; border-color: color-mix(in srgb, var(--cy-danger) 55%, var(--cy-border)); }
.cy-save-message.success { color: var(--cy-success); }
.cy-onboarding { color: var(--cy-text); background: var(--cy-accent); }
.cy-identity-form { display: flex; flex-direction: column; gap: 13px; padding: 14px; border: 1px solid var(--cy-border); border-radius: 13px; background: var(--cy-surface); }
.cy-field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.cy-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; color: var(--cy-muted); font-size: 12px; }
.cy-field em { color: var(--cy-danger); font-style: normal; }
.cy-field input, .cy-field select { width: 100%; min-width: 0; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--cy-border); border-radius: 9px; background: var(--cy-pane); color: var(--cy-text); font: inherit; font-size: 13px; }
.cy-field small { color: var(--cy-danger); font-size: 11px; }
.cy-form-actions { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding-top: 2px; }
.cy-form-actions > div { display: flex; gap: 8px; flex: 0 0 auto; }
button { padding: 6px 12px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-pane); color: var(--cy-text); font-size: 12px; }
button.primary { border-color: var(--cy-accent-strong); color: var(--cy-accent-strong); }
.cy-load-more-candidates { align-self: flex-start; margin-top: 3px; }
.cy-candidate-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
button:disabled { opacity: 0.5; cursor: default; }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) {
  .cy-field-row { grid-template-columns: 1fr; }
  .cy-form-actions { align-items: stretch; flex-direction: column; }
  .cy-form-actions > div { justify-content: flex-end; }
}
</style>
