# 会话库 / 会话迁移插件 设计文档

- 版本：v0.1（草案）
- 日期：2026-10-22
- 状态：设计已确认，进入 Phase A 实现
- 工作目录：`C:\Users\ktypc\Desktop\dsh-sessions-migration`

## 1. 目标

一个 DSH（DeepSeek Harness，DeepSeek 的智能体运行宿主）插件，提供两块能力：

1. **会话库页面**（侧边栏入口）：以工作区为主体，列出磁盘上全部会话；每个工作区默认展开显示前 5 条，可一键展开全部；支持"未归档 / 全部（含已归档）"筛选；点击会话行打开该会话。
2. **会话导入（迁移）**：把 DSH 官方"下载会话日志"导出的 ZIP 导入本机，完成格式校验、路径重映射、附件还原。默认 dry-run，不覆盖已有会话，不删除源数据。

### 非目标（后续版本）

- 同机搬迁（修改会话 cwd、移动会话到其他工作区）
- 从 Claude Code / Codex 等第三方工具导入历史
- 覆盖同名会话、删除源日志、"移动"语义
- 改写 workspace 注册表把导入会话挂进工作区（v1 以"未分组"呈现）

## 2. 已核实的环境事实（2026-10-22，只读核查）

### 2.1 会话日志

- 根目录：`$DSH_HOME/sessions`（本机 `C:\Users\ktypc\.dsh\sessions`）
- 布局：`--<规范化 cwd>--/<session-id>/session.v4.jsonl.zstd`，一个会话一个文件
- 物理格式：多个独立 zstd（Zstandard，一种带校验的压缩算法）帧拼接；第一帧只含 header（日志头），之后每批追加一帧
- header 字段：`type="session"`、`version`、`id`、`createdAt`、`cwd`、`isSeeded`、`delegationDepth`、`agentPreset`，可选 `parentSession`、`origin="subagent"`
- 事件：`type/seq/time/data`，seq 从 0 连续、永不改写；派生事件带 `surfaceOp`
- 历史格式：v0–v3 由持久化后端在读取时自动迁移到 v4，写入方无需关心

### 2.2 工作区注册表

- 文件：`$DSH_HOME/storages/workspace.json`（domain（数据域）`workspace` v2）
- 结构：
  - `global.workspaceIds`：工作区显示顺序
  - `global.archivedSessionIds` / `global.pinnedSessionIds`：归档、置顶会话集合
  - `global.defaultWorkspaceId`、`global.pendingMutation`（可选）
  - `tables.workspaces[workspaceId]`：`{ path, title, sessionIds[], createdAt, updatedAt }`
- 归属规则：会话在**创建时**按 cwd 附着到工作区；注册表启动时仅在"从未初始化"时做一次历史补登记，之后不会重扫
- 路径唯一性以 `fs.realpath` 的规范路径为准

### 2.3 附件

- 根目录：`$DSH_HOME/attachments/v1`
- 图片：`objects/<sha256 前 2 位>/<sha256>`；会话里引用为 `sha256:<hash>`
- 通用文件：规范对象 `file-objects/<prefix>/<digest>`，引用路径 `files/<prefix>/<digest>/<name>` 是指向规范对象的硬链接
- `tmp/` 为写入暂存目录
- 内容寻址：相同字节只存一份（去重）

### 2.4 派生数据（可重建，不迁移）

- 投影缓存：`$DSH_HOME/storages/session_projcache/`
- 成本账本：`$DSH_HOME/storages/cost-meter/ledger.json`（第三方 dsh-cost-meter 维护）
- 全文检索索引：`dsh-session-query-sqlite`，派生库，可重建

### 2.5 两个硬约束

1. **持久化层没有删除 API**。官方文档明确 "Nothing deletes session files"。删除、移动、覆盖只能是文件级操作，路径校验与安全防护必须由插件自己承担。
2. **会话标题写在日志里**（log-backed 标题折叠），所以标题随日志迁移；但**工作区归属、置顶、归档状态不在日志里**，跨机必然丢失，除非导入包额外携带清单。

### 2.6 官方导出能力（本插件复用的基础）

- 包：`@deepseek-ai/dsh-session-log-export`
- 入口：会话头部 `⋯` → "Download session log"，或 `/export` 命令
- 产物：`dsh-session-<id>.zip`，包含根会话、子会话（`includeDescendants=true`）与附件
- 归档内布局（按官方说明）：
  - 每个逻辑日志：`session.jsonl`（v0）或 `session.vN.jsonl`，子会话在自己的目录下
  - 图片：`media/<attachmentId>.<ext>`
  - 通用文件：`files/<digest-prefix>/<digest>/<name>`
- 限制：一个会话同时只允许一个进行中的下载；产物是浏览器下载，不落 Host 路径

### 2.7 原生侧边栏的既有行为（本插件页面的参照）

- 每个展开的工作区先显示前 5 条会话（watermark（水位）），每次 "Show more" +5，剩余 ≤5 时一次放完，"Show less" 复位
- 子代理产生的会话默认隐藏
- 无标题会话显示"未命名"
- 置顶会话排在普通会话前；默认按"最后更新时间"倒序
- 归档筛选：Hide archived（默认）/ All conversations / Archived only
- 支持工作区树（按路径父子嵌套）与 Ungrouped（未分组）桶

## 3. 页面规格

### 3.1 入口与插槽

- `sidebar.panellist`（侧边栏全局面板图标位，list 类型）注册一行：图标 + "会话库"
- `main`（主面板，keyed 类型，按 sidebar 入口 id 选择）注册同 id 的页面
- 点击侧边栏入口切换到该面板而不改变已选会话

### 3.2 布局

```text
┌ 会话库 ─────────────────────────────────────────────┐
│ [搜索标题/工作区]  [筛选: 未归档 ▾]  [导入 ZIP]  [刷新] │
├─────────────────────────────────────────────────────┤
│ ▸ Misc                          39 个会话   10-21     │
│ ▾ rtsp_learn                    16 个会话   10-08     │
│    • SPI 收发异常排查                    10-08 14:22  │
│    • DMA 描述符对齐问题                  10-07 09:13  │
│    • （前 5 条）                                      │
│    [ 查看全部 16 条 ▾ ]                               │
│ ▸ dsh-sessions-migration        1 个会话    10-22     │
│ ▸ (未分组)  imx6ull-dev3         7 个会话              │
└─────────────────────────────────────────────────────┘
```

### 3.3 交互

| 动作 | 行为 |
|---|---|
| 点击分组头 | 展开/收起；首次展开显示前 5 条 |
| 点击"查看全部 N 条" | 展开该组全部会话；再点"收起"恢复 5 条 |
| 点击会话行 | 打开该会话（复用 `ctx.uiWorkspace.openSession`） |
| 行尾勾选框 | 预留：多选用于后续批量迁移/导出 |
| 搜索框 | 本地过滤标题与工作区名，不触发全文检索 |
| 刷新按钮 | 重新拉取 Host 快照 |
| 导入 ZIP | 打开导入向导（Phase C） |

### 3.4 筛选

- `未归档`（默认）：不显示 `archivedSessionIds` 中的会话
- `全部`：包含已归档会话（行置灰 + 归档标记）
- 子代理会话：默认隐藏；`Config.showSubagentSessions = false` 时无论筛选如何都不显示

### 3.5 排序

- 分组：置顶会话在前，其余按最后活动时间倒序
- 工作区顺序：按注册表 `workspaceIds` 顺序；未分组桶固定排在最后

### 3.6 边界情况

| 情况 | 处理 |
|---|---|
| 会话 cwd 无对应工作区（工作区被删） | 归入"未分组"，组名取目录尾段 |
| 工作区无可见会话 | 不显示该组（页面是会话浏览器） |
| 两个工作区同名 | 组名后附路径尾段区分 |
| cwd 目录已不存在 | 照常显示，行上标记"目录缺失" |
| 子代理会话 | 默认隐藏（Config 开关） |
| 超大工作区 | 只渲染 5 条，展开后才追加；不做虚拟滚动（v1） |
| 会话文件损坏/格式不支持 | 该行标记"无法读取"，不阻塞整页 |

## 4. 数据流

### 4.1 Host 聚合（一次快照）

| 数据 | 来源 | 备注 |
|---|---|---|
| 全部已落盘会话 + header | `ctx.sessionPersistence.list()` | 覆盖持久化根下所有会话（含未归组、归档、子代理） |
| 标题 | `ctx.sessionQuery.readTitleSnapshots(ids)` | 批量读取 |
| 工作区名/路径/归属 | `ctx.workspaceRegistry.list()` | 分组主体 |
| 置顶/归档集合 | workspace 注册表投影 | 决定可见性与标记 |
| 最后活动时间 | 投影中的会话时间（无则用 header.createdAt） | 排序依据 |

聚合结果：`SessionLibrarySnapshot`

```ts
interface SessionLibrarySnapshot {
  workspaces: LibraryGroup[]   // 注册表顺序
  ungrouped: LibraryGroup      // 未匹配到工作区的会话
  counts: { total: number; archived: number; subagent: number }
  fetchedAt: number
}

interface LibraryGroup {
  kind: 'workspace' | 'ungrouped'
  id: string            // workspaceId 或规范化目录
  title: string         // 工作区 title 或目录尾段
  path?: string
  sessions: LibrarySession[]
}

interface LibrarySession {
  id: string
  title?: string        // 无标题 → 前端显示"未命名"
  lastActivity: number
  pinned: boolean
  archived: boolean
  origin?: 'subagent'
  cwd?: string
  cwdMissing?: boolean
}
```

### 4.2 Remote 方法

- `library.snapshot()` → `SessionLibrarySnapshot`
- （Phase C）`migration.preflight(uploadId)` / `migration.apply(uploadId, decisions)`

### 4.3 性能

- 首次打开拉一次快照；标题批量读取；200 量级会话可接受
- 展开全部为纯客户端行为，不追加请求
- 手动刷新才重新拉取；v1 不做增量订阅

## 5. 导入（迁移）设计

### 5.1 输入与上传

- 输入：官方导出的 `dsh-session-<id>.zip`
- 上传：插件注册自己的 HTTP 路由接收 ZIP 流，落到 `$DSH_HOME/cache/session-migration/<uploadId>/`
- 不在浏览器内解析 ZIP，不在客户端做文件系统操作

### 5.2 预检（dry-run）

输出 `MigrationPlan`：

- 包内会话列表：id、标题、cwd、格式版本、isSeeded、parentSession
- 父子完整性：子会话的父是否在包内
- id 冲突：目标机已存在同 id 会话 → 标记"跳过"
- cwd 映射建议：精确命中 → 前缀替换 → 保留原值
- 附件清单：图片 / 文件、缺失项、总体积
- 结论：可导入条数、跳过条数、阻塞错误

### 5.3 路径映射

1. 包内 cwd 在本机存在 → 直接用
2. 用户设置前缀替换（如 `C:\Users\old\proj` → `D:\work\proj`）→ 用新路径
3. 都不可用 → 保留原 cwd（落成未分组会话，仍可打开）
4. 执行前必须展示"旧 → 新"对照

### 5.4 落盘

- 优先 `ctx.sessionPersistence.create(header)` → `handle.append(events)` → `flush()`，由官方编解码器负责 v4 编码与历史格式升级
- **禁止手工拼接 zstd 帧**
- header 仅改写 `cwd`；id、createdAt、isSeeded、agentPreset、parentSession 原样保留
- 先解压校验、再统一落位；失败清理，不留半截会话

### 5.5 附件还原

- 图片：按 `sha256` 直接写 `attachments/v1/objects/<前 2 位>/<hash>`；**不走 `attachments.saveImage`**（会重新规范化、改字节，导致引用 id 漂移）
- 文件：写 `file-objects/<prefix>/<digest>`，在 `files/<prefix>/<digest>/<名字>` 建硬链接（失败退化为复制）
- 全部做 SHA-256 校验后才算完成

### 5.6 幂等与冲突

- 保留原会话 id
- 目标机已存在同 id → 跳过并报告（重复导入同一包 = 全部跳过）
- 活会话（本进程持有的写入锁）→ 拒绝

### 5.7 安全

- ZIP 条目路径穿越（zip slip）校验
- 会话 id 字符白名单、cwd 规范化
- 不执行包内任何内容、不改写无关文件
- 导入完成后不自动唤醒 agent（仅落盘）

### 5.8 报告

- 成功 / 跳过 / 失败明细，可复制
- 导入记录保存在插件自有存储，供页面回看

## 6. 配置项（Config）

| 字段 | 默认 | 含义 |
|---|---|---|
| `previewLimit` | `5` | 每个工作区默认展开显示的会话条数 |
| `showSubagentSessions` | `false` | 是否显示子代理产生的会话 |
| `defaultFilter` | `'unarchived'` | 默认筛选：`unarchived` / `all` |
| `importMode` | `'dry-run'` | 导入默认行为：`dry-run` / `confirm` |
| `cacheDir` | `$DSH_HOME/cache/session-migration` | 上传包与解压暂存目录 |

## 7. 插件包结构

```text
dsh-sessions-migration/
  package.json            # 包清单：dsh.bundle.patch、dsh.client、engines.dsh
  cordis.patch.yml        # Loader 条目（insert 一行）
  index.js                # Host 半：聚合服务、Remote、导入内核
  client.js               # Client 半：会话库页面、导入向导
  locale/en.json
  locale/zh.json
  icon.svg
  README.md
  docs/design.md          # 本文档
```

## 8. 实施阶段与验收

### Phase A：只读会话库页面

- Host 聚合 + Remote + 页面骨架（分组、展开 5 条、查看全部、筛选、打开会话、搜索）
- 验收：侧边栏出现"会话库"；工作区分组正确；默认 5 条；查看全部生效；未归档/全部切换正确；点击行打开对应会话；子代理会话默认不出现
- 不写任何会话文件

### Phase B：导入内核

- ZIP 解析、预检、路径映射、日志落盘、附件还原、报告
- 验收：用一个真实导出包，预检列出全部会话与附件；导入后会话出现在"未分组"、可打开、可继续对话、图片/文件正常；重复导入全部跳过

### Phase C：导入 UI

- 页面顶栏"导入 ZIP"接入向导：上传 → 预检报告 → 路径映射 → 执行进度 → 结果
- 验收：全流程无需命令行；失败可从报告定位

## 9. 风险与待验证

| 风险 | 影响 | 验证方式 |
|---|---|---|
| ZIP 内日志是否为未压缩 JSONL、首行是否可直接改写 | 决定导入走 `append` 还是重新封装帧 | 用一份真实导出包解包核对 |
| 包内行是"逻辑事件"还是"存储形态"（`sourceEventSeqs` 是否压缩成区间） | 决定是否需要转换层 | 同上 |
| 导入会话在侧边栏的呈现（未分组是否可见） | 影响导入 UX | 导入到临时 DSH_HOME 观察 |
| fork / isSeeded 会话父缺失 | 历史可能缺口 | 预检拒绝父缺失的种子会话 |
| 大包（数十 MB 日志 + 附件） | 内存与耗时 | 流式解压 + 进度 + 可取消 |
| 页面 slot 注册与 React 依赖 | 页面能否渲染 | Phase A 先验证 |
| DSH 版本兼容 | 安装被拒 | `engines.dsh` 声明 + 安装时校验 |

## 10. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-22 | v0.1 | 初稿：确定会话库页面规格、导入范围与安全口径 |
