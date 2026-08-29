<script setup lang="ts">
// CyChatView:聊天主区——头部 + CyMessageList(自研虚拟列表,窗口化渲染)+ CyChatInput。
// conversationStore 激活/新建(F1:create 不 reset messageStore,新建后须显式 activate(c.id));
// 连接装配(Endpoint/Token/连接按钮)在 CyConnectionPanel(UII-QQ:紧凑连接入口 + popover)。
import { computed } from 'vue'
import { useConversationStore } from '../stores/conversation.store'
import { useLayoutStore } from '../stores/layout.store'
import { useHistoryViewerStore } from '../stores/historyViewer.store'
import CyMessageList from './CyMessageList.vue'
import CyChatInput from './CyChatInput.vue'
import CyConnectionPanel from './CyConnectionPanel.vue'
import CyTtsPlayer from './CyTtsPlayer.vue'
import CyLiveToolCards from './CyLiveToolCards.vue'   // 阶段 6 批次 B（Task 7）：工具实时区（消息列表与输入区之间）

const conversationStore = useConversationStore()
const layout = useLayoutStore()
const historyStore = useHistoryViewerStore()

const convTitle = computed(() => {
  const c = conversationStore.items.find((i) => i.id === conversationStore.currentId)
  return c?.title ?? '新会话'
})

/** F1(Task 4 review):create 只设 currentId、不 reset messageStore——新建后显式 activate(c.id) 拉起空消息页
 *  UI 问题 6：删「新建」头部按钮——会话创建收敛到左侧列表头 +；此函数保留供列表复用（独立组件），头部不再入口。 */
</script>

<template>
  <section class="cy-chat">
    <header class="cy-chat-header">
      <!-- UII-QQ：标题是头部主体；连接状态收敛到右侧 CyConnectionPanel 紧凑入口（不再「绿点+已连接」与连接卡双份表达） -->
      <div class="cy-chat-heading">
        <h2>{{ convTitle }}</h2>
      </div>
      <div class="cy-header-actions">
        <!-- P2-1：查看器入口不 gating（spec §4.8）——未连接时打开查询经 Main 失败，在查看器错误区展示 -->
        <button class="cy-action-button" title="聊天记录" @click="historyStore.openViewer()">聊天记录</button>
        <button class="cy-action-button" title="资源" @click="historyStore.openViewer('image_video')">资源</button>
        <!-- 角色：紧凑图标钮（live2dShown 时是唯一可再展开的入口——面板折叠后 v-show 隐藏但其 toggle 不可点） -->
        <button
          class="cy-action-button cy-action-icon"
          :aria-pressed="layout.effective.live2dShown"
          title="显示/隐藏角色"
          aria-label="显示/隐藏角色"
          @click="layout.toggleLive2d()"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
        </button>
        <CyConnectionPanel />
      </div>
    </header>

    <CyMessageList />
    <CyLiveToolCards />
    <CyChatInput />
    <!-- P4-B TTS 播放宿主：隐藏 <audio>，由 voiceStore.tts.url 驱动（spec §5.12 / D-P8） -->
    <CyTtsPlayer />
  </section>
</template>

<style scoped>
.cy-chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* UII-QQ：紧凑头部（桌面聊天应用水平），标题主体化 */
.cy-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 50px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--cy-border);
  background: var(--cy-surface);
  container-type: inline-size; /* 连接入口据此容器查询降级 */
  min-width: 0;
}

.cy-chat-heading {
  min-width: 0;
}

.cy-chat-heading h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cy-header-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto; /* 极端窄聊天下不收缩，给标题省略留空间 */
}

.cy-action-button {
  padding: 7px 11px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--cy-muted);
  font-size: 12px;
  white-space: nowrap;
}

.cy-action-button:hover {
  color: var(--cy-text);
  background: var(--cy-surface-hover);
}

.cy-action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 角色紧凑图标钮（降低视觉权重，但保 live2dShown 时可再展开的入口） */
.cy-action-icon {
  display: grid;
  place-items: center;
  padding: 7px 9px;
}
.cy-action-icon[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}
</style>
