import { z } from 'zod'

export type ToolPermissionMode = 'automatic' | 'scoped_or_prompt' | 'always_prompt' | 'prohibited'
export type ToolExecutorName = 'file.select' | 'file.read' | 'file.write' | 'screen.capture'

export interface RegisteredTool {
  name: string; version: string; runtime: 'desktop'
  title: string; description: string; dataFlowNote: string
  localRisk: 'safe' | 'medium' | 'high'
  permissionMode: ToolPermissionMode
  supportedPlatforms: Array<'windows' | 'linux'>
  inputSchema: z.ZodType<unknown>; outputSchema: z.ZodType<unknown>
  executeRef: ToolExecutorName
  defaultTimeoutMs: number
  isPathTool: boolean
}

/** 必须与后端 core/tools/desktop/plugin.py::_DesktopPluginBase.version 严格一致。 */
export const DESKTOP_TOOL_VERSION = '1.0.0'

export const TOOL_NAMES = ['desktop.file.select', 'desktop.file.read', 'desktop.file.write', 'desktop.screen.capture'] as const

export function createToolRegistry(): Map<string, RegisteredTool> {
  const r = new Map<string, RegisteredTool>()
  const put = (t: RegisteredTool) => { r.set(t.name, t) }
  put({
    name: 'desktop.file.select', version: DESKTOP_TOOL_VERSION, runtime: 'desktop', title: '选择文件',
    description: '打开系统文件选择器，由用户主动选择文件。', localRisk: 'safe', permissionMode: 'automatic',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ title: z.string().optional() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '选择的文件路径、大小与哈希摘要将发送到已连接的后端服务器；文件内容不会自动上传。',
    executeRef: 'file.select', defaultTimeoutMs: 60_000, isPathTool: false,
  })
  put({
    name: 'desktop.file.read', version: DESKTOP_TOOL_VERSION, runtime: 'desktop', title: '读取文件',
    description: '读取用户选择或明确授权的 UTF-8 文本文件（≤2 MiB）。', localRisk: 'medium', permissionMode: 'scoped_or_prompt',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '读取的文件内容（≤64 KiB 内联 / 更大经附件上传）将发送到已连接的后端服务器。',
    executeRef: 'file.read', defaultTimeoutMs: 30_000, isPathTool: true,
  })
  put({
    name: 'desktop.file.write', version: DESKTOP_TOOL_VERSION, runtime: 'desktop', title: '写入文件',
    description: '写入或覆盖文本文件（写前展示差异，原子替换，冲突保护）。', localRisk: 'high', permissionMode: 'always_prompt',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '写入内容将覆盖/创建目标文件，文件内容将发送到已连接的后端服务器。',
    executeRef: 'file.write', defaultTimeoutMs: 30_000, isPathTool: true,
  })
  put({
    name: 'desktop.screen.capture', version: DESKTOP_TOOL_VERSION, runtime: 'desktop', title: '屏幕截图',
    description: '捕获所选屏幕或窗口（选择 → 预览 → 确认上传）。', localRisk: 'high', permissionMode: 'always_prompt',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ region: z.string().nullish() }).strict(),   // region:null 放行（H1/M-6，后端恒发 {"region":null}）
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '所选屏幕/窗口截图将发送到已连接的后端服务器。',
    executeRef: 'screen.capture', defaultTimeoutMs: 120_000, isPathTool: false,
  })
  return r
}
