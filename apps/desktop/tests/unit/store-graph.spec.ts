// tests/unit/store-graph.spec.ts（多套 UI 基础 / 架构门禁，2026-09-10）
//
// 目的：把「store 之间不得有循环依赖」从口头约定变成可执行门禁。
//
// 背景（审计实测）：Pinia 的 `useXStore()` 在函数体内惰性求值，因此 ESM 循环 import 不会在
// 加载期爆炸——环被**执行时机**掩盖，只在特定调用顺序下暴露为「取到未初始化 store」。
// 这类缺陷没有编译期信号、也没有运行期红灯，只能靠静态图检查兜住。
//
// 判定：对 store 依赖图求强连通分量（Tarjan）。任何 >1 节点的分量即为环。
// 依赖来源为源码里的 `from './xxx.store'` 静态 import——这是唯一的 store 间耦合渠道。
//
// 节点环境：直接读源码文本。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const STORES_DIR = join(__dirname, '../../src/renderer/src/stores')

/** store 名（去 `.ts`），仅含 store 文件本身 */
const storeFiles = readdirSync(STORES_DIR).filter((f) => f.endsWith('.store.ts'))

/** 剥掉行注释与块注释：否则注释里举例的 `from './x.store'` 会被当成真实依赖
 *  （实测踩过：一条解释性注释凭空造出一条边，使门禁报出并不存在的环）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 文件名 → 该文件静态 import 的其它 store（按文件名） */
function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of storeFiles) {
    const source = stripComments(readFileSync(join(STORES_DIR, file), 'utf8'))
    const deps = new Set<string>()
    for (const m of source.matchAll(/from '\.\/([a-z0-9-]+)\.store'/g)) {
      deps.add(`${m[1]}.store.ts`)
    }
    graph.set(file, [...deps].sort())
  }
  return graph
}

/** Tarjan 强连通分量（迭代式，避免深递归爆栈） */
function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  // 显式工作栈：(节点, 下一个待访问的邻居下标)
  for (const root of graph.keys()) {
    if (index.has(root)) continue
    const work: Array<[string, number]> = [[root, 0]]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const [node, next] = frame
      if (next === 0) {
        index.set(node, counter)
        low.set(node, counter)
        counter++
        stack.push(node)
        onStack.add(node)
      }
      const neighbours = graph.get(node) ?? []
      if (next < neighbours.length) {
        frame[1] = next + 1
        const target = neighbours[next]
        if (!graph.has(target)) continue   // import 了非 store 文件，忽略
        if (!index.has(target)) {
          work.push([target, 0])
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node)!, index.get(target)!))
        }
      } else {
        work.pop()
        if (low.get(node) === index.get(node)) {
          const component: string[] = []
          let popped: string
          do {
            popped = stack.pop()!
            onStack.delete(popped)
            component.push(popped)
          } while (popped !== node)
          components.push(component)
        }
        if (work.length > 0) {
          const parent = work[work.length - 1][0]
          low.set(parent, Math.min(low.get(parent)!, low.get(node)!))
        }
      }
    }
  }
  return components
}

describe('store 依赖图：不得有循环依赖', () => {
  it('图可解析且非空（防解析失效导致下一条空过）', () => {
    const graph = buildGraph()
    expect(graph.size).toBeGreaterThanOrEqual(15)
    const edgeCount = [...graph.values()].reduce((n, d) => n + d.length, 0)
    expect(edgeCount).toBeGreaterThan(10)
  })

  it('无强连通分量大于 1（即无环）', () => {
    const graph = buildGraph()
    const cycles = stronglyConnectedComponents(graph).filter((c) => c.length > 1)
    // 失败时打印环路，便于定位
    const report = cycles.map((c) => [...c].sort().join(' ↔ ')).sort()
    expect(report).toEqual([])
  })

  it('会话身份单例 stores/session.ts 零 store 依赖（解环基石，不得回退）', () => {
    const source = readFileSync(join(STORES_DIR, 'session.ts'), 'utf8')
    expect(source.match(/from '\.\/[a-z0-9-]+\.store'/g) ?? []).toEqual([])
  })
})
