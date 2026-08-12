// 启动前 Node 版本检查（FE-S0-P2-01）：engines 单一来源 = 本脚本旁的 package.json（import.meta 锚定，
// 禁 cwd 相对路径——pnpm -F 下 cwd=包目录、根跑读仓库外，双二义）。不匹配非零退出。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nodeVersionOk } from './node-version-ok.mjs'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const range = pkg.engines?.node
if (!range) {
  console.error('package.json 缺少 engines.node')
  process.exit(1)
}
if (!nodeVersionOk(process.version, range)) {
  console.error(`Node 版本需满足 ${range}（当前 ${process.version}）。请用 fnm 切换：fnm install 22.23.0 && fnm default 22.23.0`)
  process.exit(1)
}
