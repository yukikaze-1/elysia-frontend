import type { Page } from 'playwright'
import type { StageHConfig } from '../lib/config.ts'

export interface StageHScenarioContext {
  config: StageHConfig
  page: Page
}

export interface StageHScenarioResult {
  checks: Record<string, boolean>
  details?: unknown
  backend?: {
    url?: string
    protocolVersion?: string
    serverVersion?: string
    buildSha?: string
  }
}

export type StageHScenario = (context: StageHScenarioContext) => Promise<StageHScenarioResult>
