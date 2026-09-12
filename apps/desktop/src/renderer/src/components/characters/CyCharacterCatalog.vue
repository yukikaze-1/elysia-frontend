<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CharacterListQuery, CharacterSource, CharacterStatus } from '@shared/contracts'
import { useCharacterCatalogStore } from '../../stores/character-catalog.store'
import { useCharacterEditorStore } from '../../stores/character-editor.store'
import { useIdentityStore } from '../../stores/identity.store'
import CyCharacterCard from './CyCharacterCard.vue'

const emit = defineEmits<{
  select: [characterId: string]
  create: []
  recover: [key: string]
}>()
const catalog = useCharacterCatalogStore()
const editor = useCharacterEditorStore()
const identity = useIdentityStore()
// 查询结果属于共享 store；组件重建时必须从同一事实源恢复控件，不能显示一套筛选、另一套结果。
const search = ref(catalog.lastQuery.search ?? '')
const source = ref<'all' | CharacterSource>(catalog.lastQuery.source ?? 'all')
const statusFilter = ref<CharacterStatus>(catalog.lastQuery.status ?? 'active')
const appliedSearch = ref(catalog.lastQuery.search ?? '')

watch(() => catalog.lastQuery, (next) => {
  // source/status 是即时提交控件，可以始终跟随外部权威查询；搜索框则保留尚未提交的草稿。
  const hasUnsubmittedSearch = search.value !== appliedSearch.value
  source.value = next.source ?? 'all'
  statusFilter.value = next.status ?? 'active'
  if (!hasUnsubmittedSearch) search.value = next.search ?? ''
  appliedSearch.value = next.search ?? ''
}, { deep: true })

const resultSummary = computed(() => `${catalog.summaries.length} 个角色`)

onMounted(() => {
  if (catalog.status === 'idle') void reload(false)
  void editor.listDrafts()
})

function query(): CharacterListQuery {
  const normalizedSearch = search.value.trim()
  return {
    status: statusFilter.value,
    ...(source.value !== 'all' ? { source: source.value } : {}),
    ...(normalizedSearch ? { search: normalizedSearch } : {}),
    limit: 20
  }
}

function reload(force = true): Promise<void> {
  return catalog.loadList(query(), { force })
}

function clearSearch(): void {
  search.value = ''
  void reload()
}

async function recover(key: string): Promise<void> {
  if (editor.dirty && !window.confirm('当前编辑器还有未保存修改。恢复另一份草稿会替换当前输入，确定继续吗？')) return
  if (await editor.recoverDraft(key)) emit('recover', key)
}

async function removeDraft(key: string): Promise<void> {
  if (!window.confirm('确定删除这份本地恢复草稿吗？此操作不会影响远端角色。')) return
  await editor.deleteDraft(key)
}
</script>

<template>
  <section class="cy-character-catalog" aria-labelledby="cy-character-catalog-title">
    <header class="cy-catalog-heading">
      <div>
        <h2 id="cy-character-catalog-title">角色</h2>
        <p>浏览后端角色目录与只读人格详情。完整 authored 内容只在打开详情时加载。</p>
      </div>
      <div class="cy-catalog-heading-actions">
        <span>{{ resultSummary }}</span>
        <button type="button" class="primary" :disabled="editor.saveStatus === 'saving'" @click="emit('create')">新建角色</button>
      </div>
    </header>

    <section v-if="editor.recoverySummaries.length" class="cy-recovery" aria-labelledby="cy-character-recovery-title">
      <header>
        <div>
          <h3 id="cy-character-recovery-title">本地未提交草稿</h3>
          <p>只保存在本机应用缓存，不会进入会话或后端目录。</p>
        </div>
        <span v-if="editor.recoveryStatus === 'loading'">读取中…</span>
      </header>
      <ul>
        <li v-for="draft in editor.recoverySummaries" :key="draft.key">
          <div>
            <strong>{{ draft.displayName }}</strong>
            <small>{{ draft.mode === 'create' ? '新建' : draft.mode === 'clone' ? '克隆' : '编辑' }} · {{ new Date(draft.updatedAt).toLocaleString() }}</small>
          </div>
          <div>
            <button type="button" @click="recover(draft.key)">恢复</button>
            <button type="button" class="danger" @click="removeDraft(draft.key)">删除</button>
          </div>
        </li>
      </ul>
    </section>
    <div v-else-if="editor.recoveryStatus === 'error'" class="cy-recovery-error" role="alert">本地草稿列表暂时不可用。可以继续浏览角色，稍后重试恢复。</div>

    <form class="cy-catalog-filters" role="search" @submit.prevent="reload()">
      <label class="cy-search-field">
        <span class="sr-only">搜索角色</span>
        <input v-model="search" type="search" maxlength="200" placeholder="搜索名称、简介或别名" />
      </label>
      <label>
        <span class="sr-only">角色来源</span>
        <select v-model="source" aria-label="角色来源" @change="reload()">
          <option value="all">全部来源</option>
          <option value="builtin">内置</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      <label>
        <span class="sr-only">角色状态</span>
        <select v-model="statusFilter" aria-label="角色状态" @change="reload()">
          <option value="active">可用角色</option>
          <option value="archived">已归档</option>
        </select>
      </label>
      <button type="submit">搜索</button>
    </form>

    <div v-if="catalog.status === 'stale'" class="cy-catalog-notice" role="status">
      <span>角色目录有更新，当前结果可能已过期。</span>
      <button type="button" @click="reload()">刷新</button>
    </div>
    <div v-else-if="catalog.status === 'loading' && catalog.summaries.length" class="cy-catalog-notice" role="status">正在刷新目录…</div>

    <div v-if="catalog.status === 'idle' && !catalog.summaries.length" class="cy-catalog-state" role="status">
      <strong>角色目录正在等待连接</strong>
      <span>连接恢复后可重新加载角色目录。</span>
      <button type="button" @click="reload(false)">重试加载</button>
    </div>
    <div v-else-if="catalog.status === 'loading' && !catalog.summaries.length" class="cy-catalog-state" role="status">正在加载角色目录…</div>
    <div v-else-if="catalog.status === 'error'" class="cy-catalog-state error" role="alert">
      <strong>角色目录当前不可用</strong>
      <span>{{ catalog.error?.message ?? '后端未启用角色档案能力或连接已断开。' }}</span>
      <button type="button" @click="reload()">重试</button>
    </div>
    <div v-else-if="catalog.status === 'empty'" class="cy-catalog-state" role="status">
      <strong>没有符合条件的角色</strong>
      <span>可以调整来源、状态或搜索词。</span>
      <button v-if="search" type="button" @click="clearSearch">清除搜索</button>
    </div>

    <div v-else class="cy-character-list">
      <CyCharacterCard
        v-for="character in catalog.summaries"
        :key="character.characterId"
        :character="character"
        :default-character-id="identity.defaultCharacterId"
        @select="emit('select', $event)"
      />
    </div>

    <button
      v-if="catalog.hasMore"
      type="button"
      class="cy-load-more"
      :disabled="catalog.status === 'loading'"
      @click="catalog.loadNextPage()"
    >{{ catalog.status === 'loading' ? '加载中…' : '加载更多' }}</button>
  </section>
</template>

<style scoped>
.cy-character-catalog { display: flex; flex-direction: column; gap: var(--cy-space-6-5); min-width: 0; }
.cy-catalog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cy-space-7); }
.cy-catalog-heading h2 { margin: 0; color: var(--cy-text); font-size: 17px; }
.cy-catalog-heading p { margin: var(--cy-space-2) 0 0; color: var(--cy-muted); font-size: var(--cy-font-md); line-height: 1.55; }
.cy-catalog-heading-actions { display: flex; align-items: center; gap: var(--cy-space-4); }
.cy-catalog-heading-actions > span { flex: 0 0 auto; color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-catalog-filters { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto auto; gap: var(--cy-space-4); }
.cy-catalog-filters input, .cy-catalog-filters select { width: 100%; box-sizing: border-box; padding: var(--cy-space-3-5) var(--cy-space-4-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4-5); background: var(--cy-surface); color: var(--cy-text); font-size: var(--cy-font-md); }
.cy-character-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--cy-space-5); }
.cy-catalog-state, .cy-catalog-notice { display: flex; align-items: flex-start; gap: var(--cy-space-3-5); padding: var(--cy-space-6) var(--cy-space-7); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); background: var(--cy-surface-soft); color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-catalog-state { flex-direction: column; }
.cy-catalog-state.error { color: var(--cy-danger); border-style: dashed; border-color: color-mix(in srgb, var(--cy-danger) 55%, var(--cy-border)); }
.cy-catalog-notice { align-items: center; justify-content: space-between; color: var(--cy-warning); }
.cy-load-more { align-self: center; }
.cy-recovery { display: grid; gap: var(--cy-space-4-5); padding: var(--cy-space-6) var(--cy-space-7); border: 1px solid color-mix(in srgb, var(--cy-accent-strong) 35%, var(--cy-border)); border-radius: var(--cy-radius-6); background: var(--cy-surface-soft); }
.cy-recovery header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cy-space-5); }
.cy-recovery h3 { margin: 0; color: var(--cy-text); font-size: var(--cy-font-lg); }
.cy-recovery p { margin: var(--cy-space-2) 0 0; color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-recovery header > span { color: var(--cy-muted); font-size: var(--cy-font-xs); }
.cy-recovery ul { display: grid; gap: var(--cy-space-3); margin: 0; padding: 0; list-style: none; }
.cy-recovery li { display: flex; align-items: center; justify-content: space-between; gap: var(--cy-space-5); padding: var(--cy-space-3-5) var(--cy-space-4); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); }
.cy-recovery li > div:first-child { display: grid; min-width: 0; gap: var(--cy-space-1); }
.cy-recovery strong { color: var(--cy-text); font-size: var(--cy-font-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-recovery small { color: var(--cy-muted); font-size: var(--cy-font-xs); }
.cy-recovery li > div:last-child { display: flex; flex: 0 0 auto; gap: var(--cy-space-2-5); }
.cy-recovery .danger { color: var(--cy-danger); }
.cy-recovery-error { padding: var(--cy-space-4-5) var(--cy-space-5-5); border: 1px dashed var(--cy-danger); border-radius: var(--cy-radius-4-5); color: var(--cy-danger); font-size: var(--cy-font-sm); }
button { padding: var(--cy-space-3) var(--cy-space-5-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-pane); color: var(--cy-text); font-size: var(--cy-font-md); }
.primary { border-color: var(--cy-accent-strong); color: var(--cy-accent-strong); }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
</style>
