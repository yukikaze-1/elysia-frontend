import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './tokens.css'
import { setDesktopApi } from './stores/desktop-api'
import { useConnectionStore } from './stores/connection.store'
import { useMessageStore } from './stores/message.store'

const app = createApp(App)
app.use(createPinia())

// P2-1 + R3:Pinia install 之后接线(Pinia 已 setActivePinia,use*Store() 才可用)——注入 api + 常驻订阅(store 级,组件卸载无关)。
// 断线→in-flight 置 interrupted 由 onChatState 回调编排(connectionStore.setState + messageStore.handleConnectionStateChange)。
setDesktopApi(window.desktopApi)
const connectionStore = useConnectionStore()
const messageStore = useMessageStore()
window.desktopApi.onChatEvent((e) => messageStore.applyEvent(e))
window.desktopApi.onChatState((s) => {
  connectionStore.setState(s)
  messageStore.handleConnectionStateChange(s)
})
window.desktopApi.onChatReplay(({ conversationId, messages }) => messageStore.loadReplay(conversationId, messages))

app.mount('#app')
