# diagnostics — 日志 / 审计 / 脱敏

本目录是 Main 进程运行日志与合规审计的落盘出口，遵循「敏感值永不落盘、不进出诊断导出」的红线。

- **rotate 运行日志**：`app.log` 按 5MB×3 轮转，定时 flush + 退出 flush，记录运行期信息，可改可删。
- **append-only 审计**：`audit-YYYY-MM-DD.jsonl` 按日追加、逐行 fsync、30 天自动清理，作为合规证据只增不改。
- **双净化**：`sanitize` / `redact` 两道净化确保敏感值（inner_voice / public_reply / 转录音频 / 凭据）永不落盘、不进诊断导出。
- **有序关闭**：退出步骤顺序为 renderer-persist → 凭据 → adapter → diagnostics（`src/main/bootstrap/shutdown-sequence.ts`；批次 A/C 定序，H-04 在队首加了 renderer flush），超时标记经同步审计落盘。
- 运行日志与审计用途严格区分：前者可改删，后者是证据。
