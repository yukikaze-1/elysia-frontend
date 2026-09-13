# type-aware lint 全集接入生产代码 —— 决策记录

**日期：** 2026-09-13
**范围：** 用户在本日「还剩什么」清单里选定的第三项：**type-aware lint 全集 + 测试目录接入**（独立批次）
**前置：** P1-11 第一轮（2026-09-11）只接了三条高信号规则且只覆盖 `src/**`，当时把"全集接入"与"测试目录"一并推迟
**产出提交：** `2517228`

---

## 1. 先量：这套"全集"到底有多大（结论直接改了计划）

全量 `recommendedTypeChecked` 实测 **1238 条 / 229 个文件**：

| 维度 | 分布 |
|---|---|
| 按区域 | `tests/**` **1012**、`src/renderer` 108、`src/main` 104、`scripts` 14（含 14 个 project service 解析失败） |
| 按规则 | `require-await` 537、`no-unnecessary-type-assertion` 228（**全部可自动修**）、`no-unsafe-*` 系 260、`unbound-method` 93、`no-base-to-string` 24、`prefer-promise-reject-errors` 9、其余零散 |

三条直接改变计划的读数：

1. **测试目录那一半不是"85 条"而是 1012 条**（前一轮记的 85 是"三条高信号规则在测试目录"的数）。
2. **1012 条里 547 条来自两条在测试替身上前提不成立的规则**：`require-await` 474（`async` 测试替身）、
   `unbound-method` 73（vitest 的 `expect(obj.method).toHaveBeenCalled()` 惯例，vitest 官方文档亦建议对该规则豁免）。
3. 生产代码实际只有约 150 条 + 14 处解析失败 + 59 个 `.vue` 的解析失败（后者是我自己的配置错，见 §3）。

**决策**：本轮**只落生产代码那一半**（`src/**` + `**/*.vue` + `scripts/**`），测试目录仍只跑非类型感知规则。
理由不是"难"，而是**混做会让这一批变成不可复核的形式改写**：测试侧 460 余处改动绝大多数是给夹具补类型，
与"门禁加固"这个目标不同量级。测试侧的实测成本与两个候选口径写在 §6，另立批次。

---

## 2. 配置决策

- `src/**`（ts/mts）、`**/*.vue`、`scripts/**`（Stage H runner）接入 `recommendedTypeChecked`。
- **`.vue` 块的 `parser` 与 `parserOptions` 必须写在同一个块里**：flat config 对 `parserOptions` 是
  **替换而非深合并**，拆到另一个块会把它整体覆盖。实测踩到过——第一版探针把这点拆开，
  **59 个 `.vue` 全部退回按 JS 解析**（`Parsing error: '>' expected`），而它们此前的"零命中"是假的。
  该结论已写进配置文件注释。
- **`**/*.d.mts` 加入忽略**（4 个 `scripts/*.d.mts`）：与 `**/*.d.ts` 同类，没有值级代码，
  进来只会得到 "was not found by the project service"。
- **`scripts/**/*.ts` 加进 `tsconfig.node.json` 的 include**：Stage H runner 此前**不在任何 project 的
  include 里**（只因为被 `tests/**` import 才被 tsc 顺带检查到），projectService 直接判它不可用。
  登记后它同时进入 `pnpm typecheck` 的正式范围，**当轮就暴露了 20 个此前无人看见的类型错误**：
  `runner.ts` 的隐式 any（`let session` 无注解，`TS7034`）与 `preview-validation.ts` 的 17 处
  `as AnyRecord` 之后字段仍是 `unknown`。全部已修；缺失字段一律**抛出**而不是静默兜底——
  这是验收 harness，"取不到数据"不该伪装成"检查通过"。

---

## 3. `require-await`：**用实测否掉这条规则**（不是"关规则换绿灯"）

64 处命中逐类核对，**没有一处**是它要抓的缺陷形态（"写了 async 却忘了 await"）：

- 52 处在两个适配器**实现**里（`mock-backend.ts` 38／`real-backend.ts` 14）：它们实现 `BackendAdapter`
  接口，契约要求返回 `Promise<T>`，而 mock 与部分真实桩本就没有可 await 的异步步骤，`async` 是满足契约的惯用写法；
- 其余 12 处（`main/index.ts` 的 mock 采集桩、`ipc/tool-handlers.ts`、`attachments/media-service.ts`、
  `tools/tool-service.ts`、`CyCharacterPane.vue`、`conversation.store.ts`）逐处看过，结论相同。

要"修"只能把每个 `async f() { return x }` 改写成 `f() { return Promise.resolve(x) }`：纯形式改写、
零行为收益，且 52 处落在适配器主路径上。而"忘了 await"这个缺陷类**本来就不由它兜**——
函数里只要别处有 await，本条规则就不触发；真正把关的是已开启的 `no-floating-promises` /
`no-misused-promises` / `await-thenable`。

故在配置里以**带计数、带范围、带替代控制**的方式关闭，并在本记录与 doc 16 留档。
这与仓库批评过的"用关规则冒充加门禁"的区别在于：那是指**为了让门禁变绿而静默扩大豁免**；
这里是把一条经实测判定不匹配的规则**显式**列出并说明由谁接管。

---

## 4. 真修掉的问题（不是形式改写）

| 规则 | 处数 | 修法 |
|---|---|---|
| `no-base-to-string` | 10 | `String(未知值)`／`JSON.stringify(...) ?? String(...)` 会产出 `[object Object]`。逐处改成显式分支：`describeThrown`、`messageOf`、Stage H 的 `redact`／`electron`／`preflight`、`raw-schemas` 的指纹字面量。**`raw-schemas` 的指纹取值口径刻意保持不变**（它是被 `check:contract` 比对的锚点，形如对象字面量的取值从 `[object Object]` 改为显式序列化，标量口径不变） |
| `unbound-method` | 20 | 方法被摘下对象后 `this` 失去保证：6 个 store 的 getter/saver/validator…、`errorHandlers.onProtocolWarning`／`onError`、三处 `createCorruptIsolation({ countDiagnostic })`。按"它本来就是回调值"的性质修：store 侧显式 `.bind(api)`；接口侧把 `CorruptIsolationOpts.countDiagnostic`、三个 store deps 的 `countDiagnostic`、`PcmCaptureOptions` 的三个回调**从方法声明改成函数属性声明**（纯类型面，运行期零变化） |
| `no-unsafe-*` 系 | 33 | `JSON.parse`／`res.json()`／`MessageEvent.data`／Node 的 `Readable` 异步迭代器（官方签名就是 `AsyncIterableIterator<any>`，是这个 any 口子的源头）等逐处收成 `unknown` 再判型；`virtual-window` 的 `new Array(n)` 收成 `new Array<number>(n)`；`mock-backend` 的 provider 表补显式类型（原先 `Object.entries` 在三形状并集上退化成 any） |
| live2d 适配器 | 6 | 按 `framework.d.ts` 既定做法（同模块名 + 显式导出面覆盖通配 any）补齐 motion／expression／model-matrix 五个模块的声明，签名逐条对照 vendored 源码行号（`cubismmotionmanager.ts:62`／`cubismmotionqueuemanager.ts:56`／`cubismmodelmatrix.ts:160` 等） |
| `prefer-promise-reject-errors` | 9 | `Promise.reject(非 Error)` 归一：新增 `renderer/src/utils/rejection.ts` 与 `character-service.asRejection`，**原值挂在 `cause` 上不丢** |
| `no-redundant-type-constituents` | 4 | `ConsoleLevel \| number \| string` 这类"字面量联合被 string 吞掉"收敛为 `string \| number`，已知取值写进注释 |
| `no-unnecessary-type-assertion` + `no-unused-vars` + `prefer-const` | 31+8 | 自动修 + 连带清理（见 §5 的第二条教训） |

---

## 5. 两条"我自己写错、被门禁当场抓住"的记录

1. **`voice-capture` 的 `port.onmessage` 第一版只认 `ArrayBuffer`**：而 AudioWorklet 实际 postMessage 的是
   **Uint8Array**（该文件头注释里就写着「port.postMessage(Uint8Array 640B)」）——等于把音频链路整条掐断。
   `tests/unit/voice-capture.spec.ts` 立刻红（它同时断言 `onChunk` 收到的是**独立拷贝**，这条契约也一并保住）。
   教训：**这是"消 lint 告警时最容易犯的错"的又一例**——本次的目标是消 `no-unsafe-argument`，
   而修法本身改变了运行期行为。
2. **`--fix` 删掉的类型断言有 2 处删错**：`{ severity: issue.severity as 'error' | 'warning' }` 被判为"多余"，
   但对象字面量没有上下文类型、会把字面量联合**拓宽回 `string`**，删掉后 `pnpm typecheck` 立刻红
   （`executor.ts` 与 `public-error.ts` 各一处）。改为显式标注的中间量 `const severity: 'error' | 'warning' = issue.severity`。
   教训与仓库既有的"变异必须真的改变代码路径"同族：**自动修复必须复核，不是跑完 `--fix` 就算完**。

---

## 6. 测试目录：实测成本与两个候选口径（**本轮未做**，另立批次）

| 口径 | 需要修 | 说明 |
|---|---|---|
| A. 全集（含两条豁免） | **约 460 处** / 122 个测试文件 | 豁免 `require-await`（474，同 §3 的理由：`async` 测试替身）与 `unbound-method`（73，vitest 惯例）。其余为 `no-unnecessary-type-assertion` 208（可自动修）、`no-unsafe-*` 223、`no-base-to-string` 18、`no-floating-promises` 5、`await-thenable` 2、`no-misused-promises` 2、`only-throw-error` 1 |
| B. 只接三条高信号规则 | **9 处** | 即前一轮记的"测试目录接入"的实质内容（当时记的 85 是另一套口径下的数）。改动小、风险低 |

**同批已落 B**（用户选定本项时口径为"全集 + 测试目录接入"，故不属于"推迟"）：测试目录已接入
`no-floating-promises` / `await-thenable` / `no-misused-promises`，9 处逐处判语义后修完——
悬空的 `connect` 补 `await`；**有意交错**的 `saveAsNew()` 与只读同步断言面的 `handleUncaughtException()`
用 `void` 显式声明忽略（而不是让它悬空）；`await` 一个同步函数、`mockImplementation(async …)` 落在
void 位置这两类直接去掉多余修饰。配置注释里写明了"为什么是这三条"：**测试自己吞掉 rejection，
会把'实现坏了'伪装成'测试通过'**。

A 仍**未做且不替用户选**：它的价值是把 `no-unsafe-*` 这类"夹具里 any 到处漏"的口子也覆盖掉，
代价是一次横跨 122 个文件、以补类型为主的大改（可复核性差）。建议：A 视是否真的发生过
"测试代码里的 any 掩盖了缺陷"再决定。

---

## 7. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | 0（**首次包含 `scripts/**` 的正式类型检查**） |
| `pnpm lint`（`eslint . --max-warnings=0`） | 0 |
| `pnpm -F @cyrene/desktop test` | 253 文件 / 3103 通过 + 6 expected-fail + 22 skipped |
| 集成套件 | 见 doc 16 §3.1 本批门禁行 |
| `pnpm docs:check` / `docs:index` | 见 doc 16 §3.1 本批门禁行 |
