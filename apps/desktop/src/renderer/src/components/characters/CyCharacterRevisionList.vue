<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CharacterStatePolicy } from '@shared/contracts'
import { useCharacterCatalogStore } from '../../stores/character-catalog.store'

const props = defineProps<{
  characterId: string
  currentRevision: number
  enabled?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ rollback: [request: { revision: number; statePolicy: CharacterStatePolicy }] }>()
const catalog = useCharacterCatalogStore()
const statePolicy = ref<CharacterStatePolicy>('preserve')

function revisionPageKey(cursor?: string): string {
  // catalog store stableKey sorts object keys; keep this lookup key in the
  // same canonical order for cursor pages as well as the first page.
  return cursor === undefined
    ? JSON.stringify({ characterId: props.characterId, limit: 20 })
    : JSON.stringify({ characterId: props.characterId, cursor, limit: 20 })
}

const pageKey = computed(() => revisionPageKey())
const page = computed(() => catalog.revisions[pageKey.value])
const status = computed(() => catalog.revisionStatus[pageKey.value] ?? 'idle')
const loaded = computed(() => {
  const items = [] as NonNullable<typeof page.value>['items']
  let moreStatus: 'idle' | 'loading' | 'error' = 'idle'
  let cursor = page.value?.nextCursor
  let hasMore = page.value?.hasMore === true
  const seen = new Set<string>()
  if (page.value) items.push(...page.value.items)
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const nextKey = revisionPageKey(cursor)
    const nextStatus = catalog.revisionStatus[nextKey] ?? 'idle'
    const next = catalog.revisions[nextKey]
    if (!next) {
      moreStatus = nextStatus === 'loading' || nextStatus === 'error' ? nextStatus : 'idle'
      break
    }
    if (nextStatus === 'loading' || nextStatus === 'error') moreStatus = nextStatus
    items.push(...next.items)
    cursor = next.nextCursor
    hasMore = next.hasMore
  }
  return { items, nextCursor: cursor, hasMore, loading: status.value === 'loading' || moreStatus === 'loading', error: moreStatus === 'error', moreStatus }
})

function load(force = false): void {
  if (!props.enabled) return
  void catalog.loadRevisions({ characterId: props.characterId, limit: 20 }, force)
}

function loadMore(): void {
  if (!loaded.value.nextCursor || loaded.value.loading) return
  void catalog.loadRevisions(
    { characterId: props.characterId, limit: 20, cursor: loaded.value.nextCursor },
    loaded.value.moreStatus === 'error'
  )
}

onMounted(() => load())
watch(() => [props.characterId, props.currentRevision, props.enabled], () => {
  statePolicy.value = 'preserve'
  if (props.characterId) load(true)
})
</script>

<template>
  <section class="cy-revisions" aria-labelledby="cy-character-revisions-title">
    <header>
      <div>
        <h3 id="cy-character-revisions-title">版本历史</h3>
        <p>回滚会基于目标版本创建新版本，不会覆盖历史。</p>
      </div>
      <div class="cy-revision-toolbar">
        <label>
          <span>演化状态策略</span>
          <select v-model="statePolicy" aria-label="回滚演化状态策略" :disabled="enabled !== true || busy || status === 'loading'">
            <option value="preserve">保留现有演化状态</option>
            <option value="reset_evolution">按后端范围重置演化状态</option>
          </select>
        </label>
        <button type="button" :disabled="enabled !== true || status === 'loading'" @click="load(true)">{{ status === 'loading' ? '读取中…' : '刷新' }}</button>
      </div>
    </header>
    <div v-if="enabled !== true" class="cy-revision-state" role="status">当前连接或角色状态不支持版本操作。</div>
    <div v-else-if="status === 'idle' || (status === 'loading' && !page)" class="cy-revision-state" role="status">正在读取版本列表…</div>
    <div v-else-if="status === 'error' && !page" class="cy-revision-state error" role="alert">版本列表暂时不可用。<button type="button" @click="load(true)">重试</button></div>
    <div v-else-if="!loaded.items.length" class="cy-revision-state" role="status">暂无版本记录。</div>
    <ol v-else class="cy-revision-list">
      <li v-for="revision in loaded.items" :key="revision.revision" :class="{ current: revision.revision === currentRevision }">
        <div>
          <strong>版本 {{ revision.revision }}</strong>
          <span v-if="revision.revision === currentRevision" class="current-chip">当前</span>
          <small>{{ new Date(revision.createdAt).toLocaleString() }} · {{ revision.createdBy }}</small>
          <code :title="revision.checksum">{{ revision.checksum }}</code>
        </div>
        <button type="button" :disabled="enabled !== true || busy || revision.revision === currentRevision" @click="emit('rollback', { revision: revision.revision, statePolicy })">基于此版本创建新版本</button>
      </li>
    </ol>
    <div v-if="enabled === true && status === 'error' && page" class="cy-revision-state error" role="alert">版本列表刷新失败，当前仍显示旧数据。<button type="button" @click="load(true)">重试</button></div>
    <div v-if="loaded.hasMore" class="cy-load-more-wrap">
      <button type="button" class="cy-load-more" :disabled="enabled !== true || loaded.loading" @click="loadMore">{{ loaded.loading ? '加载中…' : '加载更多版本' }}</button>
      <span v-if="loaded.error" class="cy-load-more-error" role="alert">下一页加载失败。<button type="button" @click="loadMore">重试</button></span>
    </div>
  </section>
</template>

<style scoped>
.cy-revisions { display: grid; gap: var(--cy-space-4-5); padding: var(--cy-space-6-5) var(--cy-space-7); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); background: var(--cy-surface); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cy-space-5); }
h3 { margin: 0; color: var(--cy-text); font-size: var(--cy-font-lg); }
p { margin: var(--cy-space-2) 0 0; color: var(--cy-muted); font-size: var(--cy-font-sm); line-height: 1.5; }
.cy-revision-toolbar { display: flex; align-items: flex-end; gap: var(--cy-space-3-5); flex-wrap: wrap; justify-content: flex-end; }
.cy-revision-toolbar label { display: grid; gap: var(--cy-space-1-5); color: var(--cy-muted); font-size: var(--cy-font-xs); }
.cy-revision-toolbar select { max-width: 160px; padding: var(--cy-space-2-5) var(--cy-space-3-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3-5); background: var(--cy-pane); color: var(--cy-text); font-size: var(--cy-font-xs); }
button { padding: var(--cy-space-2-5) var(--cy-space-4-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3-5); background: var(--cy-pane); color: var(--cy-text); font-size: var(--cy-font-sm); }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:disabled { opacity: .5; cursor: default; }
.cy-revision-state { color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-revision-state.error { color: var(--cy-danger); }
.cy-revision-list { display: grid; gap: var(--cy-space-3-5); margin: 0; padding: 0; list-style: none; }
.cy-revision-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--cy-space-5); padding: var(--cy-space-4-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4-5); }
.cy-revision-list li.current { border-color: color-mix(in srgb, var(--cy-accent-strong) 55%, var(--cy-border)); background: var(--cy-surface-soft); }
.cy-revision-list li > div { display: grid; grid-template-columns: auto auto; align-items: baseline; gap: var(--cy-space-2) var(--cy-space-3-5); min-width: 0; }
.cy-revision-list strong { color: var(--cy-text); font-size: var(--cy-font-md); }
.cy-revision-list small { grid-column: 1 / -1; color: var(--cy-muted); font-size: var(--cy-font-xs); }
.cy-revision-list code { grid-column: 1 / -1; overflow: hidden; color: var(--cy-muted); font-size: var(--cy-font-xs); text-overflow: ellipsis; white-space: nowrap; }
.current-chip { padding: var(--cy-space-0-5) var(--cy-space-3); border-radius: var(--cy-radius-pill); background: var(--cy-accent); color: var(--cy-accent-strong); font-size: var(--cy-font-xs); }
.cy-load-more-wrap { display: grid; justify-items: center; gap: var(--cy-space-2-5); }
.cy-load-more { justify-self: center; }
.cy-load-more-error { color: var(--cy-danger); font-size: var(--cy-font-xs); }
.cy-load-more-error button { margin-left: var(--cy-space-2); color: var(--cy-danger); }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) { header { flex-direction: column; } .cy-revision-toolbar { width: 100%; justify-content: flex-start; } .cy-revision-list li { align-items: flex-start; flex-direction: column; } }
</style>
