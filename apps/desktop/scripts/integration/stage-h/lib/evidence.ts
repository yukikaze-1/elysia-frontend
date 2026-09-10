import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactForEvidence, safeError } from './redact.ts'

export interface StageHEvidenceInput {
  scenario: string
  startedAt: string
  endedAt: string
  frontendCommit: string
  backend: {
    url?: string
    protocolVersion?: string
    serverVersion?: string
    buildSha?: string
  }
  checks: Record<string, boolean>
  details?: unknown
  error?: unknown
  cleanupErrors?: readonly unknown[]
}

export interface StageHEvidence {
  schemaVersion: 'stage-h-evidence-v1'
  scenario: string
  startedAt: string
  endedAt: string
  durationMs: number
  frontend: { commit: string }
  backend: {
    url?: string
    protocolVersion?: string
    serverVersion?: string
    buildSha?: string
  }
  checks: Record<string, boolean>
  passed: boolean
  details?: unknown
  error?: ReturnType<typeof safeError>
  cleanupErrors?: ReturnType<typeof safeError>[]
}

export function allChecksPass(checks: Record<string, boolean>): boolean {
  const values = Object.values(checks)
  return values.length > 0 && values.every(Boolean)
}

export function assertChecks(checks: Record<string, boolean>): void {
  if (!allChecksPass(checks)) {
    const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
    throw new Error(`Stage H checks failed: ${failed.join(', ') || 'none'}`)
  }
}

function parseDuration(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, end - start)
}

export function buildEvidence(input: StageHEvidenceInput, roots: readonly string[] = []): StageHEvidence {
  const checks = { ...input.checks }
  const passed = allChecksPass(checks) && input.error === undefined && (input.cleanupErrors?.length ?? 0) === 0
  const evidence: StageHEvidence = {
    schemaVersion: 'stage-h-evidence-v1',
    scenario: input.scenario,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: parseDuration(input.startedAt, input.endedAt),
    frontend: { commit: input.frontendCommit },
    backend: input.backend,
    checks,
    passed,
    ...(input.details === undefined ? {} : { details: redactForEvidence(input.details, { roots }) }),
    ...(input.error === undefined ? {} : { error: safeError(input.error, roots) }),
    ...(input.cleanupErrors === undefined || input.cleanupErrors.length === 0
      ? {}
      : { cleanupErrors: input.cleanupErrors.map((error) => safeError(error, roots)) })
  }
  return redactForEvidence(evidence, { roots }) as StageHEvidence
}

export async function writeEvidence(path: string, evidence: StageHEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
}

/** LIFO cleanup with error aggregation; every registered resource gets a chance to close. */
export class CleanupStack {
  private readonly entries: Array<{ name: string; close: () => void | Promise<void> }> = []

  add(name: string, close: () => void | Promise<void>): () => void {
    this.entries.push({ name, close })
    return () => {
      const index = this.entries.findIndex((entry) => entry.close === close)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }

  async dispose(): Promise<void> {
    const errors: Error[] = []
    for (const entry of this.entries.splice(0).reverse()) {
      try {
        await entry.close()
      } catch (cause) {
        errors.push(new Error(`${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`))
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Stage H resource cleanup failed')
  }
}
