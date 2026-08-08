import { z } from 'zod'

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string()
})
