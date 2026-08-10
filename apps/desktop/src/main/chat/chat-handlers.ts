import { z } from 'zod'
import { IpcChannels } from '@shared/contracts'
import type { IpcResult } from '@shared/contracts'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import {
  chatActivateSchema,
  chatCancelSchema,
  chatConnectSchema,
  chatCreateSchema,
  chatDeleteSchema,
  chatGetMessagesSchema,
  chatGetStateSchema,
  chatListConversationsSchema,
  chatRenameSchema,
  chatSendSchema
} from '../ipc/channels'
import type { ChatService } from './chat-service'

/** P0 响应校验用 z.unknown() 信封：成功 {ok:true,data} 不校验 data 形状(留阶段 7 安全收敛细化)；失败 {ok:false,error} 恒校验 */
const responseEnvelope = z.unknown()

/** 注册全部 chat 命令(ipcMain.handle)。getToken/requireToken 已在 ChatServiceDeps 内,不重复传参(P3)。 */
export function registerChatHandlers(opts: { svc: ChatService; sanitize: MessageSanitizer }): void {
  const { svc, sanitize } = opts
  const handle = <TReq>(
    requestSchema: z.ZodType<TReq>,
    fn: (req: TReq) => unknown
  ): ((raw: unknown) => Promise<IpcResult<unknown>>) =>
    createIpcHandler(requestSchema, responseEnvelope, fn, { sanitize })

  registerHandler(IpcChannels.chatConnect, handle(chatConnectSchema, (req) => svc.connect(req)), 1)
  registerHandler(IpcChannels.chatDisconnect, handle(z.undefined(), () => svc.disconnect()), 0)
  registerHandler(IpcChannels.chatListConversations, handle(chatListConversationsSchema, (req) => svc.listConversations(req)), 1)
  registerHandler(IpcChannels.chatGetMessages, handle(chatGetMessagesSchema, (req) => svc.getMessages(req)), 1)
  registerHandler(IpcChannels.chatSend, handle(chatSendSchema, (req) => svc.send(req)), 1)
  registerHandler(IpcChannels.chatCancel, handle(chatCancelSchema, (req) => svc.cancel(req)), 1)
  registerHandler(IpcChannels.chatActivate, handle(chatActivateSchema, (req) => svc.activate(req.conversationId)), 1)
  registerHandler(IpcChannels.chatCreate, handle(chatCreateSchema, (req) => svc.createConversation(req)), 1)
  registerHandler(IpcChannels.chatRename, handle(chatRenameSchema, (req) => svc.renameConversation(req)), 1)
  registerHandler(IpcChannels.chatDelete, handle(chatDeleteSchema, (req) => svc.deleteConversation(req.conversationId)), 1)
  registerHandler(IpcChannels.chatGetState, handle(chatGetStateSchema, () => svc.getConnectionState()), 0)
}
