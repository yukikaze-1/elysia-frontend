import { z } from 'zod'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import {
  ActivateConversationResultSchema,
  BackendSessionSchema,
  ClientRequestRefSchema,
  ConnectionStateSchema,
  ConversationSchema,
  EndpointResponseSchema,
  MessagePageSchema,
  PageSchema,
  RuntimeInfoSchema
} from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import {
  chatActivateSchema,
  chatCancelSchema,
  chatConnectSchema,
  chatCreateSchema,
  chatDeleteSchema,
  chatGetEndpointSchema,
  chatGetMessagesSchema,
  chatGetRuntimeInfoSchema,
  chatGetStateSchema,
  chatListConversationsSchema,
  chatRenameSchema,
  chatSendSchema,
  chatSetEndpointSchema
} from '../ipc/channels'
import type { ChatService } from './chat-service'

/**
 * P0 响应校验：各命令传共享领域 responseSchema（spec §4.1.2 表格；共享定义见 shared/schemas/ipc-response）。
 * 成功 {ok:true,data} 按对应 schema 校验，失败 {ok:false,error} 恒校验。
 */
export function registerChatHandlers(opts: { svc: ChatService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { svc, sanitize, logger } = opts
  const handle = <TReq, TRes>(
    requestSchema: z.ZodType<TReq>,
    responseSchema: z.ZodType<TRes>,
    fn: (req: TReq) => TRes | Promise<TRes>,
    channel: IpcChannelName
  ): ((raw: unknown) => Promise<IpcResult<TRes>>) =>
    createIpcHandler(requestSchema, responseSchema, fn, { sanitize, channel, logger })

  registerHandler(IpcChannels.chatConnect, handle(chatConnectSchema, BackendSessionSchema, () => svc.connect(), IpcChannels.chatConnect), 0)   // 无参：endpoint/token 由 connection-config 持有
  registerHandler(IpcChannels.chatSetEndpoint, handle(chatSetEndpointSchema, z.object({ endpoint: z.string() }), (req) => svc.setEndpoint(req.serverUrl), IpcChannels.chatSetEndpoint), 1)
  registerHandler(IpcChannels.chatGetEndpoint, handle(chatGetEndpointSchema, EndpointResponseSchema, () => svc.getEndpoint(), IpcChannels.chatGetEndpoint), 0)
  registerHandler(IpcChannels.chatGetRuntimeInfo, handle(chatGetRuntimeInfoSchema, RuntimeInfoSchema, () => svc.getRuntimeInfo(), IpcChannels.chatGetRuntimeInfo), 0)
  registerHandler(IpcChannels.chatDisconnect, handle(z.undefined(), z.undefined(), () => svc.disconnect(), IpcChannels.chatDisconnect), 0)
  registerHandler(IpcChannels.chatListConversations, handle(chatListConversationsSchema, PageSchema(ConversationSchema), (req) => svc.listConversations(req), IpcChannels.chatListConversations), 1)
  registerHandler(IpcChannels.chatGetMessages, handle(chatGetMessagesSchema, MessagePageSchema, (req) => svc.getMessages(req), IpcChannels.chatGetMessages), 1)
  registerHandler(IpcChannels.chatSend, handle(chatSendSchema, ClientRequestRefSchema, (req) => svc.send(req), IpcChannels.chatSend), 1)
  registerHandler(IpcChannels.chatCancel, handle(chatCancelSchema, z.undefined(), (req) => svc.cancel(req), IpcChannels.chatCancel), 1)
  registerHandler(IpcChannels.chatActivate, handle(chatActivateSchema, ActivateConversationResultSchema, (req) => svc.activate(req.conversationId), IpcChannels.chatActivate), 1)
  registerHandler(IpcChannels.chatCreate, handle(chatCreateSchema, ConversationSchema, (req) => svc.createConversation(req), IpcChannels.chatCreate), 1)
  registerHandler(IpcChannels.chatRename, handle(chatRenameSchema, ConversationSchema, (req) => svc.renameConversation(req), IpcChannels.chatRename), 1)
  registerHandler(IpcChannels.chatDelete, handle(chatDeleteSchema, z.undefined(), (req) => svc.deleteConversation(req.conversationId), IpcChannels.chatDelete), 1)
  registerHandler(IpcChannels.chatGetState, handle(chatGetStateSchema, ConnectionStateSchema, () => svc.getConnectionState(), IpcChannels.chatGetState), 0)
}
