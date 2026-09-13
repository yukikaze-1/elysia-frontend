// live2d/framework.d.ts
// 阶段 5 批次 A Task 1：Cubism Web Framework 的 ambient 类型桩。
//
// 背景：Framework 59 个 .ts 已原样 vendored 到 ./framework/（禁改本体），且从
// tsconfig.web.json 的 include 程序排除（Important B——否则 strict vue-tsc 编译 vendored 三方源码必挂）。
// 因此 renderer 内 `import { ... } from '@framework/...'` 在 TS 视角下必须经由本 ambient 桩解析；
// 运行时则由 electron.vite.config.ts 的 renderer resolve.alias `@framework` → 真实源码打包交付。
//
// 基线：通配 `@framework/*` 无体声明（模块整体类型 `any`）——命名/默认/命名空间三种 import 形式均可通过类型检查。
// Task 5（Adapter）对实际用到的模块以「同模块名 + 显式导出面」的局部声明覆盖，收紧型面——
// 覆盖声明与通配声明并存时，TS 取更具体的匹配（module name 完全一致的声明优先于通配）。
// 下方局部声明的导出面/签名对照 vendored 真实源码核对（见 task-5 报告「Framework 实际使用的 API 与行号」）。

declare module '@framework/*'

declare module '@framework/live2dcubismframework' {
  // 对照 live2dcubismframework.ts：class CubismFramework（L74）、class Option（L263）、enum LogLevel（L271）
  export enum LogLevel {
    LogLevel_Verbose = 0,
    LogLevel_Debug = 1,
    LogLevel_Info = 2,
    LogLevel_Warning = 3,
    LogLevel_Error = 4,
    LogLevel_Off = 5
  }
  export class Option {
    // 对照 real Option（live2dcubismframework.ts:263）：logFunction 类型即 Core 的 csmLogFunction
    // （(message: string) => void）；此处按自包含函数类型声明，避免本 ambient 文件依赖 core d.ts 全局命名空间
    logFunction?: ((message: string) => void) | undefined
    loggingLevel?: LogLevel
  }
  export class CubismFramework {
    static startUp(option?: Option | null): boolean
    static initialize(memorySize?: number): void
    static dispose(): void
    static cleanUp(): void
    static isStarted(): boolean
    static isInitialized(): boolean
    static getIdManager(): unknown
  }
}

declare module '@framework/cubismmodelsettingjson' {
  // 对照 cubismmodelsettingjson.ts：class CubismModelSettingJson（L29）——本项目内核用到的方法面。
  // 批次 B（Task 2）补 motion/expression 枚举（L217-305）与 Layout（L383）：createModel 内摊平白名单 +
  // 读 Layout。
  export class CubismModelSettingJson {
    constructor(buffer: ArrayBuffer, size: number)
    getModelFileName(): string
    getTextureCount(): number
    getTextureFileName(index: number): string
    getPhysicsFileName(): string
    getPoseFileName(): string
    getExpressionCount(): number
    getExpressionFileName(index: number): string
    getMotionGroupCount(): number
    getMotionGroupName(index: number): string
    getMotionCount(groupName: string): number
    getMotionFileName(groupName: string, index: number): string
    getUserDataFile(): string
    getLayoutMap(outLayoutMap: Map<string, number>): boolean
    release(): void
  }
}

declare module '@framework/model/cubismmodel' {
  // 对照 model/cubismmodel.ts：class CubismModel（L192）——本项目内核用到的方法面。
  // 批次 B（Task 2，B3 adapter 面）增参数通道方法：
  //  getParameterIndex(L610)/getParameterCount(L641)/getParameterId(L690)/setParameterValueById(L773)。
  // 注：getParameterIndex 对未知 Id 会把 not-exist 索引合成进 `[getParameterCount(), …)` 域（L627-634），
  // 永不为 -1——setParam 用真域判定拦截。
  export class CubismModel {
    update(): void
    getCanvasWidth(): number
    getCanvasHeight(): number
    saveParameters(): void
    loadParameters(): void
    release(): void
    getParameterCount(): number
    /** parameterIndex 未知时返回合成 not-exist 索引（≥ getParameterCount()），不是 -1 */
    getParameterIndex(parameterId: unknown): number
    /** 返回 CubismId（含 .getString()）——CubismId 方法为 .getString()（id/cubismid.ts:32），无 .getId() */
    getParameterId(parameterIndex: number): { getString(): string }
    setParameterValueById(parameterId: unknown, value: number, weight?: number): void
  }
}

declare module '@framework/model/cubismmoc' {
  // 对照 model/cubismmoc.ts：class CubismMoc（L16）——create/createModel/deleteModel/release
  import type { CubismModel } from '@framework/model/cubismmodel'
  export class CubismMoc {
    static create(mocBytes: ArrayBuffer, shouldCheckMocConsistency?: boolean): CubismMoc | null
    static delete(moc: CubismMoc): void
    createModel(): CubismModel
    deleteModel(model: CubismModel): void
    release(): void
  }
}

declare module '@framework/physics/cubismphysics' {
  // 对照 physics/cubismphysics.ts：class CubismPhysics（L44）——create(L51)/delete(L64)/evaluate(L485)
  import type { CubismModel } from '@framework/model/cubismmodel'
  export class CubismPhysics {
    static create(buffer: ArrayBuffer, size: number): CubismPhysics | null
    static delete(physics: CubismPhysics): void
    evaluate(model: CubismModel, deltaTimeSeconds: number): void
  }
}

declare module '@framework/rendering/cubismrenderer_webgl' {
  // 对照 rendering/cubismrenderer_webgl.ts：class CubismRenderer_WebGL（L486）——
  // 本项目内核用到的面：initialize(L495)/bindTexture(L587)/release(L692)/loadShaders(L767)/
  // doDrawModel(L793 内部)/startUp(L1637)/setRenderState(L1514)/drawModel(基类 cubismrenderer.ts L59)
  import type { CubismModel } from '@framework/model/cubismmodel'

  /** 本项目适配器实际消费的 Mvp 矩阵面（CubismMatrix44.setMatrix） */
  export interface Live2DCubismMvp {
    setMatrix(tr: Float32Array): void
    getArray(): Float32Array
  }
  export class CubismRenderer_WebGL {
    constructor(width: number, height: number)
    initialize(model: CubismModel, maskBufferCount?: number): void
    startUp(gl: WebGLRenderingContext): void
    bindTexture(modelTextureNo: number, glTexture: WebGLTexture): void
    setIsPremultipliedAlpha(enable: boolean): void
    setMvpMatrix(matrix44: Live2DCubismMvp): void
    getMvpMatrix(): Live2DCubismMvp
    setRenderState(fbo: WebGLFramebuffer | null, viewport: number[]): void
    drawModel(shaderPath?: string): void
    loadShaders(shaderPath?: string): void
    release(): void
  }
}

// —— 2026-09-13（type-aware lint 全集批次）补的五个模块 ——
//
// 这五个模块此前只落在 `@framework/*` 通配（模块整体 `any`），于是 adapter 里
// `new CubismMotionManager()` / `CubismMotion.create(...)` / `mvp.setupFromLayout(...)` 全部是
// "unsafe call/construction/member access"（实测 6 条）。按本文件既定的做法（第 10-12 行：
// 「对实际用到的模块以同模块名 + 显式导出面覆盖，收紧型面」）补齐——**不加 any、不加 eslint-disable**。
// 签名逐条对照 vendored 源码：cubismmotionmanager.ts:62（startMotionPriority，priority: number）、
// cubismmotionqueuemanager.ts:56（startMotion，userTimeSeconds 可选）与 :152（stopAllMotions）、
// cubismmotionmanager.ts:84 与 cubismexpressionmotionmanager.ts:107（updateMotion → boolean）、
// cubismmotion.ts:327 与 cubismexpressionmotion.ts:42（static create(buffer, size)）、
// cubismmodelmatrix.ts:22（constructor(w?, h?)）与 :160（setupFromLayout(Map<string, number>)）。

declare module '@framework/motion/cubismmotion' {
  import type { CubismModel } from '@framework/model/cubismmodel'
  /** 对照 motion/cubismmotion.ts：本项目只消费 `create` 与"可被 manager 接管"这一身份 */
  export class CubismMotion {
    static create(buffer: ArrayBuffer, size: number): CubismMotion
    updateParameters(model: CubismModel, userTimeSeconds: number): boolean
  }
}

declare module '@framework/motion/cubismexpressionmotion' {
  export class CubismExpressionMotion {
    static create(buffer: ArrayBuffer, size: number): CubismExpressionMotion
  }
}

declare module '@framework/motion/cubismmotionmanager' {
  import type { CubismModel } from '@framework/model/cubismmodel'
  import type { CubismMotion } from '@framework/motion/cubismmotion'
  export class CubismMotionManager {
    constructor()
    /** 返回本次开始的识别号；开始不了时为 -1（cubismmotionmanager.ts:62-74） */
    startMotionPriority(motion: CubismMotion, autoDelete: boolean, priority: number): number
    stopAllMotions(): void
    /** 推进一帧；返回"本帧是否有动作被更新"（cubismmotionmanager.ts:84） */
    updateMotion(model: CubismModel, deltaTimeSeconds: number): boolean
  }
}

declare module '@framework/motion/cubismexpressionmotionmanager' {
  import type { CubismModel } from '@framework/model/cubismmodel'
  import type { CubismExpressionMotion } from '@framework/motion/cubismexpressionmotion'
  export class CubismExpressionMotionManager {
    constructor()
    /** 继承自 CubismMotionQueueManager.startMotion（cubismmotionqueuemanager.ts:56） */
    startMotion(motion: CubismExpressionMotion, autoDelete: boolean, userTimeSeconds?: number): number
    stopAllMotions(): void
    updateMotion(model: CubismModel, deltaTimeSeconds: number): boolean
  }
}

declare module '@framework/math/cubismmodelmatrix' {
  /** 对照 math/cubismmodelmatrix.ts:15（extends CubismMatrix44）——本项目只消费构造与 Layout 装配 */
  export class CubismModelMatrix {
    constructor(w?: number, h?: number)
    setupFromLayout(layout: Map<string, number>): void
    getArray(): Float32Array
  }
}
