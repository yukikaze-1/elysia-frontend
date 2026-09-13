# 持久化失败可见性收口（H-11b 家族第三处 + 两处残余）与 ④ 的本地复现 —— 决策记录

**日期：** 2026-09-13
**范围：** 用户在同日「还剩什么」清单里选定的四项：① `CharacterDraftStore` 同族修复、⑤ B3 两处残余可见性、② ④ `message-list-follow-bottom` 深挖、A1-B `windows-runtime` 去掉每周定时
**结论：** ①②⑤ 已落地并变异验证；**④ 在 CI 机器上被复现**（8 次里中 1 次），并首次拿到"冻结曲线"——**判定它不是"慢"，而是"停住且不恢复"**；A1-B 见 [Windows 运行时决策记录 §5](2026-09-13-Windows运行时在服务形态runner上不可用-决策记录.md)。

---

## 1. ① `CharacterDraftStore`：H-11b 同族第三处（本轮先复核实测）

修前 `load()` 的 catch 里是 `await this.isolation.isolate(...).catch(() => {})` —— 正是 H-11b 明确否掉的「改名失败被吞」，而本 store 的写入路径**没有任何守卫**。于是这条静默销毁路径成立：

> 隔离失败（文件被 AV/备份代理锁住、只读目录、符号链接越根…）⇒ 原文件仍在磁盘上、内存被换成空仓库 ⇒ **下一次 `save`/`delete`/`deleteByCharacterId`/`retryPendingWrite` 把未能隔离的原文件覆写** ⇒ 用户自建角色的恢复草稿整份消失。

修法（与 `SessionStore`／`SettingsService` 同纪律）：置降级位 → **读写全拒** → 留痕计数（`character-drafts:degraded`）。**读也拒绝**是有意的：降级时 `list()` 返回空仓库是**谎报**——磁盘上明明有东西、只是读不出来；返回空会让 UI 显示"没有草稿"，用户以为丢了，或者更糟：以为可以继续编辑并保存。

- 日志纪律照旧：只含固定 code/文件名，**不含正文、绝对路径、底层 message**；完整 fs 原文只进本进程的 `getDegradedReason()`（不跨 IPC）。集成/单测都断言了这一点。
- `clear()` 也拒绝（unlink 会毁现场）。
- Renderer：目录页那条恢复失败横幅原本是**写死**的一句「本地草稿列表暂时不可用。可以继续浏览角色，稍后重试恢复。」——降级**不会自愈**，按它说的"稍后重试"只会一次次撞墙。现走 `errorMessage()` 单一来源（有码走映射表 →「本地保存已停用…」），"角色目录仍可继续浏览"的安抚语义改由横幅内固定补充行承担（对两类码都成立）。

**变异 2 次**：① 摘掉写守卫 → 降级用例红，且 `save()` 由 reject 变 **resolve**（说明"覆写"真的发生了；这也是我改掉第一版夹具的原因——见 §1.1）；② 隔离失败改回吞掉 → 降级用例红（`getDegradedReason()` 为 undefined）。

### 1.1 一处夹具自纠（值得记）

我第一版的"判别用例"是用 **safeRoot 不匹配**造降级的。变异验证时发现它是**假判别**：那种夹具下 `assertStorageRoot` 本来就会拦住写，"覆写"根本发生不了，红的只是错误码不同。改成**真实形态**——保留正确的 safeRoot、只注入 `isolate` 失败（文件被锁住/rename 失败），此时写入路径本身健康，判别力才成立（与 `session-store.spec.ts` 同款手法）。

## 2. ⑤ B3-a：`cache.store` 快照推送失败不再无声

`pushMessages` 的 `catch { /* 缓存缺落由后端调和兜底 */ }` 是**有意**的 best-effort（失败不影响发送/加载），但它让"消息快照没存住"对用户完全不可见——与草稿域不对称。现：**best-effort 语义不变**，失败记进本 store 的故障态，由**同一条全局横幅**聚合显示（`draft.store` 优先，它带 file/reason 投影；store 之间**没有**新增依赖边）。

转移规则抽到 `utils/persistence-failure.ts`（失败置位、成功只清"单次失败"、**不清不可自愈的降级**），两个 store 共用一份——此前只写在 `draft.store` 里。变异：catch 改回静默 → 3 条用例红。

## 3. ⑤ B3-b：设置域降级**启动即可见**

`settings:load` 在降级态改为**拒绝读取**（`loadSettingsForRenderer`，具名导出以便直测）。理由同 §1：返回默认值等于谎报——用户会以为设置被重置了，接着改一改、写一写，把未能隔离的原文件覆掉。Renderer 的 `settings.hydrate` 把失败记进 `saveError`，由设置页那条三态横幅显示（M-19 那批建的）。

**启动期不受影响**：`main/index.ts` 直接调 `settings.load()`，不经这条 handler，boot 仍 fail-open。
**测量口径的诚实说明**：这消除的是"要等到一次保存失败才可见"，不是"在聊天页就能看到"——设置失败只在设置中心可见。草稿域有全局横幅、设置域没有，这个不对称是**有意的**（设置的影响面限于设置页），已记入残余。

变异：读改回返回默认值 → 该用例红（`promise resolved … instead of rejecting`）。

**被既有用例抓到的契约变化**：`voice-handlers.spec` 的 settings 替身是手搓的 `{ load, save }`；handler 新增 `getLastError()` 依赖后该用例当场红（`settings:load` 变成 `UNKNOWN/内部错误`）。已按其真实契约补齐替身，并在该文件写明原因。

## 4. ② ④ `message-list-follow-bottom`：**在 CI 机器上复现，判定为"停住且不恢复"**

### 4.1 复现配方（本轮的最大产出，成本从"推一次 CI 等 6 分钟"降到"20 秒一轮"）

1. 本机 `ssh 192.168.1.18`（`yomu-X99`，24 核，runner 所在机；**免密可用**）；
2. 该机 `~/elysia-frontend` 是开发克隆（https remote 无凭据、不能 fetch）⇒ 从本机 `git push x99 <sha>:refs/heads/<tmp>` 推一个分支过去，再 `git worktree add`（共享对象库、不碰原工作树）；
3. 工具链用 runner 自带的：`PATH=<runner>/_work/_tool/node/22.23.0/x64/bin:<~/setup-pnpm/node_modules/.bin>:/usr/local/bin:/usr/bin:/bin`（**必须保留系统路径**，否则 pnpm 的 shim 会因为找不到 `sed`/`dirname`/`uname` 而失败）；
4. `pnpm install --frozen-lockfile`（store 已暖，2 秒）→ `ensure:electron` → `electron-vite build --mode test`；
5. `taskset -c 14-23 xvfb-run -a pnpm --filter @cyrene/desktop exec vitest run --config vitest.integration.config.mts message-list-follow-bottom`，跑 8 轮。

**结果：8 轮中 1 轮冻结**（`run4 exit=1 median=78px settledGap=3856px frozen=1`）。另两次"整分片"运行（单独跑、以及与 live2d job 并发跑）都是绿的——**"机器忙"不是充分条件**，触发点更随机。

### 4.2 冻结曲线（自诊断第一次真的用上）

```
top=    …,7706,7768,7860,7953,8139,8139,8139,8139,8139,8139,8139,8139
height= …,8294,8465,8526,8619,8712,8882,8975,9068,9161,11635,11867,12053
frozenAt=#18 top=8139 height=8882→12053（top 不再变化而内容继续增长）
settledGap=3856px
resample(+5000ms)=3856px top=8139 height=12568   ×3（三次都一样）
```

三个结论，逐条对应此前的开放疑问：

1. **`top` 完全冻结而 `height` 持续增长** ⇒ 命中的是组件里已记录的那条"**再无恢复路径**"分支（`CyMessageList.vue:112-125`：一旦早退，缺口更大、atBottom 更不可能为真 → 此后不再产生 scroll 事件 → 没有 settle → 没有重锚）；
2. **三次 5s 重采样都是 3856px 且 `top`/`height` 不再变化** ⇒ 流式结束后**它没有自愈**。这把"15s 观测窗内不收敛"推进为"**明确不收敛**"（仍受 15s 重采样窗口限制，但不再是"可能只是慢"）；
3. **数值与 CI `34740144774` 逐像素相同**（`median=78px max=3341px within=19/25 settledGap=3856px`）⇒ 那是同一个冻结，不是另一类现象。

### 4.3 下一步（已定位到分支，未定位到触发点）

冻结起点在流式开始后约 3.6s（第 18 个采样）。按代码，清掉"跟随意图"的唯一入口是 `onScroll` 里的 `scrollTop < prevTop`（用户上翻）分支——**而虚拟列表重锚自身就会写小 `el.scrollTop`**（`restoreScrollTop` 用的是估算高度）。故最可疑的是「重锚把 scrollTop 写小 → 触发 scroll 事件 → 被当成用户上翻 → 意图被清 → 再无恢复路径」。

**下一轮要做的**（本轮未做，属独立批次）：在渲染层加一个**只读探针**（`.cy-messages` 的 `data-follow-intent` / `data-at-bottom`，或测试模式下挂 `window.__cyFollowProbe`），用同一配方跑 8 轮直到复现，读出"意图被清的那一刻 `prevTop`/`scrollTop`/`scrollHeight` 各是多少"，据此判定是重锚写小还是别的路径。**判据一字不改**：修复必须让 ④ 在复现配方下稳定转绿，而不是调阈值。

## 5. 残余（如实记录）

1. **设置域降级只在设置中心可见**（无全局横幅），见 §3 的口径说明；
2. **`cache.store` 的失败只有单次/降级两态**，没有"第几片失败"的细分（横幅文案已覆盖含义）；
3. **④ 的触发点仍未定位**（§4.3 已给出探针方案与复现配方）；
4. **X99 上留下的痕迹**（下次可用/可清）：`/home/yomu/cyrene-4diag` 工作树、分支 `diag-4th`、`/tmp/cy-4loop*.log`、以及 Electron 二进制被下载进 `~/.cache/electron`（一次性，对 CI 反而是暖缓存）。
