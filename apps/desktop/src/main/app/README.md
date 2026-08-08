# app — 应用身份与生命周期

阶段 1 填充：`lifecycle.ts`（installAppIdentity：app.setName('Cyrene') / setPath(userData) / baseCreated，pre-ready）+ `app-info.ts`（getAppInfo）。`index.ts` 保留薄入口，应用装配与生命周期逻辑收敛于此。
