<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CharacterSummary } from '@shared/contracts'
import { useCharacterCatalogStore } from '../stores/character-catalog.store'
import { useIdentityStore } from '../stores/identity.store'

const props = withDefaults(defineProps<{
  open: boolean
  busy?: boolean
  remoteAvailable: boolean
}>(), {
  busy: false
})

const emit = defineEmits<{
  close: []
  confirm: [characterId: string]
  openSettings: [kind: 'identity' | 'characters']
}>()

const catalog = useCharacterCatalogStore()
const identity = useIdentityStore()

const search = ref('')
const selectedId = ref<string>()
const selectedSnapshot = ref<CharacterSummary>()
const detailId = ref<string>()
const searchInput = ref<HTMLInputElement>()
let pickerRequest = 0

const identityLoading = computed(() => identity.status === 'loading')
const identityInitialized = computed(() => identity.profile?.initialized === true)
const activeCharacters = computed(() => {
  const byId = new Map(catalog.summaries
    .filter((item) => item.status === 'active' && catalog.characterStatus(item.characterId) !== 'archived')
    .map((item) => [item.characterId, item]))
  // 默认角色可能在当前 active 页之后；picker 在打开时安全补拉 detail，
  // 这里把该只读 summary 合并进候选而不改写 catalog 的分页事实。
  const defaultId = identity.defaultCharacterId
  const defaultDetail = defaultId ? catalog.details[defaultId] : undefined
  if (defaultDetail?.summary.status === 'active' && catalog.characterStatus(defaultDetail.summary.characterId) !== 'archived') {
    byId.set(defaultDetail.summary.characterId, defaultDetail.summary)
  }
  return [...byId.values()]
})
const defaultActiveId = computed(() => {
  const id = identity.defaultCharacterId
  return id && activeCharacters.value.some((item) => item.characterId === id) ? id : undefined
})
const visibleCharacters = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const result = query
    ? activeCharacters.value.filter((item) => [item.displayName, item.description, ...item.aliases]
      .some((part) => part.toLocaleLowerCase().includes(query)))
    : activeCharacters.value
  // 默认角色在首屏固定置顶；其余顺序由 catalog 分页结果决定。
  if (!defaultActiveId.value) return result
  return [...result].sort((left, right) => {
    if (left.characterId === defaultActiveId.value) return -1
    if (right.characterId === defaultActiveId.value) return 1
    return 0
  })
})
const selectedCharacter = computed(() => {
  // A snapshot is only a temporary search/pagination fallback.  Require the
  // catalog's per-id active fence as well, so an epoch reset or an archived
  // event cannot make an unproven snapshot selectable again.
  if (selectedId.value && catalog.characterStatus(selectedId.value) !== 'active') return undefined
  const current = activeCharacters.value.find((item) => item.characterId === selectedId.value)
  if (current) return current
  // 搜索/分页会暂时替换 catalog.summaries；保留本次打开中用户已明确
  // 选择的 active 摘要，使选择不会因查询结果切换而被静默清空。
  return selectedSnapshot.value?.characterId === selectedId.value ? selectedSnapshot.value : undefined
})
const selectionArchived = computed(() => Boolean(
  selectedId.value && catalog.characterStatus(selectedId.value) === 'archived'
))
const detailCharacter = computed(() => {
  if (!detailId.value) return undefined
  return activeCharacters.value.find((item) => item.characterId === detailId.value)
})
const needsExplicitChoice = computed(() => !selectedCharacter.value && activeCharacters.value.length > 1 && !defaultActiveId.value)
const canConfirm = computed(() => Boolean(
  props.remoteAvailable && identityInitialized.value && selectedCharacter.value && !selectionArchived.value && !needsExplicitChoice.value && !props.busy
))

function rememberSelection(character: CharacterSummary): void {
  selectedId.value = character.characterId
  selectedSnapshot.value = {
    ...character,
    aliases: [...character.aliases],
    presentation: { ...character.presentation }
  }
}

function chooseInitialSelection(): void {
  if (selectedId.value && activeCharacters.value.some((item) => item.characterId === selectedId.value)) return
  if (defaultActiveId.value) {
    const character = activeCharacters.value.find((item) => item.characterId === defaultActiveId.value)
    if (character) rememberSelection(character)
    return
  }
  if (activeCharacters.value.length === 1) rememberSelection(activeCharacters.value[0])
  else { selectedId.value = undefined; selectedSnapshot.value = undefined }
}

async function loadPickerData(): Promise<void> {
  if (!props.open || !props.remoteAvailable) return
  const request = ++pickerRequest
  const identityTask = !identity.profile ? identity.load() : undefined
  // 选角器只请求 active 摘要，详情 authored 内容留给设置中心，避免 picker 跨域复制状态。
  await Promise.all([
    catalog.loadList({ status: 'active', limit: 20 }, { force: true }),
    identityTask
  ])
  if (!props.open || request !== pickerRequest) return
  const defaultId = identity.defaultCharacterId
  if (defaultId && !catalog.summaries.some((item) => item.characterId === defaultId && item.status === 'active')) {
    // 只为解析默认角色补拉 detail；归档/不存在会被 detail status 拒绝，
    // 不会制造可选项或覆盖本次明确选择。
    await catalog.loadDetail(defaultId)
    if (!props.open || request !== pickerRequest) return
  }
  chooseInitialSelection()
  await nextTick()
  searchInput.value?.focus()
}

function submitSearch(): void {
  // 先保留显式选择；清空搜索时回到第一页 active 目录。
  void catalog.loadList({ status: 'active', ...(search.value.trim() ? { search: search.value.trim() } : {}), limit: 20 }, { force: true })
}

function loadMore(): void {
  if (catalog.status === 'loading') return
  void catalog.loadNextPage()
}

function select(character: CharacterSummary): void {
  if (character.status !== 'active' || props.busy) return
  rememberSelection(character)
}

function showDetails(character: CharacterSummary): void {
  if (character.status !== 'active') return
  detailId.value = character.characterId
}

function closeDetails(): void {
  detailId.value = undefined
}

function confirmSelection(): void {
  const characterId = selectedCharacter.value?.characterId
  if (!characterId || !canConfirm.value) return
  // 提交门只由父层 characterPickerBusy + conversationStore.busy 维护。
  // 不在此处设置一个可能因父层失败而永久卡住的本地 confirming 锁。
  emit('confirm', characterId)
}

watch(selectionArchived, (archived) => {
  if (!archived) return
  // A catalog archive event is authoritative even when search currently hides
  // the selected card.  Do not let the temporary selectedSnapshot bypass it.
  selectedId.value = undefined
  selectedSnapshot.value = undefined
  detailId.value = undefined
})

function close(): void {
  if (props.busy) return
  emit('close')
}

watch(() => props.open, (open) => {
  // 每次打开都是一次新的选择意图：只按默认→唯一→明确选择重算，
  // 不沿用上次关闭前的 selectedId。
  pickerRequest++
  selectedId.value = undefined
  selectedSnapshot.value = undefined
  detailId.value = undefined
  search.value = ''
  if (open) void loadPickerData()
}, { immediate: true })
</script>

<template>
  <div v-if="open" class="cy-character-picker-backdrop" role="presentation" @click.self="close">
    <section class="cy-character-picker" role="dialog" aria-modal="true" aria-labelledby="cy-character-picker-title" @keydown.esc.stop.prevent="close">
      <header class="cy-character-picker-header">
        <div>
          <h2 id="cy-character-picker-title">选择角色</h2>
          <p>新会话会保存角色绑定快照，之后不会随角色目录修改而变化。</p>
        </div>
        <button type="button" class="cy-picker-close" aria-label="关闭角色选择" :disabled="busy" @click="close">×</button>
      </header>

      <div v-if="identityLoading" class="cy-picker-state" role="status">正在读取“我的档案”…</div>
      <div v-else-if="!identityInitialized" class="cy-picker-state cy-picker-blocked" role="alert">
        <strong>完成“我的档案”后才能新建角色会话</strong>
        <span>初始化身份后，角色才能知道该如何称呼和陪伴你。</span>
        <div class="cy-picker-state-actions">
          <button type="button" @click="emit('openSettings', 'identity')">打开我的档案</button>
          <button type="button" @click="emit('openSettings', 'characters')">查看角色设置</button>
        </div>
      </div>
      <div v-else-if="!remoteAvailable" class="cy-picker-state" role="alert">
        <strong>当前无法新建角色会话</strong>
        <span>请恢复后端连接后重试；已存在的缓存会话仍可浏览。</span>
      </div>
      <template v-else>
        <form class="cy-picker-search" role="search" @submit.prevent="submitSearch">
          <label for="cy-character-picker-search">搜索角色</label>
          <div class="cy-picker-search-row">
            <input id="cy-character-picker-search" ref="searchInput" v-model="search" type="search" placeholder="名称、简介或别名" autocomplete="off" />
            <button type="submit" :disabled="catalog.status === 'loading'">搜索</button>
          </div>
        </form>

        <div v-if="catalog.status === 'loading' && !activeCharacters.length" class="cy-picker-state" role="status">正在加载可用角色…</div>
        <div v-else-if="catalog.status === 'error'" class="cy-picker-state cy-picker-error" role="alert">
          <strong>角色目录暂时不可用</strong>
          <span>{{ catalog.error?.message ?? '请稍后重试。' }}</span>
          <button type="button" @click="submitSearch">重试</button>
        </div>
        <div v-else-if="visibleCharacters.length === 0" class="cy-picker-state" role="status">
          没有可选择的 active 角色。
        </div>
        <ul v-else class="cy-picker-list" aria-label="可选择角色">
          <li v-for="character in visibleCharacters" :key="character.characterId">
            <div class="cy-picker-card-row">
              <button
                type="button"
                class="cy-picker-card"
                :class="{ 'is-selected': selectedId === character.characterId }"
                :aria-pressed="selectedId === character.characterId"
                :data-character-id="character.characterId"
                :disabled="busy"
                @click="select(character)"
              >
                <span class="cy-picker-avatar" :style="character.presentation.themeColor ? { backgroundColor: character.presentation.themeColor } : undefined" aria-hidden="true">{{ Array.from(character.displayName.trim())[0] ?? '角' }}</span>
                <span class="cy-picker-card-copy">
                  <span class="cy-picker-card-title">
                    <strong>{{ character.displayName }}</strong>
                    <span v-if="character.characterId === defaultActiveId" class="cy-picker-badge">默认</span>
                    <span class="cy-picker-badge">{{ character.source === 'builtin' ? '内置' : '自定义' }}</span>
                  </span>
                  <span class="cy-picker-description">{{ character.description || '暂无简介' }}</span>
                </span>
                <span class="cy-picker-radio" aria-hidden="true">{{ selectedId === character.characterId ? '✓' : '' }}</span>
              </button>
              <button type="button" class="cy-picker-details" :disabled="busy" :aria-label="`查看 ${character.displayName} 详情`" @click="showDetails(character)">查看详情</button>
            </div>
          </li>
        </ul>

        <aside v-if="detailCharacter" class="cy-picker-detail" role="dialog" aria-label="角色详情">
          <header>
            <strong>{{ detailCharacter.displayName }}</strong>
            <button type="button" class="cy-picker-detail-close" aria-label="关闭角色详情" @click="closeDetails">×</button>
          </header>
          <dl>
            <div><dt>来源</dt><dd>{{ detailCharacter.source === 'builtin' ? '内置角色' : '自定义角色' }}</dd></div>
            <div><dt>简介</dt><dd>{{ detailCharacter.description || '暂无简介' }}</dd></div>
            <div><dt>别名</dt><dd>{{ detailCharacter.aliases.length ? detailCharacter.aliases.join('、') : '无' }}</dd></div>
            <div><dt>版本</dt><dd>revision {{ detailCharacter.currentRevision }}</dd></div>
          </dl>
        </aside>

        <button v-if="catalog.hasMore" type="button" class="cy-picker-more" :disabled="catalog.status === 'loading' || busy" @click="loadMore">
          {{ catalog.status === 'loading' ? '加载中…' : '加载更多角色' }}
        </button>

        <p v-if="needsExplicitChoice" class="cy-picker-hint" role="status">检测到多个可用角色，请明确选择一个后继续。</p>
      </template>

      <footer class="cy-character-picker-footer">
        <button type="button" :disabled="busy" @click="close">取消</button>
        <button type="button" class="primary" :disabled="!canConfirm" @click="confirmSelection">
          {{ busy ? '创建中…' : '使用此角色新建会话' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.cy-character-picker-backdrop { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; padding: 20px; background: var(--cy-overlay); }
.cy-character-picker { display: flex; flex-direction: column; width: min(520px, 94vw); max-height: min(680px, 90vh); min-height: 0; overflow: hidden; border: 1px solid var(--cy-border); border-radius: 14px; background: var(--cy-pane); box-shadow: var(--cy-shadow); }
.cy-character-picker-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; border-bottom: 1px solid var(--cy-border); }
.cy-character-picker-header h2 { margin: 0; color: var(--cy-text); font-size: 16px; }
.cy-character-picker-header p { margin: 5px 0 0; color: var(--cy-muted); font-size: 11px; line-height: 1.5; }
.cy-picker-close { flex: 0 0 auto; width: 28px; height: 28px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); font-size: 18px; line-height: 1; }
.cy-picker-search { display: grid; gap: 6px; padding: 13px 18px 8px; }
.cy-picker-search label { color: var(--cy-muted); font-size: 11px; }
.cy-picker-search-row { display: flex; gap: 7px; }
.cy-picker-search input { flex: 1 1 auto; min-width: 0; padding: 8px 10px; border: 1px solid var(--cy-border); border-radius: 9px; background: var(--cy-surface); color: var(--cy-text); }
.cy-picker-search button, .cy-picker-state button, .cy-picker-state-actions button, .cy-character-picker-footer button, .cy-picker-more { padding: 7px 11px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-text); font-size: 12px; }
.cy-picker-list { display: grid; gap: 7px; min-height: 0; overflow-y: auto; margin: 0; padding: 6px 18px 10px; list-style: none; }
.cy-picker-card-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: stretch; gap: 6px; }
.cy-picker-card { display: grid; grid-template-columns: 38px minmax(0, 1fr) 24px; align-items: center; gap: 10px; width: 100%; padding: 9px; text-align: left; border: 1px solid var(--cy-border); border-radius: 11px; background: var(--cy-surface); color: var(--cy-text); }
.cy-picker-card:hover { background: var(--cy-surface-hover); }
.cy-picker-card.is-selected { border-color: var(--cy-accent-strong); background: var(--cy-accent-tint); }
.cy-picker-card:disabled { opacity: .62; cursor: not-allowed; }
.cy-picker-avatar { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: var(--cy-accent); color: var(--cy-accent-text); font-weight: 650; }
.cy-picker-card-copy { display: grid; gap: 3px; min-width: 0; }
.cy-picker-card-title { display: flex; align-items: center; gap: 5px; min-width: 0; }
.cy-picker-card-title strong, .cy-picker-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-picker-card-title strong { font-size: 13px; }
.cy-picker-description { color: var(--cy-muted); font-size: 11px; }
.cy-picker-badge { padding: 1px 5px; border: 1px solid var(--cy-border); border-radius: 999px; color: var(--cy-muted); font-size: 9px; }
.cy-picker-radio { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--cy-border); border-radius: 50%; color: var(--cy-accent-strong); font-size: 13px; }
.cy-picker-card.is-selected .cy-picker-radio { border-color: var(--cy-accent-strong); background: var(--cy-accent); }
.cy-picker-details { align-self: center; padding: 6px 8px; white-space: nowrap; color: var(--cy-accent-strong); }
.cy-picker-more { align-self: center; margin: 0 18px 8px; }
.cy-picker-hint { margin: 0 18px 8px; color: var(--cy-warning); font-size: 11px; }
.cy-picker-state { display: grid; gap: 7px; justify-items: center; padding: 30px 20px; color: var(--cy-muted); text-align: center; font-size: 12px; }
.cy-picker-state strong { color: var(--cy-text); font-size: 13px; }
.cy-picker-blocked { color: var(--cy-muted); }
.cy-picker-state-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin-top: 5px; }
.cy-picker-error { color: var(--cy-danger); }
.cy-picker-detail { display: grid; gap: 9px; margin: 0 18px 8px; padding: 11px 12px; border: 1px solid var(--cy-border); border-radius: 10px; background: var(--cy-surface-soft); }
.cy-picker-detail header { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--cy-text); font-size: 12px; }
.cy-picker-detail-close { padding: 2px 7px; }
.cy-picker-detail dl { display: grid; gap: 5px; margin: 0; }
.cy-picker-detail dl > div { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 8px; }
.cy-picker-detail dt { color: var(--cy-muted); font-size: 10px; }
.cy-picker-detail dd { margin: 0; color: var(--cy-text); font-size: 11px; overflow-wrap: anywhere; }
.cy-character-picker-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 15px; border-top: 1px solid var(--cy-border); }
.cy-character-picker-footer .primary { border-color: var(--cy-accent-strong); background: var(--cy-accent); color: var(--cy-accent-text); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 560px) { .cy-character-picker-backdrop { padding: 8px; } .cy-character-picker-header, .cy-picker-search, .cy-picker-list, .cy-character-picker-footer { padding-left: 12px; padding-right: 12px; } }
</style>
