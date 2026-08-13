import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './tokens.css'
import { setDesktopApi } from './stores/desktop-api'
import { useConnectionStore } from './stores/connection.store'
import { useMessageStore } from './stores/message.store'
import { useConversationStore } from './stores/conversation.store'
import { createRendererBootstrap } from './bootstrap'

const app = createApp(App)
app.use(createPinia())

// P2-1 + R3:Pinia install 之后接线(Pinia 已 setActivePinia,use*Store() 才可用)——注入 api + 常驻订阅(store 级,组件卸载无关)。
// P0-01:订阅与启动 snapshot 水合编排收敛到 bootstrap(epoch 防迟到 snapshot 覆盖新 push)。
// P3-6:desktopApi 守卫——仅 Electron preload contextBridge 注入;普通浏览器打开产物时 window.desktopApi 为 undefined,不接线不抛错。
if (window.desktopApi) {
  setDesktopApi(window.desktopApi)
  createRendererBootstrap(window.desktopApi, {
    connection: useConnectionStore(),
    message: useMessageStore(),
    conversation: useConversationStore()
  }).register()
}

app.mount('#app')
