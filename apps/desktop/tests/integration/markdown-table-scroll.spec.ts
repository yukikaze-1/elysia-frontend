// tests/integration/markdown-table-scroll.spec.ts（规格漂移台账 ②-1：doc 03 §7.4「表格在窄窗口内横向滚动」）
//
// 为什么放在集成层：这是**布局**属性。happy-dom 不做布局，单测里任何"表能滚动"的断言都只能是
// 读 CSS 文本（断言实现细节而非用户可见性质），因此判别面必须取真实 Chromium 的实测几何。
//
// 判别面（全部是用户可见性质，不是"CSS 里有没有某个属性"）：
//   ① 正向哨兵：夹具表格真的渲染出来了（否则以下断言会集体空过——本仓库既有教训）
//   ② 表盒不超出消息列可视区 —— 即"没有被裁切"（修复前表格是 `display:table`、宽度等于内容宽，
//      盒直接超出列表右边缘，再被 `.cy-messages` 的 `overflow-x:hidden` 永久切掉）
//   ③ 内容确实溢出表盒（scrollWidth > clientWidth + 余量）—— 即"确实需要滚动"
//   ④ 溢出部分**可达**：滚到最右后最后一列的右边缘落回表盒内（修复前 scrollLeft 恒 0，
//      右侧列永远看不到；"能设置 scrollLeft"本身不足以判别，故用"可达"这条性质）
//   ⑤ 消息列表自身不横向溢出（宽表不得把布局撑破）
//
// 载荷注入沿用 markdown-xss 的先例：`CYRENE_MOCK_REPLY_FIXTURE` env → MockBackend.replyFixtureText
// （renderer 不读 env，既有 CYRENE_MOCK_* 纪律）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

// 宽表夹具：列数取"产品自身的单元格最小宽度"为据——每列至少是左右 padding + 边框 + 一个字符，
// 故列数足够多时表格的 min-content 宽度必然超过消息列（本机实测消息列 509px、单气泡 395px）。
// 这正是 doc 03 §7.4「表格在窄窗口内横向滚动」要覆盖的场景。
//
// 刻意**不**用"超长不可断词"制造溢出：`.cy-markdown` 带 `word-break: break-word`，
// 长 token 会被压回容器宽度——实测 12 列 + 13 字符 token 时表格收缩到 395px（= 气泡宽度）、
// 根本不需要滚动，即"看起来像宽表"的东西并不构成这个用例的判别面。
const COLUMNS = 24
const COLUMN_HEADERS = Array.from({ length: COLUMNS }, (_, i) => `Col${String(i + 1).padStart(2, '0')}Header`)
const COLUMN_ROWS = [1, 2, 3].map((r) =>
  Array.from({ length: COLUMNS }, (_, i) => `r${r}c${String(i + 1).padStart(2, '0')}-value`))
const FIXTURE_TABLE = [
  'TABLESCROLL-START',
  '',
  `| ${COLUMN_HEADERS.join(' | ')} |`,
  `| ${COLUMN_HEADERS.map(() => '---').join(' | ')} |`,
  ...COLUMN_ROWS.map((row) => `| ${row.join(' | ')} |`),
  '',
  'TABLESCROLL-END',
].join('\n')

/** 夹具文件写至临时目录（主进程 readFileSync 读取；缺失/权限属装配错误，应 fail-start 而非静默空过） */
function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cy-table-'))
  const file = join(dir, 'reply.md')
  writeFileSync(file, FIXTURE_TABLE, 'utf8')
  return file
}

/** 「连接 + 激活首个会话 + UI 发送」——沿用 markdown-xss.spec 的 connectAndSend 先例 */
async function connectAndSend(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), { timeout: 8000, interval: 200 })
    .toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), { timeout: 8000, interval: 200 }).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => (document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true)), { timeout: 8000, interval: 200 })
    .toBe(false)
  await page.locator('textarea[aria-label="消息输入框"]').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

type TableFacts = {
  /** 正向哨兵：确实渲染了夹具表格并完整到达 */
  sentinel: boolean
  cells: number
  rows: number
  /** 表盒几何 */
  clientWidth: number
  scrollWidth: number
  overflowX: string
  tableRight: number
  /** 消息列几何 */
  listRight: number
  listClientWidth: number
  listScrollWidth: number
  /** 滚动前：最后一列的右边缘（判断"溢出确实存在"） */
  lastRightBefore: number
  /** 相邻表头单元格之间的间隙：折叠边框下应≈0（`display:block` 若让 `border-collapse` 失效，
   *  浏览器会退回 separate 模型并产生 2px border-spacing —— 那是本修法可能引入的回归） */
  headerCellGap: number
  /** 滚到最右后 */
  maxScrollLeft: number
  lastRightAfter: number
}

/** 几何采集（page.evaluate 序列化函数——闭包不可引模块作用域，全部内联） */
async function collectTableFacts(page: Page): Promise<TableFacts | null> {
  return page.evaluate(() => {
    const table = document.querySelector<HTMLTableElement>('.cy-assistant-row .cy-markdown table')
    const list = document.querySelector<HTMLElement>('.cy-messages')
    if (!table || !list) return null
    const lastCell = table.querySelector<HTMLElement>('tr > *:last-child')
    const headerCells = table.querySelectorAll<HTMLElement>('thead th')
    const headerCellGap = headerCells.length >= 2
      ? headerCells[1].getBoundingClientRect().left - headerCells[0].getBoundingClientRect().right
      : Number.NaN
    // 归零再量：本函数会被 expect.poll 反复调用，上一次调用已把表格滚到最右——
    // 不归零就会把"滚动后"的几何当成"滚动前"，判据随之失效（本用例首版即栽在这里）。
    table.scrollLeft = 0
    const boxBefore = table.getBoundingClientRect()
    const lastBefore = lastCell?.getBoundingClientRect() ?? null
    const facts = {
      sentinel: false,
      cells: table.querySelectorAll('th,td').length,
      rows: table.querySelectorAll('tr').length,
      clientWidth: table.clientWidth,
      scrollWidth: table.scrollWidth,
      overflowX: getComputedStyle(table).overflowX,
      tableRight: boxBefore.right,
      listRight: list.getBoundingClientRect().right,
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
      lastRightBefore: lastBefore?.right ?? Number.NaN,
      headerCellGap,
      maxScrollLeft: -1,
      lastRightAfter: Number.NaN,
    }
    // 滚到最右：只有真滚动容器才会改变 scrollLeft
    table.scrollLeft = table.scrollWidth
    facts.maxScrollLeft = table.scrollLeft
    facts.lastRightAfter = lastCell?.getBoundingClientRect().right ?? Number.NaN
    // 哨兵：完整夹具（含结束标记）已到达 DOM——后续断言不会在"半截内容"上做几何判断
    facts.sentinel = (table.closest('.cy-markdown')?.textContent ?? '').includes('TABLESCROLL-END')
    return facts
  })
}

let app: ElectronApplication
let page: Page
let userData = ''
let fixtureFile = ''
beforeAll(async () => {
  fixtureFile = writeFixture()
  const launched = await launchApp(undefined, { env: { CYRENE_MOCK_REPLY_FIXTURE: fixtureFile } })
  app = launched.app
  page = launched.page
  userData = launched.userData
}, 60_000)
afterAll(async () => {
  try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
  try { rmSync(dirname(fixtureFile), { recursive: true, force: true }) } catch { /* 尽力 */ }
})

describe('Markdown 宽表横向滚动（doc 03 §7.4）', () => {
  it('宽表在气泡内可横向滚动：不被裁切、溢出部分可达、不撑破消息列', async () => {
    await connectAndSend(page, '表格滚动判别用例')

    // ① 等表格与完整夹具到达（列表虚拟化/流式都可能让它晚于发送出现）
    await expect.poll(async () => (await collectTableFacts(page))?.sentinel ?? false, { timeout: 15_000, interval: 200 })
      .toBe(true)
    const facts = await collectTableFacts(page)
    if (!facts) throw new Error('表格或消息列未找到——夹具未渲染，属装配错误')

    // 正向哨兵：24 列 ×（表头 + 3 行）= 96 个单元格（缺它说明表格没真渲染，下面全是空过）
    expect(facts.rows).toBe(4) // 表头 + 3 行
    expect(facts.cells).toBe(COLUMNS * 4)

    // ② 表盒不得超出消息列可视区（"没有被裁切"）
    expect(facts.tableRight).toBeLessThanOrEqual(facts.listRight + 1)

    // ③ 内容确实溢出表盒（"确实需要滚动"）——宽表夹具的 min-content 宽度远大于气泡
    expect(facts.scrollWidth).toBeGreaterThan(facts.clientWidth + 40)

    // ④ 溢出部分可达：滚动前最后一列在盒外，滚到最右后落回盒内
    expect(facts.lastRightBefore).toBeGreaterThan(facts.tableRight + 40)
    expect(facts.maxScrollLeft).toBeGreaterThan(0)
    expect(facts.lastRightAfter).toBeLessThanOrEqual(facts.tableRight + 1)

    // ⑤ 消息列自身不横向溢出（宽表没有把布局撑破）
    expect(facts.listScrollWidth).toBeLessThanOrEqual(facts.listClientWidth + 1)

    // ⑥ 可滚动性（用户可见的横向滚动条）——与 ④ 的"可达"互为补充：
    //    ④ 证明溢出内容能到达，⑥ 证明用户能自己滚（`hidden` 下 ④ 可被程序化滚动满足，但没有滚动条）
    expect(['auto', 'scroll']).toContain(facts.overflowX)

    // ⑦ 顺带守住本修法可能引入的回归：`display: block` 若让 `border-collapse` 失效，
    //    浏览器会退回 separate 模型并插入 2px border-spacing（相邻单元格之间出现缝）。
    expect(Math.abs(facts.headerCellGap)).toBeLessThanOrEqual(1)
  })
})
