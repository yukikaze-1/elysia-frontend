<script setup lang="ts">
// Phase 0 占位:角色栏是聊天右侧的布局列扩展(不覆盖聊天)。
// Live2D 渲染与状态映射属阶段 5。
</script>

<template>
  <aside class="cy-live">
    <div class="cy-live-head">
      <span class="cy-live-title">角色</span>
      <button class="cy-live-min" title="折叠角色栏" aria-label="折叠角色栏">›</button>
    </div>
    <div class="cy-live-stage">
      <div class="cy-live-glow" aria-hidden="true" />
      <div class="cy-character-placeholder" aria-label="Live2D 角色占位">
        <svg width="120" height="150" viewBox="0 0 120 150" aria-hidden="true">
          <ellipse class="cy-clothes" cx="60" cy="105" rx="40" ry="38" />
          <circle class="cy-skin" cx="60" cy="55" r="30" />
          <path class="cy-hair" d="M32 50c0-28 56-28 56 0v4H32z" />
          <circle class="cy-eye" cx="48" cy="55" r="4" />
          <circle class="cy-eye" cx="72" cy="55" r="4" />
        </svg>
      </div>
    </div>
    <div class="cy-live-status">thinking · 未接入 Live2D</div>
  </aside>
</template>

<style scoped>
.cy-live {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(180deg, var(--cy-pane), var(--cy-titlebar));
  border-left: 1px solid var(--cy-border);
}

.cy-live-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
}

.cy-live-title {
  font-size: 13px;
  font-weight: 500;
}

.cy-live-min {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--cy-border);
  border-radius: 9px;
  background: var(--cy-surface);
  color: var(--cy-muted);
}

.cy-live-stage {
  position: relative;
  display: grid;
  flex: 1;
  place-items: center;
  min-height: 0;
  padding: 8px;
}

.cy-live-glow {
  position: absolute;
  width: 150px;
  height: 150px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--cy-glow), transparent 70%);
  opacity: 0.45;
  filter: blur(12px);
}

.cy-character-placeholder {
  position: relative;
}

.cy-character-placeholder :deep(.cy-clothes) {
  fill: var(--cy-clothes);
}
.cy-character-placeholder :deep(.cy-skin) {
  fill: var(--cy-skin);
}
.cy-character-placeholder :deep(.cy-hair) {
  fill: var(--cy-hair);
}
.cy-character-placeholder :deep(.cy-eye) {
  fill: var(--cy-eye);
}

.cy-live-status {
  margin: 0 12px 14px;
  padding: 10px;
  text-align: center;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  font-size: 12px;
}
</style>
