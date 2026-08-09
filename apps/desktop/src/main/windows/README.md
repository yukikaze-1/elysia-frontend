# windows — 主窗口管理

阶段 1 填充：`main-window.ts`（createMainWindow：webPreferences 安全基线 sandbox/contextIsolation/nodeIntegration、window-open 拦截、cyrene:// 协议加载），从 index.ts 迁出并加固。加载形态：dev（ELECTRON_RENDERER_URL 存在）= Vite http；构建/打包/无 dev server = `cyrene://renderer/index.html`。
