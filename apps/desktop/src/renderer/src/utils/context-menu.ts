// src/renderer/src/utils/context-menu.ts
// 右键菜单项的类型（2026-09-13）。
//
// 单独成文件而不是写在 `CyContextMenu.vue` 的 `<script setup>` 里：`<script setup>` 内的
// `export interface` **不能**作为具名导出被外部 import（vue-tsc 的模块类型里没有它），
// 而消费方（会话列表、消息列表、单测）都要用这个类型来标注自己的菜单项数组。
export interface ContextMenuItem {
  id: string
  label: string
  disabled?: boolean
  /** 破坏性操作（删除）——用危险色，且不与普通项同权重 */
  danger?: boolean
}
