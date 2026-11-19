# dsh-session-slim

把 DSH 的长会话日志（`session.v4.jsonl.zstd`）压成**只含对话本身的轻量日志**，原来的整份日志移进 `archive/` 保留，随时可查。

## 为什么

一份 69 MB / 10 万 event / 80 天的会话，恢复时要 **~1.1 GB 内存 / 3.5 秒**；其中真正属于"对话"的只有可见窗口里的 80 条消息（~2.7 MB / 0.9%）。其余是工具调用、推理过程、逐 delta 回放流和历史折叠。

瘦身之后：**277 条 event / 80 KB，恢复 ~22 ms / ~80 MB**，人可见的 80 条消息逐字一致。

## 用法

```bash
# 看会话概况（不写盘）
node bin/slim.mjs info <sessionDir>

# 试算：只报告，不落盘
node bin/slim.mjs slim <sessionDir> --dry-run

# 就地替换：原日志移进 archive/，写新的轻量日志
node bin/slim.mjs slim <sessionDir> --replace

# 只生成到别处（不动原会话）
node bin/slim.mjs slim <sessionDir> --out <dir>

# 用官方恢复路径复核（open -> read -> sessions.prepare）
node bin/slim.mjs verify <sessionsRoot> <sessionId>

# 在归档里查关键词 / 时间段
node bin/slim.mjs search <archive/....zstd> --query "关键字" [--from 2026-11-15] [--to 2026-11-16] [--limit 20]
```

`slim` 的作用是**幂等**的：`archive/` 里已有归档就跳过（`--force` 可强制重做）。

## 保留什么、丢什么

| 保留 | 丢弃 |
|---|---|
| 用户消息（含注入的上下文消息） | 工具调用与工具结果 |
| assistant 的**正文** | reasoning |
| 最后一份压缩摘要（在 surface 里，作为消息） | `stream` 逐 delta 回放数据 |
| 标题、header（id / cwd / createdAt 原样） | 已被压缩折叠掉的历史（本来就不在上下文里） |

> 注意：这**不是**"全量导出历史"。DSH 的 surface 就是模型的上下文，把 10 万条 event 的正文全塞回去会让每轮请求都爆炸。历史证据走 `archive/` + `search`。

## 安全约束（已实现）

- **写作前先验**：先用编译好的事件写进临时目录，走一遍官方 `open -> read(0) -> sessions.prepare`，并比对「人可见消息的 SHA」与原日志一致；不一致直接放弃。
- **原子替换**：先 fsync 复制到 `archive/`，再写临时文件、`rename` 覆盖；任何一步失败，原日志都还在。
- **活写者检查**：替换前用 `flock` 试锁 `session.lock`——会话若正被 DSH 进程持有（比如正开着），直接拒绝，不会把正在写的日志掀掉。
- **幂等**：有归档就跳过。

## 已知边界

- 只处理 `session.v4.jsonl.zstd`；纯 v3 老会话要先让 DSH 迁移到 v4。
- 未覆盖带 seed 的子会话（`isSeeded`）、带图片附件的会话，需单独验证。
- turn 是按"一条用户消息 + 它的回复"重新分组的，`turn` 编号与原始会话不同。
- 需要系统里有 `zstd` 命令。

## 目录

```
bin/slim.mjs        CLI
src/transcript.mjs  流式 surface 折叠 + transcript 构建（纯函数）
src/slim.mjs        写入 / 校验 / 归档 / 替换 / 锁检查
src/search.mjs      归档检索
```

## 安装（bundle 形态）

```bash
# 从 GitHub（发布后）
dsh plugin --profile web add github:<owner>/dsh-session-slim
# 或本地 tarball
dsh plugin --profile web add ./dsh-session-slim-0.1.0.tgz
```
装完重启服务生效。包内自带 `dsh.bundle.patch`，不需要改任何 profile 配置。

## 插件形态（推荐）

插件在 `sessionPersistence.open()` 之前跑一次「物化」：把**官方当前的 surface**写成磁盘上的会话日志，原日志归档。之后 DSH 自己读到的就是这份小日志——后续的读取、追加、压缩全部由官方逻辑完成，插件不参与。

**不发明触发策略**：什么时候折叠、折叠哪些，全部由官方压缩（手动 / 上下文阈值）决定；插件只把"已经折叠后的可见窗口"落盘一次。

```yaml
# 你的 profile 的 cordis.patch.yml
- insert:
    - id: session-slim
      name: 'dsh-session-slim'
      config:
        enabled: true
        minBytes: 5242880   # 小于这个就完全跳过（只花一次 stat）
        keepArchives: 5     # 每个会话保留几份瘦身前的原件（第一次是 69MB 原件，之后都很小）
        verbose: true
```

行为：

- `open()` 时若日志 ≥ `minBytes` 且没有活写者持有锁 → 起一个**子进程**做迁移（不在服务进程里构造第二套 SessionStore，也杀不到服务）；
- 迁移前后各校验一次：官方 `open→read→prepare` 能读、人可见消息 SHA 与原日志一致，否则放弃；
- 首次打开约 6 秒（69 MB 的会话，峰值内存 ~170 MB，全在子进程里），之后每次打开 1 ms 级；
- 日志没长大到阈值就永远不介入。

**风险**：如果某个会话正被 DSH 打开（`session.lock` 被持有），插件跳过，本次仍按原方式加载——不会破坏正在写的日志。
