// src/main/attachments/attachments-handlers.ts
// 阶段 3 G3（spec §4.5 IPC 注册）：attachments:validate/upload/cancel/check 四通道。
// 沿用 P0 校验/脱敏/审计模式（createIpcHandler）；上传取消经 UploadService.cancel（AbortController）。
import { z } from 'zod'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import { AttachmentCheckResultSchema, AttachmentsUploadResponseSchema, FileValidationResultSchema } from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { attachmentsCancelSchema, attachmentsCheckSchema, attachmentsUploadSchema, attachmentsValidateSchema } from '../ipc/channels'
import type { UploadService } from './upload-service'
import type { MediaService } from './media-service'

export function registerAttachmentsHandlers(deps: { svc: UploadService; media: MediaService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { svc, media, sanitize, logger } = deps
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
}
