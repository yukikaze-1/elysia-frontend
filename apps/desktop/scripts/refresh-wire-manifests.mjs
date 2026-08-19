#!/usr/bin/env node
// 刷新全部 wire fixture manifest 的 schemaHash 为当前 rawSchemasFingerprint()（阶段 6 批次 A Task 2 起；schema 变更后运行）
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { rawSchemasFingerprint } from '../src/main/transport/protocol-v2/raw-schemas.ts'

const dir = join(import.meta.dirname, '../src/main/fixtures/wire-v2')
const fp = rawSchemasFingerprint()
let n = 0
for (const f of readdirSync(dir).filter((f) => f.endsWith('.manifest.json'))) {
  const p = join(dir, f)
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.schemaHash = fp
  writeFileSync(p, JSON.stringify(m) + '\n', 'utf8')
  n += 1
}
console.log(`[refresh-wire-manifests] ${n} manifests → ${fp}`)
