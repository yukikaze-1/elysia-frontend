// apps/desktop/src/main/diagnostics/sanitize.ts
export type MessageSanitizer = (message: string) => string

/** 把根路径转成分隔符不敏感正则（/ 与 \ 等价），供在原始 message 上匹配，不改写 message；
 *  正反两个方向都灵活：根是正斜杠 / 消息是反斜杠（或反之）都能匹配 */
function rootToRegex(root: string): string {
  let out = ''
  for (const ch of root) {
    if (ch === '/' || ch === '\\') out += '[\\\\/]' // 一个分隔符位置可匹配 \ 或 /
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

export function createSanitizePublicMessage(roots: { home: string; userData: string }): MessageSanitizer {
  const userData = roots.userData
  const home = roots.home

  return (message: string): string => {
    let out = message
    // ① file:// 绝对路径（先于根替换，防 file://~/x 残留）
    out = out.replace(/file:\/\/[^\s"'<>]+/g, '<path>')
    // ② userData 根（分隔符不敏感、边界 [\\/] 或串尾、大小写不敏感；无左边界——绝对路径粘在词尾也要掩，防泄漏）
    const userDataRe = new RegExp(`${rootToRegex(userData)}(?=[\\\\/]|$)`, 'i')
    out = out.replace(userDataRe, '<userData>')
    // ③ home 根
    const homeRe = new RegExp(`${rootToRegex(home)}(?=[\\\\/]|$)`, 'i')
    out = out.replace(homeRe, '~')
    // ④ 其他绝对路径形态：先 ≥2 段绝对路径（/home/alice2/x 整体掩为 <path>），后已知系统根单段（/etc /tmp 等）
    //    前置 lookbehind 排除紧跟 <userData>/~/<path> 的续接路径与 URL 的 // 路径段（http://example.com/a/b 不破坏）；
    //    尾部收窄为路径字符（不吞逗号/括号等标点——`open /a/b/c,继续` 掩成 `<path>,继续` 而非吃掉逗号）
    out = out.replace(/(?<![>~/\w:])\/(?:[a-zA-Z0-9._~%+-]+\/)+[a-zA-Z0-9._~%+@-]*/g, '<path>')
    out = out.replace(/(?<![>~\w:/])\/(?:etc|tmp|var|home|usr|opt|srv|mnt|media|bin|dev|proc)(?=[\\/]|$)/g, '<path>')
    out = out.replace(/(?<![\w])(?:[A-Za-z]:[\\/][^\s"'<>]+)/g, '<path>') // 盘符
    out = out.replace(/(?<![\w:])\\[\\][^\\\s"'<>]+[\\][^\s"'<>]+/g, '<path>') // UNC 两反斜杠
    return out
  }
}
