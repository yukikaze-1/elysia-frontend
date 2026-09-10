import { runPreflight } from './preflight.ts'
import { runPreviewValidation } from './preview-validation.ts'
import type { StageHScenario } from './types.ts'

export const scenarioRunners: Record<string, StageHScenario> = {
  preflight: runPreflight,
  'preview-validation': runPreviewValidation
}
