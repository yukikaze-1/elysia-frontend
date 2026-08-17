// apps/desktop/src/renderer/src/live2d/controller.ts
// 阶段 5 批次 A（A6，spec §3.6/D5A-10）：Live2DController——Live2DAdapter 的上层状态机收口。
// 状态机：unloaded → loading → ready | failed → fallback（device_lost(adapter 抛 Live2DGpuLostError)→
// failed → fallback，静态头像回退；重建策略归批 C）。init 用 adapter.initialize + 默认模型（list 里第一个
// available；settingsStore 已选 modelId 时 store 随后 switchModel 覆盖）；switchModel 停当前 → adapter.createModel
// → 成功原子替换（失败保留原 modelId 置 error，旧 handle 继续渲染）；unload 全量释放（含 adapter.destroy，
// 供 store.dispose 无残留）；reset 释放后重建默认模型。setState/setExpression/playMotion/setMouthLevel/
// setLookTarget 为批次 A no-op 占位（批次 B 落地，YAGNI）。
//
// 约定：adapter.createModel 的 model3Path 恒传 'model3.json'（Task 4 装配强制该文件存在且 manifest.modelFile
// 指向之；Controller 不读 summary.modelFile——Minor G）。事件极简：'device_lost'（GPU-lost → 上层回退）、
// 'status'（每次状态迁移广播）、'error'（switchModel 失败，载荷为 Error）。
import { Live2DGpuLostError, type Live2DAdapter, type Live2DModelHandle } from './adapter'
import type { Live2DModelSummary } from '@shared/contracts'

export type Live2DControllerStatus = 'unloaded' | 'loading' | 'ready' | 'failed' | 'fallback'
export type Live2DPerformanceMode = 'auto' | 'high' | 'low'

export interface Live2DControllerDeps {
  /** 渲染适配器（真实 webglEngine 或单测 fake） */
  adapter: Live2DAdapter
  /** 模型摘要清单（真实走 preload live2d:list-models；单测注入 fake registry） */
  list: () => Promise<Live2DModelSummary[]>
}

export type Live2DControllerEvent = 'device_lost' | 'status' | 'error'
type EventListener = (payload?: unknown) => void

/** 极简事件发射器（on/emit；on 返回退订函数） */
export class Live2DController {
  private readonly adapter: Live2DAdapter
  private readonly list: () => Promise<Live2DModelSummary[]>
  private handle: Live2DModelHandle | null = null
  private canvas: HTMLCanvasElement | null = null
  private currentId: string | null = null
  private currentStatus: Live2DControllerStatus = 'unloaded'
  private visible = true
  private perfMode: Live2DPerformanceMode = 'auto'
  private switching = false // switchModel 重入串行守卫（独立于 status：init 内部也置 loading 后调 switchModel）
  private listeners = new Map<Live2DControllerEvent, Set<EventListener>>()

  constructor(deps: Live2DControllerDeps) {
    this.adapter = deps.adapter
    this.list = deps.list
  }

  get status(): Live2DControllerStatus {
    return this.currentStatus
  }

  get modelId(): string | null {
    return this.currentId
  }

  /** 初始化：adapter.initialize + 默认模型（list 里第一个 available）。GL 创建失败/无可用模型 → fallback
   *  （静态头像回退，不阻塞聊天）。已 ready/loading 时幂等返回。 */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (this.currentStatus === 'ready' || this.currentStatus === 'loading') return
    if (!this.adapter.initialize(canvas)) {
      // context 创建失败 → 静态头像回退（A2 initialize 返回 false，不抛）
      this.canvas = canvas
      this.setStatus('fallback')
      return
    }
    this.canvas = canvas
    this.setStatus('loading')
    try {
      const models = await this.list()
      const first = models.find((m) => m.available)
      if (!first) {
        // 无可用的本地模型 → 静态头像回退（不放 loading 悬置）
        this.setStatus('fallback')
        return
      }
      await this.switchModel(first.id)
    } catch (e) {
      this.setStatus('failed')
      this.emit('error', e)
      throw e
    }
  }

  /** 切换模型：停当前（成功后原子替换）→ adapter.createModel → 成功替换 handle/id；失败保留原 modelId
   *  与旧 handle（继续渲染），置 status=failed 并 rethrow（store 捕获置 error）。model3Path 恒 'model3.json'。 */
  async switchModel(id: string): Promise<void> {
    if (this.currentId === id && this.currentStatus === 'ready') return // 同模型幂等
    if (this.switching) return // 切换中串行守卫（store 串行化，防重入；init 置 loading 后仍可进入）
    this.switching = true
    this.setStatus('loading')
    try {
      const next = await this.adapter.createModel({ modelId: id, model3Path: 'model3.json' })
      this.handle?.destroy()
      this.handle = next
      this.currentId = id
      this.setStatus('ready')
    } catch (e) {
      // 失败保留原模型：handle/currentId 不动；有旧 handle（切换前已 ready）回 ready，否则 failed
      this.setStatus(this.handle ? 'ready' : 'failed')
      this.emit('error', e)
      throw e
    } finally {
      this.switching = false
    }
  }

  /** 全量释放（store.dispose 调用）：释放当前模型 + adapter.destroy（unregister contextlost + 清 GL 引用），
   *  回到 unloaded。adapter 可随后 init 重建（重新创建 GL context）。幂等。 */
  unload(): void {
    this.adapter.destroy()
    this.handle = null
    this.currentId = null
    this.setStatus('unloaded')
  }

  /** 渲染 tick（Panel rAF 循环驱动）：ready 态调用 adapter.update（model.update + physics + draw）；
   *  GPU-lost（adapter 抛 Live2DGpuLostError）→ failed → emit device_lost → fallback（静态头像，重建归批 C）；
   *  其他异常静默吞掉（不崩溃渲染循环）。隐藏/非 ready 时 no-op。 */
  tick(): void {
    if (this.currentStatus !== 'ready' || !this.visible) return
    try {
      this.adapter.update()
    } catch (e) {
      if (e instanceof Live2DGpuLostError) {
        this.handle?.destroy()
        this.handle = null
        this.setStatus('failed')
        this.emit('device_lost')
        this.setStatus('fallback')
      } else {
        // 其他渲染异常：记录但不崩循环（组件级错误态已覆盖）
        this.emit('error', e)
      }
    }
  }

  /** 重建：全量释放后按默认模型（第一个 available）重新加载。canvas 未持有（未 init）时仅复位。 */
  async reset(): Promise<void> {
    const canvas = this.canvas
    this.unload()
    if (!canvas) return
    if (!this.adapter.initialize(canvas)) {
      this.setStatus('fallback')
      return
    }
    this.setStatus('loading')
    try {
      const models = await this.list()
      const first = models.find((m) => m.available)
      if (!first) {
        this.setStatus('fallback')
        return
      }
      await this.switchModel(first.id)
    } catch (e) {
      this.setStatus('failed')
      this.emit('error', e)
      throw e
    }
  }

  /** 可见性（布局级隐藏时停渲染循环，不产生帧；不销毁资源） */
  setVisibility(v: boolean): void {
    this.visible = v
  }

  /** 性能模式（批次 A 仅记录；帧率/渲染节流归批次 B 落地，YAGNI） */
  setPerformanceMode(m: Live2DPerformanceMode): void {
    this.perfMode = m
  }

  get performanceMode(): Live2DPerformanceMode {
    return this.perfMode
  }

  // —— 批次 A no-op 占位（批次 B 落地；YAGNI，避免过度实现）——
  setState(_s: unknown): void { /* no-op */ }
  setExpression(_e: unknown): void { /* no-op */ }
  playMotion(_g: unknown, _i: unknown): void { /* no-op */ }
  setMouthLevel(_l: number): void { /* no-op */ }
  setLookTarget(_x: number, _y: number): void { /* no-op */ }

  /** 订阅事件；返回退订函数 */
  on(event: Live2DControllerEvent, cb: EventListener): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }

  private emit(event: Live2DControllerEvent, payload?: unknown): void {
    const set = this.listeners.get(event)
    if (set) for (const cb of Array.from(set)) cb(payload)
  }

  private setStatus(s: Live2DControllerStatus): void {
    if (this.currentStatus === s) return
    this.currentStatus = s
    this.emit('status', s)
  }
}