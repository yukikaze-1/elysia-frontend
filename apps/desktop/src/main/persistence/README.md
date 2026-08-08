# persistence — userData 目录与本地持久化

阶段 1 填充：`user-data-dirs.ts`（ensureUserDataDirs：建 config/app-cache/logs/audit/temp/models/sandbox 七目录，symlink/realpath 逃逸拒绝 + POSIX 0700）。后续阶段承接日志/审计/沙箱等持久化写入层，均复用本目录的严格规则。
