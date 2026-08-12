import { describe, expect, it } from 'vitest'
import { nodeVersionOk } from '../../scripts/node-version-ok.mjs'

describe('nodeVersionOk（FE-S0-P2-01）', () => {
  const RANGE = '>=22.23.0 <23'
  it('22.23.0 → true（.nvmrc 基准）', () => { expect(nodeVersionOk('22.23.0', RANGE)).toBe(true) })
  it('22.22.0 / 23.0.0 / 24.0.0 → false', () => {
    expect(nodeVersionOk('22.22.0', RANGE)).toBe(false)
    expect(nodeVersionOk('23.0.0', RANGE)).toBe(false)
    expect(nodeVersionOk('24.0.0', RANGE)).toBe(false)
  })
})
