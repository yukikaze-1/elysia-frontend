// live2d/framework.d.ts
// 阶段 5 批次 A Task 1：Cubism Web Framework 的 ambient 类型桩。
//
// 背景：Framework 59 个 .ts 已原样 vendored 到 ./framework/（禁改本体），且从
// tsconfig.web.json 的 include 程序排除（Important B——否则 strict vue-tsc 编译 vendored 三方源码必挂）。
// 因此 renderer 内 `import { ... } from '@framework/...'` 在 TS 视角下必须经由本 ambient 桩解析；
// 运行时则由 electron.vite.config.ts 的 renderer resolve.alias `@framework` → 真实源码打包交付。
//
// 基线：通配 `@framework/*` 无体声明（模块整体类型 `any`）——命名/默认/命名空间三种 import 形式均可通过类型检查。
// 后续 Task 5（Adapter）可对实际用到的 3~4 个模块以「同模块名 + 显式导出面」的局部声明覆盖，收紧型面——
// 覆盖声明与通配声明并存时，TS 取更具体的匹配（module name 完全一致的声明优先于通配）。
declare module '@framework/*'
