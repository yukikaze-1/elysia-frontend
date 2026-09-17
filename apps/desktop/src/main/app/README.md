# app — 应用身份与生命周期

阶段 1 填充：`lifecycle.ts`（installAppIdentity：app.setName('Cyrene') / setPath(userData) / baseCreated，pre-ready）+ `app-info.ts`（getAppInfo）。后续批次另有 `process-error-guards.ts`（未捕获异常/拒绝、`child-process-gone`）与 `test-app-data.ts`（harness 的 appData 覆写门）。

**装配不在本目录**（2026-09-17 架构整改 Prompt 2 后）：`src/main/index.ts` 只是 99 行的组合根，按生命周期阶段编排 `src/main/bootstrap/**`（pre-ready / infrastructure / transport / services / wire / register-ipc / shutdown-sequence / start-application / runtime-guards / test-probe）。`app/` 保留应用身份与进程级生命周期。目录地图见 `docs/20-Cyrene-前端架构现状总览.md` §2.1。
