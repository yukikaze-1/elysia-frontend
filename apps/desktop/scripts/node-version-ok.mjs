// 纯函数：版本是否满足 range（vitest node 环境可 import；semver 须为显式 devDependency）
import semver from 'semver'
export function nodeVersionOk(version, range) {
  return semver.satisfies(version, range)
}
