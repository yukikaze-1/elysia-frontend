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

/**
 * 一次查询的**完整原子事实快照**。
 *
 * 判别面是「表格 + 消息列 + 全部几何」缺一不可，而元素在虚拟列表重算（行高实测分批提交 →
 * `visibleIds` 重算）期间可能短暂不在渲染窗口内。因此**查询结果必须整体返回、由调用方对整份快照
 * 判有效**，绝不能「先 poll 某个条件通过、再重新查询一次」——那是 check-then-re-query 竞态：
 * 两个时刻之间的 DOM 变化会让第二次查询落空（2026-09-16 run `35001909477` 与
 * 2026-09-17 run `35140775538` 两次真实红的形态就是这个）。
 * 缺失状态一并带出，便于失败时直接读出是缺表格还是缺消息列。
 */
type TableSnapshot =
  | { complete: false; hasTable: boolean; hasList: boolean }
  | ({ complete: true; hasTable: true; hasList: true } & TableFacts)

/** 几何采集（page.evaluate 序列化函数——闭包不可引模块作用域，全部内联） */
async function collectTableFacts(page: Page): Promise<TableSnapshot> {
  return page.evaluate(() => {
    const table = document.querySelector<HTMLTableElement>('.cy-assistant-row .cy-markdown table')
    const list = document.querySelector<HTMLElement>('.cy-messages')
    // 任一缺失 ⇒ 返回「不完整」快照而不是 null：调用方据 hasTable/hasList 分辨装配错误的两半，
    // 且**不会**把「查询落空」误当成「夹具没渲染」。
    if (!table || !list) return { complete: false as const, hasTable: table !== null, hasList: list !== null }
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
    return { complete: true as const, hasTable: true as const, hasList: true as const, ...facts }
  })
}

/**
 * 等到「一份完整且哨兵为真的快照」，并**把那一份快照本身**交给调用方用于后续断言。
 *
 * 为什么用闭包变量保存最后一份快照而不是 poll 完再查一次：`expect.poll` 成功之后**不允许**
 * 再触碰 DOM —— 否则断言用的就不是「被判定通过的那个状态」，竞态原样回来。
 * 事件循环语义保证安全：poll 的判定（`latest.sentinel` 读取）与本次 fetch 之间没有任何 await 边界，
 * poll 返回后读到的 `latest` 必然就是让判定通过的那一份。
 */
async function waitForTableSnapshot(page: Page): Promise<TableSnapshot & { complete: true }> {
  let latest: TableSnapshot | undefined
  await expect.poll(async () => {
    latest = await collectTableFacts(page)
    return latest.complete && latest.sentinel
  }, { timeout: 15_000, interval: 200 }).toBe(true)
  // 至此 latest 一定是 complete && sentinel 的那一份（poll 退出条件即它）
  if (!latest || !latest.complete) throw new Error('等待完整表格快照后仍拿不到快照——装配错误')
  return latest
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

    // ① 等一份**完整且哨兵为真**的原子快照（表格 + 消息列 + 全部几何来自同一次 page.evaluate）
    //    后续所有断言直接用这一份，**不再触碰 DOM**——否则判定通过的状态与断言用的状态是两个时刻，
    //    竞态原样回归（这正是 2026-09-16 / 2026-09-17 两次红的形态）。
    const facts = await waitForTableSnapshot(page)

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
