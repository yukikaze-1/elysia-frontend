import { z } from 'zod'
import { isKeyAllowed } from '@shared/contracts'
import type { CredentialStatus } from '@shared/contracts/credentials'

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string()
})

export const credentialStatusSchema: z.ZodType<{ status: CredentialStatus; key: string }> = z.object({
  status: z.enum(['unavailable', 'locked', 'empty', 'available']),
  key: z.string().refine(isKeyAllowed)
})
export const credentialsSetSchema = z.object({
  key: z.string().refine(isKeyAllowed),
  value: z.string().min(1).max(4096)
})
export const credentialsClearSchema = z.object({
  key: z.string().refine(isKeyAllowed)
})
