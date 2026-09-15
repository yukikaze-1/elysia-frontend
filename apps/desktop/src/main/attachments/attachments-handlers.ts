// src/main/attachments/attachments-handlers.ts
// 阶段 3 G3（spec §4.5 IPC 注册）：attachments:validate/upload/cancel/check 四通道。
// 沿用 P0 校验/脱敏/审计模式（createIpcHandler）；上传取消经 UploadService.cancel（AbortController）。
import { z } from 'zod'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import { AttachmentCheckResultSchema, AttachmentsUploadResponseSchema, FileValidationResultSchema, FileRefRegisterResponseSchema } from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { attachmentsCancelSchema, attachmentsCheckSchema, attachmentsUploadSchema, attachmentsValidateSchema, fileRefsRegisterSchema } from '../ipc/channels'
import type { UploadService } from './upload-service'
import type { MediaService } from './media-service'
import type { FileRefRegistry } from './file-ref'

export function registerAttachmentsHandlers(deps: { svc: UploadService; media: MediaService; fileRefs: FileRefRegistry; sanitize: MessageSanitizer; logger: Logger }): void {
  const { svc, media, fileRefs, sanitize, logger } = deps
  const handle = <TReq, TRes>(
    requestSchema: z.ZodType<TReq>,
    responseSchema: z.ZodType<TRes>,
    fn: (req: TReq) => TRes | Promise<TRes>,
    channel: IpcChannelName
  ): ((raw: unknown) => Promise<IpcResult<TRes>>) =>
    createIpcHandler(requestSchema, responseSchema, fn, { sanitize, channel, logger })

  registerHandler(IpcChannels.attachmentsValidate, handle(attachmentsValidateSchema, z.array(FileValidationResultSchema), (req) => svc.validateFiles(req.files), IpcChannels.attachmentsValidate), 1)
  registerHandler(IpcChannels.attachmentsUpload, handle(attachmentsUploadSchema, AttachmentsUploadResponseSchema, async (req) => ({ uploadId: req.uploadId, attachments: await svc.uploadBatch(req.uploadId, req.files) }), IpcChannels.attachmentsUpload), 1)
  registerHandler(IpcChannels.attachmentsCancel, handle(attachmentsCancelSchema, z.undefined(), (req) => { svc.cancel(req.uploadId) }, IpcChannels.attachmentsCancel), 1)
  registerHandler(IpcChannels.attachmentsCheck, handle(attachmentsCheckSchema, AttachmentCheckResultSchema, (req) => media.checkStatus(req.attachmentId), IpcChannels.attachmentsCheck), 1)
  // S5-B2：**唯一的 fileRef 铸造点**。入参是 preload 经 `webUtils.getPathForFile` 解析出的真实路径，
  // 出参是不可猜 token。即便对端绕过 preload 直调本通道，它能得到的也只是「自己登记过的路径」的引用——
  // 而引用之后 realpath/userData/黑名单/大小/魔数复核逐条照旧（本通道不构成新的放行面）。
  registerHandler(IpcChannels.fileRefsRegister, handle(fileRefsRegisterSchema, FileRefRegisterResponseSchema, (req) => ({ fileRef: fileRefs.issue(req.path) }), IpcChannels.fileRefsRegister), 1)
}
