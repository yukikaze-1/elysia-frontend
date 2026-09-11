<script setup lang="ts">
// CyProfileCard:模型 Profile 卡片（阶段 4 批次 A，spec §5.4 + brief Step 6）——
// displayName / 执行位置徽标（backend=可用绿标；desktop·local=「不可用·待配置」灰标+tooltip）/ 凭据状态点 /
// capabilities 摘要 / models 数；backend 行提供类型化测试 + 设为当前，custom 行提供 编辑/复制/删除（删除两步确认）。
// desktop/local_worker 行仅展示不可用态，不提供任何调用入口（决策 D4）。
import { computed, ref } from 'vue'
import type { ModelProfile } from '@shared/contracts'
import { useModelServiceStore } from '../stores/model-service.store'

const props = defineProps<{ profile: ModelProfile }>()
const emit = defineEmits<{ edit: []; copy: [] }>()

const modelStore = useModelServiceStore()

const isBackend = computed(() => props.profile.executionLocation === 'backend')
const connKey = computed(() => `${props.profile.provider}/${props.profile.model}|connectivity`)
const usableKey = computed(() => `${props.profile.provider}/${props.profile.model}|usable`)
const connResult = computed(() => modelStore.testResult[connKey.value])
const usableResult = computed(() => modelStore.testResult[usableKey.value])
const connTesting = computed(() => modelStore.testing[connKey.value] === 'running')
const usableTesting = computed(() => modelStore.testing[usableKey.value] === 'running')
const isActive = computed(() => modelStore.activeProfileId(props.profile.type) === props.profile.id)

const CRED_LABEL: Record<string, string> = { configured: '凭据已配置', missing: '凭据未配置', expired: '凭据已过期' }
const credLabel = computed(() => CRED_LABEL[props.profile.credentialStatus] ?? props.profile.credentialStatus)

const confirmDelete = ref(false)
function armDelete(): void { confirmDelete.value = true }
function cancelDelete(): void { confirmDelete.value = false }
function onDelete(): void {
  confirmDelete.value = false
  void modelStore.deleteProfile(props.profile)
}

function onTestConnectivity(): void { void modelStore.testProfile(props.profile, 'connectivity') }
function onTestUsable(): void { void modelStore.testProfile(props.profile, 'usable') }
function onActivate(): void { void modelStore.activate(props.profile) }

function resultText(r: { ok: boolean; latencyMs?: number; error?: string } | undefined, okText: string): string {
  if (!r) return ''
  return r.ok ? `${okText}${r.latencyMs != null ? ` · ${r.latencyMs}ms` : ''}` : `失败：${r.error ?? '未知错误'}`
}
</script>

<template>
  <article class="cy-profile-card" :data-profile-id="profile.id">
    <header class="cy-profile-head">
      <div class="cy-profile-title">
        <strong>{{ profile.displayName }}</strong>
        <span class="cy-profile-model">{{ profile.id }}</span>
        <span v-if="isActive" class="cy-profile-current">当前</span>
      </div>
      <div class="cy-profile-badges">
        <span v-if="isBackend" class="cy-ms-badge backend">后端</span>
        <span
          v-else
          class="cy-ms-badge unavailable"
          title="Desktop/Local Worker 执行位置由本机承载，当前版本不可用"
        >不可用·待配置</span>
        <span
          class="cy-ms-cred"
          :class="profile.credentialStatus"
          :title="credLabel"
        >
          <i class="cy-ms-dot" :class="profile.credentialStatus" aria-hidden="true" />
          {{ credLabel }}
        </span>
      </div>
    </header>

    <div class="cy-profile-meta">
      <span v-if="profile.endpointLabel" class="cy-profile-endpoint" title="Endpoint 主机（脱敏展示）">{{ profile.endpointLabel }}</span>
      <span class="cy-profile-cap">
        <span v-if="profile.capabilities.length === 0" class="cy-muted">无能力标注</span>
        <template v-else>
          <span v-for="c in profile.capabilities" :key="c" class="cy-cap-chip">{{ c }}</span>
        </template>
      </span>
      <span class="cy-profile-models">{{ profile.models.length }} 个模型</span>
    </div>

    <footer class="cy-profile-actions">
      <template v-if="isBackend">
        <div class="cy-profile-actions-tests">
          <button class="cy-profile-btn" :disabled="connTesting" @click="onTestConnectivity()">
            <i v-if="connTesting" class="cy-spinner" aria-hidden="true" />
            {{ connTesting ? '测试中…' : '测试连接' }}
          </button>
          <button class="cy-profile-btn" :disabled="usableTesting" @click="onTestUsable()">
            <i v-if="usableTesting" class="cy-spinner" aria-hidden="true" />
            {{ usableTesting ? '测试中…' : '可用性测试' }}
          </button>
        </div>
        <div class="cy-profile-actions-main">
          <button
            class="cy-profile-btn cy-profile-activate"
            :class="{ 'is-current': isActive }"
            :disabled="modelStore.activating[profile.type] || isActive || !profile.enabled"
            :title="!profile.enabled ? '服务未启用（services.*.enabled=false），无法设为当前' : undefined"
            @click="onActivate()"
          >
            <i v-if="modelStore.activating[profile.type]" class="cy-spinner" aria-hidden="true" />
            {{ modelStore.activating[profile.type] ? '切换中…' : !profile.enabled ? '服务已停用' : isActive ? '当前使用中' : '设为当前' }}
          </button>
          <template v-if="profile.source === 'custom'">
            <button class="cy-profile-btn" @click="emit('edit')">编辑</button>
            <button class="cy-profile-btn" @click="emit('copy')">复制</button>
            <button v-if="!confirmDelete" class="cy-profile-btn cy-profile-danger" @click="armDelete()">删除</button>
            <template v-else>
              <button class="cy-profile-btn cy-profile-danger" @click="onDelete()">确认删除</button>
              <button class="cy-profile-btn" @click="cancelDelete()">取消</button>
            </template>
          </template>
        </div>
      </template>
      <span v-else class="cy-muted">该执行位置由本机承载，当前版本不提供调用</span>
    </footer>

    <div class="cy-profile-results">
      <div v-if="connResult" class="cy-ms-result" :class="{ ok: connResult.ok, fail: !connResult.ok }">
        连接测试：{{ resultText(connResult, '连接正常') }}
      </div>
      <div v-if="usableResult" class="cy-ms-result" :class="{ ok: usableResult.ok, fail: !usableResult.ok }">
        可用性测试：{{ resultText(usableResult, '可用') }}
      </div>
    </div>
  </article>
</template>

<style scoped>
.cy-profile-card { display: flex; flex-direction: column; gap: var(--cy-space-4); padding: var(--cy-space-5-5) var(--cy-space-6-5); background: var(--cy-surface-glass); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); box-shadow: var(--cy-shadow-soft); }
.cy-profile-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cy-space-5); flex-wrap: wrap; }
.cy-profile-title { display: flex; align-items: center; gap: var(--cy-space-4); flex-wrap: wrap; min-width: 0; }
.cy-profile-title strong { font-size: var(--cy-font-base); }
.cy-profile-model { color: var(--cy-muted); font-size: var(--cy-font-sm); overflow-wrap: anywhere; }
.cy-profile-current { padding: var(--cy-space-0-5) var(--cy-space-4); border-radius: var(--cy-radius-pill); background: var(--cy-accent); color: var(--cy-accent-text); font-size: var(--cy-font-sm); }
.cy-profile-badges { display: flex; align-items: center; gap: var(--cy-space-4); flex-wrap: wrap; }
.cy-ms-badge { padding: var(--cy-space-0-5) var(--cy-space-4); border-radius: var(--cy-radius-pill); font-size: var(--cy-font-sm); }
.cy-ms-badge.backend { color: var(--cy-success); background: color-mix(in srgb, var(--cy-success) 14%, transparent); border: 1px solid color-mix(in srgb, var(--cy-success) 40%, transparent); }
.cy-ms-badge.unavailable { color: var(--cy-muted); background: var(--cy-surface-soft); border: 1px solid var(--cy-border); }
.cy-ms-cred { display: inline-flex; align-items: center; gap: var(--cy-space-2-5); color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-ms-dot { display: inline-block; width: 8px; height: 8px; border-radius: var(--cy-radius-circle); }
.cy-ms-dot.configured { background: var(--cy-success); }
.cy-ms-dot.missing { background: var(--cy-muted); }
.cy-ms-dot.expired { background: var(--cy-warning); }
.cy-profile-meta { display: flex; align-items: center; gap: var(--cy-space-5); flex-wrap: wrap; color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-profile-endpoint { font-family: ui-monospace, monospace; }
.cy-cap-chip { padding: 0 var(--cy-space-3-5); border-radius: var(--cy-radius-pill); background: var(--cy-surface-soft); border: 1px solid var(--cy-border); color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-profile-models { margin-left: auto; }
.cy-profile-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--cy-space-3-5); flex-wrap: wrap; }
.cy-profile-actions-tests, .cy-profile-actions-main { display: flex; align-items: center; gap: var(--cy-space-3-5); flex-wrap: wrap; }
.cy-profile-actions-main { margin-left: auto; }
.cy-profile-btn { display: inline-flex; align-items: center; gap: var(--cy-space-2-5); min-height: 34px; padding: var(--cy-space-2-5) var(--cy-space-5-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); color: var(--cy-text); font-size: var(--cy-font-md); transition: background var(--cy-motion-fast) ease, border-color var(--cy-motion-fast) ease, color var(--cy-motion-fast) ease, transform var(--cy-motion-fast) ease; }
.cy-profile-btn:disabled { opacity: 0.55; cursor: default; }
.cy-profile-btn:hover:not(:disabled) { background: var(--cy-surface-hover); transform: translateY(-1px); }
.cy-profile-activate { border-color: var(--cy-accent-strong); color: var(--cy-accent-strong); }
.cy-profile-activate:not(:disabled) { border-color: transparent; color: var(--cy-on-brand); background: var(--cy-brand-gradient); box-shadow: 0 5px 14px color-mix(in srgb, var(--cy-accent-strong) 20%, transparent); }
.cy-profile-activate.is-current { border-color: color-mix(in srgb, var(--cy-success) 45%, transparent); color: var(--cy-success); background: color-mix(in srgb, var(--cy-success) 10%, transparent); box-shadow: none; }
.cy-profile-activate.is-current:hover:not(:disabled) { transform: none; }
.cy-profile-danger { color: var(--cy-danger); border-color: color-mix(in srgb, var(--cy-danger) 45%, transparent); }
.cy-profile-results { display: flex; flex-direction: column; gap: var(--cy-space-1-5); }
.cy-ms-result { font-size: var(--cy-font-sm); }
.cy-ms-result.ok { color: var(--cy-success); }
.cy-ms-result.fail { color: var(--cy-danger); }
.cy-muted { color: var(--cy-muted); }
.cy-spinner { width: 10px; height: 10px; border-radius: var(--cy-radius-circle); border: 2px solid var(--cy-border); border-top-color: var(--cy-accent); animation: cy-ms-spin 0.8s linear infinite; }
@keyframes cy-ms-spin { to { transform: rotate(360deg); } }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
