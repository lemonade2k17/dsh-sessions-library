# 会话库（dsh-sessions-library）

DeepSeek Harness 桌面端的会话管理插件：把 `~/.dsh/sessions` 下的会话按**工作区**分组列出来，并提供会话包的**导出 / 导入（迁移）**、**回收站**和**操作日志**。

- 侧边栏入口：**会话库**
- 主区域页面：会话列表、回收站、操作日志三个视图
- 纯本地：所有读写都发生在 `DSH_HOME`（默认 `%USERPROFILE%\.dsh`）内，不联网、不上传

## 功能

| 区域 | 能力 |
| --- | --- |
| 会话库 | 按工作区分组（组内默认展开 5 条，可「查看全部」）；「未归档会话 / 全部会话」筛选；按标题或工作区搜索；一键展开/收起全部 |
| 勾选操作（底部 dock） | 移入回收站、导出所选、清除选择；未勾选时按钮置灰不可点 |
| 回收站 | 按会话家族分组，恢复回会话库、永久删除（需输入「永久删除」确认）、被应用保留的会话会排队到下次启动整理 |
| 操作日志 | 每条动作记录（含时间、动作、会话），可搜索、排序、勾选删除，也可整表清空 |
| 导出会话包 | 选中会话 → 导出为 ZIP（`manifest.json` + 原始 `session.v4.jsonl.zstd` 字节），可指定目标目录 |
| 导入会话包 | 预检（会话数、冲突、工作区映射）→ 选择目标工作区 → 导入；跨机器的会话会自动改写日志头里的工作目录（历史事件字节不变） |

## 安装

### 方式 A：本地目录（开发 / 单机）

1. 把本仓库复制到目标机器任意目录（例如 `D:\dsh-plugins\dsh-sessions-migration`，不需要 `.git`）。
2. 在目标机器的 profile 目录（默认 `%USERPROFILE%\.dsh\profiles\desktop`）建立目录联接：

   ```powershell
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-sessions-library" "D:\dsh-plugins\dsh-sessions-migration"
   ```

3. 在该 profile 的 `package.json` 里登记依赖与 bundle：

   ```json
   "dependencies": {
     "dsh-sessions-library": "link:D:/dsh-plugins/dsh-sessions-migration"
   },
   "dsh": {
     "profile": {
       "bundles": [ "...", "dsh-sessions-library" ]
     }
   }
   ```

4. **完全退出 DSH**（托盘图标退出，不是关闭窗口）后重新启动。

也可以直接用 DSH 的插件管理安装本地路径，它会替你完成第 2、3 步。

### 方式 B：离线包（tgz）或软件源（registry）

```powershell
npm pack     # 在本仓库生成 dsh-sessions-library-<version>.tgz
```

把生成的 `.tgz` 拷到目标机器，任选其一：

- 用 DSH 插件管理安装该本地文件；
- profile 的 `package.json` 写成 `"dsh-sessions-library": "file:D:/packages/dsh-sessions-library-0.3.0.tgz"`，然后在该 profile 目录执行 `pnpm install`；
- 若已发布到 npm 或私有源，直接按插件名安装。

### 安装完成后的自检

| 检查点 | 期望 |
| --- | --- |
| 侧边栏 | 出现「会话库」入口 |
| 页面 | 能列出本机会话；没有会话时显示空态 |
| 目录 | 自动创建 `~/.dsh/sessions-library/`、`~/.dsh/sessions-trash/` |
| 日志 | `~/.dsh/cache/sessions-library/debug.log` 里有 `plugin activated` 与 `registered 14` |

## 兼容性

| 项 | 要求 |
| --- | --- |
| DSH | `>=0.2.1-rc.3 <0.3.0-0`（本插件在 **0.2.1-rc.3** 上验证通过，见 `package.json` 的 `dsh.compatibility`） |
| Node | `^22.19.0 \|\| >=24.0.0`（用到 `zlib` 的 zstd 同步 API） |
| 平台 | 插件本身跨平台；文中 `mklink` 步骤仅适用于 Windows，其他系统用 `ln -s` |
| 运行时依赖 | 无第三方包：Host 只用 `node:fs / node:os / node:path / node:zlib`，Client 只用 ModuleLoader 注入的 `react` |

> ⚠️ 插件调用的是 DSH 的内部服务，不是稳定公开 API。升级 DSH 后请回归验证，重点是这几项：
> Host 侧 `connection.fetch`、`sessionPersistence`、`sessionController`、`sessionQuery`、`workspaceController`、`workspaceRegistry`、`agents`；
> Client 侧 `uiWorkspace`、`sessions`、`slots`、`remote.directoryPicker`。

## 数据存放位置

全部位于 `DSH_HOME`（默认 `~/.dsh`）：

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `sessions/` | 会话本体（DSH 管理） | 插件只读浏览；删除即移出该目录 |
| `sessions-trash/<时间戳>-<会话id>/` | 回收站条目（`session/` + `manifest.json`） | 页面恢复或永久删除 |
| `sessions-library/exports/*.zip` | 导出的会话包 | 可自行备份/清理 |
| `sessions-library/operations.log` | 操作日志（JSONL，512 KB 上限，保留最近 1000 条） | 页面可删除所选或清空 |
| `sessions-library/pending-trash.json` | 待重启整理的删除队列 | 建议不要手改 |
| `sessions-library/audit.log` | 永久删除审计（只追加） | 排查用 |
| `cache/sessions-library/debug.log` | 调试日志，每次启动重置 | 反馈问题时附上 |
| `cache/sessions-library/last-snapshot.json` | 最近一次快照 | 排查用 |

## 卸载

1. 从 profile 的 `dsh.profile.bundles` 中删除 `dsh-sessions-library`；
2. 从 `dependencies` 中删除该依赖并执行 `pnpm install`（或直接删掉 `node_modules` 里的 junction）；
3. 可选：删除 `~/.dsh/sessions-library/`、`~/.dsh/sessions-trash/`。
   会话本体在 `~/.dsh/sessions/`，卸载插件不会影响它们。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 装完看不到入口 | Host 半在启动时加载：必须**完全退出** DSH 再启动 |
| 点了按钮提示「插件 Host 端尚未加载新版本」 | 同上，Host 还是旧代码；Client 刷新页面即可，Host 必须重启 |
| `cannot get property "xxx" without inject` | DSH 版本与本插件不兼容，按上面的兼容性表处理 |
| 回收站/日志页没有勾选框 | Host 版本过旧（行 id 由 Host 下发），重启后出现 |
| 恢复了会话却仍显示「已归档」 | 删除**之前**它就处于归档状态，回收站会忠实还原该状态（设计如此） |
| 导入时提示「本地已存在」 | 该会话本地已存在：若它处于归档状态，导入会取消归档并归入所选目标工作区；可见的副本则跳过，避免覆盖 |
| 导入后侧边栏没看到 | 确认已重启并刷新页面；或到会话库「全部会话」视图查看（归档会话默认隐藏） |

## 开发

| 文件 | 说明 |
| --- | --- |
| `index.js` | Host 半（ESM，Cordis 插件）：14 条 `POST /api/sessions-library/*` 路由、快照聚合、删除/回收站/导入导出等文件操作 |
| `client.js` | Client 半：`window.__ModuleLoader__.load` 注册 `sidebar.panellist` 与 `main` 两个界面 |
| `cordis.patch.yml` | Bundle patch：把本包主入口注册为 Host 插件，`package.json` 的 `dsh.client` 负责加载浏览器半 |
| `locale/*.json` | 侧边栏条目的多语言标题 |
| `docs/design.md` | 设计说明（历史版本，部分后续功能未覆盖） |

- 改 Host：必须重启 DSH；改 Client：浏览器强刷（Ctrl+F5）即可。
- 静态检查：`npm run check`（对两个入口做语法检查）。
- 没有自动化测试；会话/回收站/导入导出的验证目前靠临时脚本与手工回归。
- 反馈问题时请附 `~/.dsh/cache/sessions-library/debug.log`。

## 许可

MIT，见 [LICENSE](LICENSE)。
