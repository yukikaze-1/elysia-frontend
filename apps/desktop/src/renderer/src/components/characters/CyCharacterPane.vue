<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CharacterStatePolicy } from '@shared/contracts'
import { useCharacterCatalogStore } from '../../stores/character-catalog.store'
import { useCharacterEditorStore } from '../../stores/character-editor.store'
import { parsePublicError, type PublicError } from '../../utils/public-error'
import CyCharacterCatalog from './CyCharacterCatalog.vue'
import CyCharacterDetail from './CyCharacterDetail.vue'
import CyCharacterEditor from './CyCharacterEditor.vue'

type PaneView = 'catalog' | 'detail' | 'editor'

const props = defineProps<{ initialCharacterId?: string }>()

const catalog = useCharacterCatalogStore()
const editor = useCharacterEditorStore()
const view = ref<PaneView>('catalog')
const selectedCharacterId = ref<string>()
const actionBusy = ref(false)
const actionError = ref<PublicError>()

const selectedDetail = computed(() => selectedCharacterId.value ? catalog.details[selectedCharacterId.value] : undefined)
const selectedStatus = computed(() => selectedCharacterId.value ? catalog.detailStatus[selectedCharacterId.value] : undefined)
const remoteAvailable = computed(() => editor.remoteAvailable)
const busy = computed(() => actionBusy.value || editor.saveStatus === 'saving' || editor.validationStatus === 'loading' || editor.previewStatus === 'loading')

watch(() => catalog.connectionEpoch, () => {
  // 连接世代变化会清除目录/详情缓存，但不能丢掉用户正在编辑的本地草稿。
  if (view.value !== 'editor') {
    view.value = 'catalog'
    selectedCharacterId.value = undefined
  }
})

function canLeaveEditor(action: string, discard = false): boolean {
  if (!editor.hasEditor || !editor.dirty) return true
  if (!window.confirm(`当前角色还有未保存修改。确定${discard ? '放弃修改并' : '离开并保留本地草稿后'}${action}吗？`)) return false
  if (discard) void editor.discardDraft()
  else void editor.flushDraft()
  return true
}

function openDetail(characterId: string): void {
  if (view.value === 'editor' && !canLeaveEditor('查看其他角色', true)) return
  selectedCharacterId.value = characterId
  actionError.value = undefined
  view.value = 'detail'
  void catalog.loadDetail(characterId)
}

function select(characterId: string): void {
  openDetail(characterId)
}

watch(() => props.initialCharacterId, (characterId) => {
  if (characterId) openDetail(characterId)
}, { immediate: true })

function create(): void {
  if (editor.hasEditor && editor.dirty && !canLeaveEditor('新建角色', true)) return
  editor.beginCreate()
  actionError.value = undefined
  selectedCharacterId.value = undefined
  view.value = 'editor'
}

function startEdit(): void {
  const detail = selectedDetail.value
  if (!detail || busy.value) return
  if (editor.mode === 'edit' && editor.baseCharacterId === detail.summary.characterId && editor.hasEditor) {
    view.value = 'editor'
    return
  }
  if (editor.hasEditor && editor.dirty && !canLeaveEditor('编辑另一个角色', true)) return
  editor.beginEdit(detail)
  view.value = 'editor'
}

function startClone(): void {
  const detail = selectedDetail.value
  if (!detail || busy.value) return
  if (editor.hasEditor && editor.dirty && !canLeaveEditor('克隆另一个角色', true)) return
  editor.beginClone(detail, `${detail.summary.displayName}（自定义）`)
  view.value = 'editor'
}

async function recover(key: string): Promise<void> {
  // Catalog has already loaded the full record. The route change is kept here so
  // the component remains the single coordinator for the three visible states.
  if (editor.mode === 'edit' && editor.baseCharacterId) {
    selectedCharacterId.value = editor.baseCharacterId
    void catalog.loadDetail(editor.baseCharacterId)
  } else {
    selectedCharacterId.value = undefined
  }
  view.value = 'editor'
  void key
}

function backFromDetail(): void {
  actionError.value = undefined
  view.value = 'catalog'
  selectedCharacterId.value = undefined
}

function backFromEditor(): void {
  if (!canLeaveEditor('返回角色详情')) return
  view.value = selectedCharacterId.value ? 'detail' : 'catalog'
}

async function archive(): Promise<void> {
  const detail = selectedDetail.value
  if (!detail || detail.summary.source !== 'custom' || detail.summary.status !== 'active' || !remoteAvailable.value || busy.value) return
  if (!window.confirm('归档后不能再编辑或用于新会话，但既有会话仍可查看。确定归档这个角色吗？')) return
  actionBusy.value = true
  actionError.value = undefined
  try {
    const result = await catalog.archiveCharacter(detail.summary.characterId)
    if (result) {
      view.value = 'catalog'
      selectedCharacterId.value = undefined
      void catalog.loadList(catalog.lastQuery, { force: true })
    }
  } catch (cause) { actionError.value = parsePublicError(cause instanceof Error ? cause.message : String(cause)) }
  finally { actionBusy.value = false }
}

async function rollback(request: { revision: number; statePolicy: CharacterStatePolicy }): Promise<void> {
  const detail = selectedDetail.value
  if (!detail || detail.summary.source !== 'custom' || detail.summary.status !== 'active' || !remoteAvailable.value || busy.value) return
  const policyText = request.statePolicy === 'reset_evolution'
    ? '按后端定义的范围重置演化状态（不删除既有会话）'
    : '保留现有演化状态'
  if (!window.confirm(`将基于版本 ${request.revision} 创建新版本；expected revision 为 ${detail.current.revision}；策略：${policyText}。不会覆盖历史。确定继续吗？`)) return
  actionBusy.value = true
  actionError.value = undefined
  try {
    const result = await catalog.rollbackCharacter({
      characterId: detail.summary.characterId,
      targetRevision: request.revision,
      expectedRevision: detail.current.revision,
      statePolicy: request.statePolicy
    })
    if (result) {
      await catalog.loadDetail(detail.summary.characterId, true)
      void catalog.loadList(catalog.lastQuery, { force: true })
    }
  } catch (cause) { actionError.value = parsePublicError(cause instanceof Error ? cause.message : String(cause)) }
  finally { actionBusy.value = false }
}

async function saved(): Promise<void> {
  const characterId = editor.baseCharacterId
  if (!characterId || editor.dirty) return
  selectedCharacterId.value = characterId
  view.value = 'detail'
  await catalog.loadDetail(characterId, true)
  void catalog.loadList(catalog.lastQuery, { force: true })
}

async function reloadAfterConflict(): Promise<void> {
  const characterId = editor.baseCharacterId
  if (!characterId || !remoteAvailable.value || actionBusy.value) return
  actionBusy.value = true
  try {
    await catalog.loadDetail(characterId, true)
    const latest = catalog.details[characterId]
    if (latest && catalog.detailStatus[characterId] === 'ready') {
      editor.reloadAfterCallerConfirm(latest, true)
    }
  } catch (cause) {
    actionError.value = parsePublicError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    actionBusy.value = false
  }
}

function retry(): void {
  if (selectedCharacterId.value) void catalog.loadDetail(selectedCharacterId.value, true)
}
</script>

<template>
  <CyCharacterCatalog v-if="view === 'catalog'" @select="select" @create="create" @recover="recover" />
  <CyCharacterDetail
    v-else-if="view === 'detail'"
    :detail="selectedDetail"
    :loading="selectedStatus === 'loading'"
    :error="selectedStatus === 'error' ? catalog.error : undefined"
    :action-error="actionError"
    :remote-available="remoteAvailable"
    :busy="busy"
    @back="backFromDetail"
    @retry="retry"
    @edit="startEdit"
    @clone="startClone"
    @archive="archive"
    @rollback="rollback"
  />
  <CyCharacterEditor v-else :detail="selectedDetail" :busy="busy" @back="backFromEditor" @saved="saved" @reload="reloadAfterConflict" />
</template>
