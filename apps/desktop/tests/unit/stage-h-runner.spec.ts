import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { assertChecks, buildEvidence, CleanupStack } from '../../scripts/integration/stage-h/lib/evidence'
import { generationConversationId, generationTerminalFor } from '../../scripts/integration/stage-h/lib/generation'
import { parseStageHArgs, STAGE_H_REPOSITORY_ROOT } from '../../scripts/integration/stage-h/lib/config'
import { redactForEvidence, redactText } from '../../scripts/integration/stage-h/lib/redact'

const args = [
  '--scenario', 'preflight',
  '--backend-url', 'http://127.0.0.1:8765',
  '--app-data', 'C:\\Temp\\cyrene-stage-h-ud',
  '--output-dir', 'C:\\Temp\\cyrene-stage-h-evidence',
  '--marker', 'stage-h-unit-marker'
]

describe('Stage H real runner foundation', () => {
  it('requires explicit scenario, backend URL, isolated appData and output directory', () => {
    const parsed = parseStageHArgs(args, {})
    expect(parsed.kind).toBe('config')
    if (parsed.kind === 'config') {
      expect(parsed.config.scenario).toBe('preflight')
      expect(parsed.config.backendUrl).toBe('http://127.0.0.1:8765')
      expect(parsed.config.appData).toBe('C:\\Temp\\cyrene-stage-h-ud')
      expect(parsed.config.outputDir).toBe('C:\\Temp\\cyrene-stage-h-evidence')
    }
    expect(() => parseStageHArgs(args.filter((arg) => arg !== '--output-dir' && arg !== 'C:\\Temp\\cyrene-stage-h-evidence'), {})).toThrow(/output-dir/u)
    expect(() => parseStageHArgs([
      '--scenario', 'preflight', '--backend-url', 'https://example.test/?token=leak',
      '--app-data', 'C:\\Temp\\ud', '--output-dir', 'C:\\Temp\\evidence'
    ], {})).toThrow(/query/u)
  })

  it('does not allow a runner to write into the现场 output/playwright evidence directory', () => {
    const forbiddenOutput = join(STAGE_H_REPOSITORY_ROOT, 'output', 'playwright', 'new')
    expect(() => parseStageHArgs([
      '--scenario', 'preflight', '--backend-url', 'http://127.0.0.1:8765',
      '--app-data', 'C:\\Temp\\ud', '--output-dir', forbiddenOutput
    ], {})).toThrow(/output\/playwright/u)
  })

  it('redacts bearer tokens, paths and opaque IDs from evidence', () => {
    const fakeToken = ['sk', 'should-never-appear'].join('-')
    const raw = `Bearer ${fakeToken} at C:\\Temp\\stage-h\\secret\\file.txt`
    expect(redactText(raw, ['C:\\Temp\\stage-h'])).not.toContain('should-never-appear')
    const redacted = redactForEvidence({
      token: fakeToken,
      appData: 'C:\\Temp\\stage-h\\secret',
      conversationId: 'conv-sensitive',
      marker: 'stage-h-sensitive'
    }, { roots: ['C:\\Temp\\stage-h'] }) as Record<string, unknown>
    expect(JSON.stringify(redacted)).not.toContain('should-never-appear')
    expect(JSON.stringify(redacted)).not.toContain('conv-sensitive')
    expect(redacted.appData).toBe('<path>')
    expect(String(redacted.conversationId)).toMatch(/^id:/u)
  })

  it('marks assertion failures as failures instead of allowing a green exit', () => {
    expect(() => assertChecks({ first: true, second: false })).toThrow(/second/u)
    expect(() => assertChecks({ first: true })).not.toThrow()
    const evidence = buildEvidence({
      scenario: 'preflight',
      startedAt: '2026-09-10T00:00:00.000Z',
      endedAt: '2026-09-10T00:00:01.000Z',
      frontendCommit: 'abc1234',
      backend: { serverVersion: '0.1.0+def5678' },
      checks: { first: true, second: false },
      error: new Error('check failed')
    })
    expect(evidence.passed).toBe(false)
  })

  it('runs every cleanup callback in reverse order and reports cleanup failures', async () => {
    const order: string[] = []
    const stack = new CleanupStack()
    stack.add('first', () => { order.push('first') })
    stack.add('second', () => { order.push('second') })
    await stack.dispose()
    expect(order).toEqual(['second', 'first'])

    const failing = new CleanupStack()
    failing.add('ok', () => { order.push('ok') })
    failing.add('bad', () => { throw new Error('close failed') })
    await expect(failing.dispose()).rejects.toThrow(/cleanup failed/u)
    expect(order.at(-1)).toBe('ok')
  })

  it('correlates a terminal event by generationId even when conversationId is absent', () => {
    const events = [
      { event: 'generation.started', generationId: 'gen-a', conversationId: 'conv-a' },
      { event: 'generation.started', generationId: 'gen-b', conversationId: 'conv-b' },
      { event: 'generation.completed', generationId: 'gen-a' },
      { event: 'generation.completed', generationId: 'gen-b' }
    ]
    expect(generationTerminalFor(events, 'gen-a')?.event).toBe('generation.completed')
    expect(generationConversationId(events, 'gen-a')).toBe('conv-a')
    expect(generationConversationId(events, 'gen-b')).toBe('conv-b')
  })
})
