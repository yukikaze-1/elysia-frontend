/// <reference types="vite/client" />

// tests 目录内组件测试（happy-dom + Vue Test Utils）的 .vue 模块声明。
// 供 tsconfig.node.json（include tests/**/*）识别 `import CyXxx from '...CyXxx.vue'`。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
