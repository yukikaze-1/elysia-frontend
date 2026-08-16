import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './tokens.css'
import { setDesktopApi } from './stores/desktop-api'
import { useConnectionStore } from './stores/connection.store'
import { useMessageStore } from './stores/message.store'
import { useConversationStore } from './stores/conversation.store'
import { useLayoutStore } from './stores/layout.store'
import { useDraftStore } from './stores/draft.store'
import { useCacheStore } from './stores/cache.store'
import { useVoiceStore } from './stores/voice.store'
import { useSettingsStore } from './stores/settings.store'
import { createRendererBootstrap } from './bootstrap'

const app = createApp(App)
app.use(createPinia())

// G1（spec §4.5/P2-2）：createPinia 之后、mount 之前同步 hydrate 布局偏好，避免首帧闪默认布局
useLayoutStore().hydrate()

// P2-1 + R3:Pinia install 之后接线(Pinia 已 setActivePinia,use*Store() 才可用)——注入 api + 常驻订阅(store 级,组件卸载无关)。
// P0-01:订阅与启动 snapshot 水合编排收敛到 bootstrap(epoch 防迟到 snapshot 覆盖新 push)。
// P3-6:desktopApi 守卫——仅 Electron preload contextBridge 注入;普通浏览器打开产物时 window.desktopApi 为 undefined,不接线不抛错。
if (window.desktopApi) {
  setDesktopApi(window.desktopApi)
  createRendererBootstrap(window.desktopApi, {
    connection: useConnectionStore(),
    message: useMessageStore(),
    conversation: useConversationStore(),
    draft: useDraftStore(),
    cache: useCacheStore(),
    voice: useVoiceStore(),
    settings: useSettingsStore()
  }).register()
}

app.mount('#app')
