// src/renderer/src/utils/appearance.ts
//
// 「外观」设置的第一项：**全局字体缩放**（doc 03 §12.4「外观设置包括全局字体缩放…」、
// doc 11 §7.2「全局字体缩放…即时预览」；doc 16 规格漂移台账把它记为未实现）。
//
// 为什么不是 Electron 的 `setZoomFactor`/`setZoomLevel`：整体 zoom 会改变 CSS px 视口尺寸，
// 进而改变布局断点判定（`layout/constants.ts` 以 CSS px 为基准）与 Live2D 画布的取尺，
// 属"改窗口几何"而不是"改字号"；而且它在打包态还牵动菜单/role 的既有安全口径。
// 故判据取**纯 CSS**：根节点内联样式写 `--cy-user-font-scale`，由 `tokens.css` 的整条字号阶梯乘它。
//
// 关键事实（本项落地前实测）：`--cy-user-font-scale` 早已定义、也早已被 `body` 消费，
// 但 renderer 的 323 处 `font-size` 里 308 处用的是**绝对 px** 的 `--cy-font-*` token，
// 组件显式字号覆盖 body 继承 ⇒ 只给该变量赋值**视觉上几乎无效**。所以本项的落地包含
// "让阶梯自己乘这个变量"这一半（见 tokens.css），而不是只加一个设置项。
//
// 本模块刻意**不 import 任何 store**（与 reduce-motion 同款）：纯函数 + 注入 DOM 面，便于单测，
// 也避免 utils→stores 的反向依赖（store-graph 门禁）。store 接线放在组合根 `main.ts`。

/** 根节点上承载缩放比例的自定义属性名（`tokens.css` 的字号阶梯以此为乘数） */
export const USER_FONT_SCALE_VAR = '--cy-user-font-scale'

/** 缩放百分比范围与默认值。100 = 不缩放。 */
export const FONT_SCALE_MIN = 90
export const FONT_SCALE_MAX = 130
export const FONT_SCALE_DEFAULT = 100

/** UI 步进（滑杆）；schema 只校验范围与整数，不强制落在步进上（手改 settings.json 的 102 也应可用） */
export const FONT_SCALE_STEP = 5

/**
 * 收窄到合法区间并取整。
 * 非有限数（NaN/Infinity/undefined 经 Number 转换）一律回默认值——**不 fail-open 到"不缩放"以外的行为**：
 * 外观是纯展示项，退回 100% 是最不意外的结果。
 */
export function clampFontScale(percent: number): number {
  if (!Number.isFinite(percent)) return FONT_SCALE_DEFAULT
  const rounded = Math.round(percent)
  if (rounded < FONT_SCALE_MIN) return FONT_SCALE_MIN
  if (rounded > FONT_SCALE_MAX) return FONT_SCALE_MAX
  return rounded
}

/** 百分比 → CSS 乘数字符串（100 → '1'、105 → '1.05'、130 → '1.3'）。保留两位以避开浮点尾巴。 */
export function fontScaleToRatio(percent: number): string {
  const ratio = clampFontScale(percent) / 100
  // 去掉多余的 0（'1.30' → '1.3'、'1.00' → '1'）——只为让产物与断言可读，不影响语义
  return String(Number(ratio.toFixed(2)))
}

/** 只依赖用得到的那一点 DOM 面，便于注入假对象（与 reduce-motion 同款做法） */
export interface AppearanceRoot {
  style: { setProperty(name: string, value: string): void }
}

/**
 * 把缩放比例写到根节点，返回实际生效的乘数字符串（供断言与探针）。
 *
 * 写在根节点内联样式上：它压过 `tokens.css` 里 `:root` 的同名声明，
 * 且不需要新增/切换类名（字号是连续量，类名枚举反而会把可调范围钉死）。
 */
export function applyFontScale(root: AppearanceRoot, percent: number): string {
  const ratio = fontScaleToRatio(percent)
  root.style.setProperty(USER_FONT_SCALE_VAR, ratio)
  return ratio
}
