<script setup lang="ts">
import CyTitleBar from './components/CyTitleBar.vue'
import CyNavRail from './components/CyNavRail.vue'
import CyConversationList from './components/CyConversationList.vue'
import CyChatView from './components/CyChatView.vue'
import CyLive2DPanel from './components/CyLive2DPanel.vue'
</script>

<template>
  <!-- 四区布局:导航 / 会话列表 / 聊天 / Live2D 右栏(角色栏是布局列,不覆盖聊天) -->
  <div class="cy-app">
    <CyTitleBar />
    <CyNavRail />
    <CyConversationList />
    <main class="cy-main">
      <CyChatView />
    </main>
    <CyLive2DPanel />
  </div>
</template>

<style scoped>
.cy-app {
  display: grid;
  grid-template-columns: 58px 174px minmax(292px, 1fr) 208px;
  grid-template-rows: 36px 1fr;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--cy-window);
}

.cy-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--cy-surface);
}
</style>
