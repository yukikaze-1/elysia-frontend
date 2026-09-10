// tests/unit/setup/live2dcubismcore.ts
//
// Live2D Cubism Core 全局桩（单测环境）。
//
// 为什么需要：vendored Framework 的 `framework/model/cubismmodel.ts` 在**模块作用域**
// 初始化枚举 `CubismColorBlend = Live2DCubismCore.ColorBlendType_*`——即「import 该模块」
// 本身就会访问全局 `Live2DCubismCore`。真实运行时该全局由 renderer 的
// `live2dcubismcore.min.js` <script> 提供（先于应用脚本加载）。
//
// 此前该桩以 `vi.hoisted` 形式只写在 tests/unit/live2d.spec.ts 内。后果是：
// 任何新出现的「组件 → live2d.store」import 链，都会让**看似无关的组件测试**在加载阶段
// 抛 `ReferenceError: Live2DCubismCore is not defined`——测试能否跑起来取决于间接依赖顺序，
// 而不是被测行为。（实测踩过：CyTtsPlayer 为口部接线引入 live2d.store 后，
// cy-conversation-list.spec 立即以 0 test 崩掉。）
//
// 提升为全局 setup 后，单测环境与生产环境一致（Core 恒在），import 链变化不再影响可测性。
// 只提供模块加载所需的枚举常量；真实装配/渲染走 renderer 全局 Core，归集成层与真机。
const names = [
  'Normal', 'AddGlow', 'Add', 'Darken', 'Multiply', 'ColorBurn', 'LinearBurn', 'Lighten', 'Screen',
  'ColorDodge', 'Overlay', 'SoftLight', 'HardLight', 'LinearLight', 'Hue', 'Color',
  'AddCompatible', 'MultiplyCompatible'
] as const

const ColorBlendType: Record<string, number> = {}
names.forEach((n, i) => { ColorBlendType[`ColorBlendType_${n}`] = i })

const g = globalThis as Record<string, unknown>
if (g.Live2DCubismCore === undefined) {
  g.Live2DCubismCore = { ColorBlendType }
}
