<script setup lang="ts">
// CyChatView:聊天主区——头部(仅会话标题) + CyMessageList(自研虚拟列表,窗口化渲染)+ CyChatInput。
// conversationStore 激活/新建(F1:create 不 reset messageStore,新建后须显式 activate(c.id))。
// UII-QQ IA 调整：头部只保留会话标题——聊天记录/资源移入 Composer 工具栏（CyChatInput），
// 连接状态移入 NavRail 底部（CyConnectionPanel），角色开关改为聊天区右缘折叠把手（仅面板隐藏时显示）。
import { computed } from 'vue'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useLayoutStore } from '../stores/layout.store'
import { useAppStore } from '../stores/app.store'
import CyMessageList from './CyMessageList.vue'
import CyChatInput from './CyChatInput.vue'
import CyTtsPlayer from './CyTtsPlayer.vue'
import CyLiveToolCards from './CyLiveToolCards.vue'   // 阶段 6 批次 B（Task 7）：工具实时区（消息列表与输入区之间）

const conversationStore = useConversationStore()
const messageStore = useMessageStore()
const layout = useLayoutStore()
const appStore = useAppStore()

const convTitle = computed(() => {
  const c = conversationStore.items.find((i) => i.id === conversationStore.currentId)
  return c?.title ?? '新会话'
})
const currentCharacter = computed(() => conversationStore.currentCharacter)
// 长对话自动收紧顶部欢迎信息，给消息和输入区让出稳定空间；首轮仍保留完整上下文。
const compactHeader = computed(() => messageStore.order.length >= 4)

function openCharacterDetails(): void {
  const characterId = currentCharacter.value?.characterId
  if (characterId) appStore.openSettings('characters', characterId)
}

/** F1(Task 4 review):create 只设 currentId、不 reset messageStore——新建后显式 activate(c.id) 拉起空消息页
 *  UI 问题 6：删「新建」头部按钮——会话创建收敛到左侧列表头 +；此函数保留供列表复用（独立组件），头部不再入口。 */
</script>

<template>
  <section class="cy-chat" :class="{ 'cy-live2d-off': !layout.effective.live2dShown }">
    <header class="cy-chat-header" :class="{ 'is-compact': compactHeader }">
      <!-- UII-QQ IA：头部仅会话标题（左对齐可省略）。全局连接状态在 NavRail 底部；
           聊天记录/资源在 Composer 工具栏；角色开关在右缘把手（面板隐藏时显示） -->
      <div class="cy-chat-heading">
        <h2>{{ convTitle }}</h2>
        <div class="cy-chat-character" :class="{ 'is-legacy': !currentCharacter }">
          <span class="cy-chat-character-label">
            <span class="cy-chat-character-dot" :style="currentCharacter?.presentation.themeColor ? { backgroundColor: currentCharacter.presentation.themeColor } : undefined" aria-hidden="true"></span>
            {{ currentCharacter ? `角色 · ${currentCharacter.displayName}` : '未绑定角色' }}
          </span>
          <button v-if="currentCharacter" type="button" class="cy-chat-character-detail" @click="openCharacterDetails">查看角色详情</button>
        </div>
      </div>
    </header>

    <CyMessageList />
    <CyLiveToolCards />
    <CyChatInput />
    <!-- P4-B TTS 播放宿主：隐藏 <audio>，由 voiceStore.tts.url 驱动（spec §5.12 / D-P8） -->
    <CyTtsPlayer />

    <!-- UII-QQ IA：角色栏折叠把手——仅面板隐藏时显示；点击 toggleLive2d（layoutStore 语义不变）。
         位于聊天区右缘，.cy-live2d-off 时消息区让出 16px 边条，不遮挡滚动条/回到底部/输入区 -->
    <button
      v-if="!layout.effective.live2dShown"
      class="cy-live2d-handle"
      title="展开角色栏"
      aria-label="展开角色栏"
      @click="layout.toggleLive2d()"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
    </button>
  </section>
</template>

<style scoped>
.cy-chat {
  position: relative;   /* 右缘把手定位锚点 */
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* UII-QQ：紧凑头部（桌面聊天应用水平），标题主体化 */
.cy-chat-header {
  display: flex;
  align-items: center;
  gap: var(--cy-space-6);
  min-height: 50px;
  padding: var(--cy-space-4) var(--cy-space-7);
  border-bottom: 1px solid var(--cy-border);
  background: var(--cy-surface-glass);
  backdrop-filter: blur(18px) saturate(110%);
  min-width: 0;
  transition: min-height var(--cy-motion-base) ease, padding var(--cy-motion-base) ease;
}

.cy-chat-header.is-compact {
  min-height: 40px;
  padding-block: var(--cy-space-2);
}

.cy-chat-heading {
  min-width: 0;
}

.cy-chat-heading h2 {
  margin: 0;
  font-size: var(--cy-font-xl);
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cy-chat-header.is-compact .cy-chat-heading h2 {
  font-size: var(--cy-font-lg);
}

.cy-chat-header.is-compact .cy-chat-character {
  font-size: var(--cy-font-xs);
}

.cy-chat-header.is-compact .cy-chat-character-detail {
  display: none;
}

.cy-chat-character {
  display: flex;
  align-items: center;
  gap: var(--cy-space-3-5);
  min-width: 0;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-chat-character-label {
  display: inline-flex;
  align-items: center;
  gap: var(--cy-space-2-5);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-chat-character-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: var(--cy-radius-circle);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
}

.cy-chat-character-detail {
  flex: 0 0 auto;
  padding: var(--cy-space-1) var(--cy-space-3);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-3);
  background: var(--cy-surface-soft);
  color: var(--cy-accent-strong);
  font-size: var(--cy-font-xs);
}

.cy-chat-character-detail:hover {
  background: var(--cy-surface-hover);
}

.cy-chat-character-detail:focus-visible {
  outline: 2px solid var(--cy-accent-strong);
  outline-offset: 2px;
}

.cy-chat-character.is-legacy {
  color: var(--cy-muted);
}

/* 角色栏折叠态：消息区让出 16px 右边条给把手——滚动条随之左移，不被遮挡 */
.cy-chat.cy-live2d-off .cy-messages {
  border-right: 16px solid var(--cy-pane);
}

.cy-live2d-handle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  display: grid;
  place-items: center;
  width: 16px;
  height: 56px;
  padding: 0;
  color: var(--cy-muted);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-right: 0;
  border-radius: var(--cy-radius-4) 0 0 var(--cy-radius-4);
  box-shadow: -2px 0 6px rgb(0 0 0 / 0.06);
}

.cy-live2d-handle:hover {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border-color: var(--cy-accent);
}
</style>
