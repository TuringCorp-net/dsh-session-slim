# 运维手册：会话瘦身插件（Zero / 任意 DSH profile）

## 它做什么
在 `sessionPersistence.open()` 之前，把**官方当前 surface** 写成磁盘上的会话日志，原日志移进 `<sessionDir>/archive/`。
不改官方代码；何时折叠、折叠什么全由官方压缩决定，插件只在"打开时"落盘一次。

## 装 / 卸
```bash
# 安装（在目标机器上，用目标 profile）
DSH_HOME=<home> dsh plugin --profile web add github:<user>/<repo>     # 或本地 tgz 路径
# 卸载
DSH_HOME=<home> dsh plugin --profile web remove @local/dsh-session-slim
```
装完重启服务生效（`patchReload: live` 有时能热挂载，但重启最干净）。

## 配置（bundle 的 cordis.patch.yml，或 profile 的 patch 覆盖）
```yaml
- id: session-slim
  config:
    enabled: true
    minBytes: 5242880   # 小于这个只 stat 一下，完全不介入
    keepArchives: 5     # 每个会话保留几份瘦身前原件
    verbose: true
```

## 怎么确认它在工作
```bash
journalctl -u zero.service | grep -E 'SESSION-SLIM|session-slim'
# 挂载：      [SESSION-SLIM] mounted (minBytes=…, keepArchives=…, resolved=4/4)
# 单次迁移：  session-slim: "<id>" 68.6 MB -> 81 KB, 49 turns, 80 messages, 6320 ms
# 跳过：      … is owned by a live writer, leaving it alone
# 跳过：      … skipped (archive already exists)
ls -la <sessionDir>          # 日志变小
ls -la <sessionDir>/archive  # 原件在这里
```

## 出问题怎么办
1. **服务起不来**：删掉 profile 的 `node_modules/@local/dsh-session-slim` 或从 `package.json` 的 `dsh.profile.bundles` 里移除该行，重启。
2. **某个会话想回滚**：
   ```bash
   D=<sessionDir>
   cp "$D/archive/<时间戳>-session.v4.jsonl.zstd" "$D/session.v4.jsonl.zstd"
   ```
   （归档是逐字节原件，直接覆盖即回滚；回滚前先停服务。）
3. **不想自动跑了**：把 `enabled` 改 false（或 `minBytes` 调到极大）后重启。

## 已知边界
- 只处理 v4；纯 v3 会话先让 DSH 自己迁移。
- seeded 会话（fork/子会话）明确跳过。
- 每次迁移是一次性成本：69 MB 约 6.3 秒，峰值内存 ~170 MB（在子进程里）。
- 归档只增不减（按 `keepArchives` 修剪）；第一份是完整原件，之后的都很小。
- 会话里的工具输出/推理过程不会保留在新日志里——需要旧证据时用 `archive/` 原件（`bin/slim.mjs search`）。
