// src/main/transport/backend-adapter.ts —— 后端适配器**聚合面**（架构整改 Prompt 3 后的形态）。
//
// 此文件在 Prompt 3 之前是"一个 43 方法的宽接口"，同时充当聚合面与唯一注入面——于是任何
// Application Service 拿到它就理论上能调用几乎整个后端能力面。现在：
//   · 领域能力面在 `backend-ports.ts`（7 个端口，按稳定业务能力划分）；
//   · 本文件只剩**聚合交集 + 传输层接线槽**，用途是两处：
//       ① RealBackend / MockBackend 的 `implements` 声明（编译期证明两者满足同一组能力面）；
//       ② 组合根（`bootstrap/**`）持有具体实例时所需的类型（`Transport.adapter` 与其接线槽）。
//   · Application Service **不得**依赖本接口：`tests/unit/backend-capability-ports.spec.ts`
//     会红（源码级门禁：聚合面只允许出现在 `transport/**` 与 `bootstrap/**`）。
//
// 各端口的方法、语义与消费者见 `backend-ports.ts` 的逐端口头注。此文件刻意不再声明任何方法，
// 以免"聚合面"重新变成可以就地增长的地方——新增后端能力必须先落到某个领域端口。
import type { DesktopToolRequest } from '../tools/tool-execution-contract'   // 传输层只依赖工具域**执行契约**，不依赖 tool-service 实现（2026-09-17 架构整改 Prompt 1）
import type {
  AttachmentBackendPort,
  BackendConnectionPort,
  BackendEventSourcePort,
  ChatBackendPort,
  ModelBackendPort,
  ToolBackendPort,
  VoiceBackendPort
} from './backend-ports'

/**
 * 后端适配器的完整能力面 = 7 个领域端口 + 传输层接线槽（对应 docs/01 §6.1）。
 * 所有协议差异（URL、字段名、WS/SSE、ID）都由实现类消化；消费方只依赖它需要的那**一个**端口视图。
 */
export interface BackendAdapter
  extends BackendConnectionPort,
    BackendEventSourcePort,
    ChatBackendPort,
    AttachmentBackendPort,
    ModelBackendPort,
    VoiceBackendPort,
    ToolBackendPort {
  /**
   * 桌面工具请求的**接线槽**（阶段 6 批次 B Task 6，D6B-08/D6B-15）：real 专用——handleFrame
   * case 'tool.request' 路由至此（不再 emit 领域事件）；组合根在 adapter 构造后注入（避免构造环）。
   * mock 不实现（MockBackend 经 `toolRequestSink` 构造注入，D6B-15）。
   *
   * 它是"回调槽"而不是"应用能力"，故**不属于任何端口**：端口只描述能调用什么，
   * 可变状态由传输层自己持有、由组合根在单一写入点赋值（`bootstrap/transport.ts`）。
   */
  onToolRequest?: (req: DesktopToolRequest) => void
}
