<template>
  <header class="cy-titlebar">
    <div class="cy-window-controls" aria-hidden="true">
      <span class="cy-window-dot" />
      <span class="cy-window-dot" />
      <span class="cy-window-dot" />
    </div>
    <span class="cy-title-name">Cyrene</span>
    <span class="cy-title-spacer" aria-hidden="true" />
  </header>
</template>

<style scoped>
.cy-titlebar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: var(--cy-titlebar);
  border-bottom: 1px solid var(--cy-border);
  user-select: none;
}

.cy-window-controls {
  display: flex;
  gap: 7px;
}

.cy-window-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--cy-border);
}

.cy-title-name {
  flex: 1;
  color: var(--cy-muted);
  text-align: center;
  font-size: 12px;
}

.cy-title-spacer {
  width: 44px;
}
</style>
