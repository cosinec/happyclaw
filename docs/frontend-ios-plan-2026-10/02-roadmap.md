# 路线图

> 工期按 1 名高级前端 + 后端配合估算；iOS 需要 macOS/Xcode。每个 Phase 结束都按 AGENTS.md 部署到 Mac mini 并做生产环境验证。

## 总览

| Phase | 主题 | 工期 | 依赖 |
|---|---|---|---|
| 0 | 止血 + 工程治理 | 1 周 | 无 |
| 1 | 搜索 / 通知 / 日志 / 表格 | 2 周 | 后端搜索/通知 API |
| 2 | 结构重构 + 目录/主题/PWA | 3 周 | Phase 0/1 |
| 3 | iOS 原生壳 MVP | 2–3 周 | Phase 0/1，桥接协议 |
| 4 | 推送 / Widget / 后台恢复 | 2 周 | Phase 3，后端 Push |
| 5 | 原生聊天（可选） | 按需 | 性能数据 |

如果 Web 和 iOS 两人并行：Web 做 0→2，iOS 从 Phase 1 后半段开始做桥接原型，整体约 6–8 周。

---

## Phase 0：止血 + 工程治理（1 周）

### 目标

让现有页面不再白闪、Toast 一致、手机端全可达、Web 有质量门禁、PWA 部署后能提示更新。

### 任务

**D1–D2：AsyncState**
- 新建 `web/src/components/common/AsyncState.tsx`
  - props：`loading`、`error`、`empty`、`onRetry`、`skeleton`、`children`
  - 内部组合现有 `EmptyState`、`Skeletons`、`LoadErrorNotice`
- 替换 `App.tsx:240-317` 的 `Suspense fallback={null}` 为路由级骨架
- 替换 `ChatView.tsx:1449/1538` 的 null fallback
- 替换 `TasksPage`、`FilePanel`、`UsersPage` 里手写的 loading/empty/error
- 加 Vitest 覆盖：loading→empty→error→retry→success

**D3：统一 Toast**
- 保留 sonner，删除 `utils/toast.ts` 的自写 DOM toast
- 所有调用点改到统一 API（可保留同名函数做薄封装）
- 补 `aria-live="polite"`/`role="status"`
- 重要事件（任务完成/失败/审批）标记为“可进通知中心”，Phase 1 接入

**D3–D4：导航单一元数据 + 移动入口**
- 新建 `web/src/lib/navigation.ts`：route、label、icon、permission、mobile 可见性、分组
- `nav-items.ts`、`SettingsNav.tsx`、`command-items.ts` 改为派生
- 底部 Tab 加「更多」Sheet，放入 Usage/Memory 或并入设置
- 验收：新增页面只改一处元数据

**D4：PWA 更新提示**
- 构建时注入 `buildId`/`version`（Vite define）
- 前端轮询 `/api/health` 或读取 `index.html` 的 buildId；发现新版本弹“有新版本，刷新”
- 保留 `public/sw.js` 迁移逻辑；不引入复杂缓存
- 部署前确认 `index.html` 仍是 `no-cache`，assets 仍 `immutable`
- 目标：避免 10-28 那种“前端重建后旧缓存白屏”

**D5：Web 质量门禁 + 部署验证**
- `web/package.json` 补：
  - `lint`（ESLint）
  - `format:check`（Prettier）
  - `typecheck`（`tsc --noEmit`）
  - `test`（Vitest）
- CI 增加 web lint/typecheck/test
- 加一个 axe 冒烟（登录页 + 聊天页）
- 构建、部署 Mac mini、你的 HappyClaw 域名冒烟、看日志

### 交付物

- 4–5 个 PR（AsyncState、Toast、导航、PWA 更新、CI）
- 改动前后截图/录屏
- CI 绿灯截图
- 部署验证记录

### 验收

- 所有一级路由切换无纯白空屏
- 全仓只有一套 Toast API，屏幕阅读器能播报
- 手机端 Usage/Memory 可达
- `lint/typecheck/test/build` 全绿，CI 拦截
- 新版本部署后旧页能提示刷新

### 风险

- 动 `App.tsx` 路由容易影响聊天页 → 先加 skeleton，不改路由结构
- 删除旧 toast 可能漏调用点 → 用 TypeScript 找不到符号 + grep 双保险

---

## Phase 1：搜索 / 通知 / 日志 / 表格（2 周）

### 目标

把“找东西、看结果、排障”三件事补齐，这是日常使用频率最高的能力。

### 任务

**Week 1：全局搜索**
- 后端：统一 `/api/search`（或分资源端点），支持 `q`、类型、分页、权限过滤
- 前端：扩 `lib/command-items.ts` 数据源
  - 消息全文（会话/workspace 范围）
  - 文件（名称/路径）
  - 技能、MCP、插件
  - 页面/设置/会话（已有）
- `CommandPalette` 加最近搜索（localStorage，5 条）、分组、空状态、移动端全屏
- 结果点击跳转并高亮命中
- 验收：5 类数据源可搜；最近搜索持久；权限过滤正确

**Week 1–2：通知中心**
- 后端/WS：任务完成、任务失败、后台任务、审批请求事件
- 前端：`stores/notifications.ts`
  - 未读、去重 key、分组（任务/系统/审批）、全部已读、按组清除
- `NotificationDrawer.tsx`：右侧抽屉（桌面）/全屏 Sheet（移动）
- 未读角标：侧栏 + `document.title`；可选 app badge
- 验收：关闭页面再回来通知还在；全部已读；不重复刷屏

**Week 2：日志查看器 + 表格 + E2E/A11y**
- `LogViewer.tsx`：
  - SSE/WS 批量刷新（~80ms）
  - 600 行上限、虚拟滚动
  - 级别过滤、关键词搜索、时间分组
  - 跟随尾部、暂停/继续、待处理计数、下载
- 接入 Monitor 容器日志、任务运行日志
- `DataTable` 升级：
  - 排序、分页、吸顶、行选择、密度、列显隐
  - 桌面表格 / 移动卡片双呈现
  - 迁移 Users/Billing/Monitor/Usage
- Playwright：加桌面项目 + 5 个关键页冒烟
- axe：登录、聊天、任务、设置

### 交付物

- 搜索 API + 前端
- 通知中心
- 日志查看器
- DataTable v2
- E2E/A11y 报告

### 验收

- 搜索 P95 < 300ms（本地数据规模）
- 通知可读/可清/可深链
- 600 行日志滚动流畅；暂停后跳回最新
- 四个页面共用 DataTable；移动端自动卡片
- 桌面+移动 E2E 绿；axe 无 critical

### 风险

- 消息全文搜索需要索引/分页，避免全表扫
- 通知事件过多会刷屏 → 去重 + 分组 + 静默规则

---

## Phase 2：结构重构 + 目录/主题/PWA（3 周）

### 目标

把“能用”变成“好维护”：拆巨型文件、引入 server-state、统一目录和图表、主题增强、PWA 离线。

### 任务

**Week 1：Chat 拆分（行为不变）**
- `stores/chat.ts` 按域拆 slice：
  - `groups`、`sessions`、`messages`、`streaming`、`drafts`、`usage`、`agentState`
- `ChatView` → `views/chat/ChatView` + `ChatHeader`、`SessionTabs`、`ChatContextPanel`、`ChatMobileSheets`
- `MessageInput` → `Composer`、`AttachmentTray`、`ModelPicker`、`QueueControls`
- `MessageList` 保持虚拟化；`MessageBubble` 拆 `MarkdownBlock`、`ProcessSection`、`AttachmentSection`
- 先补测试再搬；每个 PR 只搬一个模块

**Week 2：Server-state 层**
- 引入 TanStack Query（或轻量 query cache）
- 先迁 2–3 个页面做样板：Tasks、Users、Usage
- 统一 stale/retry/取消/错误归一化
- Zustand 只保留 UI/会话/流式状态

**Week 2–3：目录 / 图表 / 主题 / PWA**
- 统一 Skills/MCP/Plugins 目录：
  - 卡片网格 + 详情抽屉 + 安装/更新状态 + 搜索/筛选 + 权限
- 图表 primitives：axes、tooltip、legend、empty/loading；迁移 Usage/Billing/Monitor
- 主题：
  - 强调色预设 + 自定义 hex
  - 圆角/密度
  - 服务端用户配置同步（local-first + 后端镜像）
- PWA：
  - 离线页
  - 可选 Web Push 评估（VAPID + 订阅 + SW `push`）
  - 后台暂停轮询/SSE

### 交付物

- Chat 拆分 PR 系列
- Query 层 + 3 个样板页
- 统一目录
- 图表 primitives
- 主题设置
- PWA 离线页

### 验收

- `chat.ts` 单模块 < 1500 行；`ChatView` < 800 行
- 核心 chat 路径单测；无行为回归
- 三个样板页不再手写 loading/race
- 三个目录共用组件
- 图表共用一套轴/提示
- 换设备主题一致
- 断网有离线页

### 风险

- 这是最大的一块，必须按模块小步走；每个 PR 可独立回滚
- Query 层迁移不要一次全换，先 2–3 页验证

---

## Phase 3：iOS 原生壳 MVP（2–3 周）

### 目标

做出“像原生 App”的最小壳：原生 TabBar/导航/Sheet/分享/选图/Passkey，WebView 跑现有 Web。

### 任务

**Week 1：壳 + 布局桥接**
- Xcode 新工程（SwiftUI，iOS 17+）
- `RootShell`：`TabView` + `NavigationStack` + `WKWebView`
- 加载你的 HappyClaw 地址，持久化 `WKWebsiteDataStore`
- 原生 TabBar（会话/工作台/任务/能力/我的）
- 边缘返回手势；安全区/键盘处理
- 桥接 v0：
  - `native.hello` / `route.changed` / `layout.insets`
  - Web 设置 `data-native-chrome="active"` 和 `--native-*`
  - 隐藏 Web header/TabBar/底部导航
- 验收：无双层导航；旋转/键盘不遮挡输入

**Week 2：原生交互**
- 原生 Sheet：`UISheetPresentationController`，medium/large + grabber
- 原生确认框、操作菜单
- 分享面板（`UIActivityViewController`）
- 相册/文件选择（`PhotosPicker`/`UIDocumentPicker`）→ 传回 Web
- Haptics；长按上下文菜单（先做会话/消息）
- Passkey/Face ID：`ASAuthorization` + `native-passkey.html`；回退密码
- 验收：分享、选图、Sheet 可用；Passkey 可用

**Week 3：收尾 + 分发**
- 原生恢复页（桥接失败/服务不可达）
- 崩溃日志/诊断
- SideStore/AltStore 签名与安装文档
- 真机测试：登录、聊天、文件、任务
- 验收：核心路径无崩溃；离线/服务不在时有恢复页

### 交付物

- Xcode 工程 + 桥接协议文档
- 可安装 IPA（自签）
- 真机测试清单
- 安装/续签说明

### 验收

- App 加载 claw，登录态保持
- 原生 TabBar/返回/Sheet 正常
- 分享/选图可用
- Passkey 可用（可回退）
- 聊天流式输出正常，后台回来能恢复

### 风险

- WKWebView 的 cookie/401/登录跳转 → 先在真机验证登录闭环
- 桥接失败要有恢复页，不能白屏

---

## Phase 4：推送 / Widget / 后台恢复（2 周）

### 任务

- **推送二选一或都做**
  - Web Push：VAPID、订阅表、SW `push` handler、iOS 16.4+ 主屏 PWA
  - APNs：证书/Key、device token 注册、后端发送、深链
- 推送事件：任务完成/失败、审批请求、后台任务结果
- 角标：未读数
- WidgetKit：
  - 未读/运行中任务/今日用量
  - App Group 共享快照
  - 时间线刷新
- 后台恢复：
  - 记录 route/滚动位置
  - 回前台重连 WS + 拉增量
- iOS 26 Liquid Glass：`.prominentGlass()`（有版本判断）
- 离线恢复页完善
- 验收：推送 <5s；Widget 刷新；后台回来不丢会话

### 风险

- APNs 证书/Key 管理；免费账号签名 7 天
- Widget 数据不能太大；只读快照

---

## Phase 5：原生聊天（可选）

只有满足以下条件才做：
- Web 聊天在长会话/大文件下出现明显性能瓶颈
- 原生消息列表能带来 measurable 提升
- 团队愿意维护两套消息渲染

否则保持 WebView，避免双实现分叉。

---

## 里程碑

| 里程碑 | 时间 | 内容 |
|---|---|---|
| M0 | 第 1 周末 | 无白屏、单 Toast、移动全可达、CI 门禁 |
| M1 | 第 3 周末 | 搜索/通知/日志/表格/E2E |
| M2 | 第 6 周末 | Chat 拆分、Query 层、目录、图表、主题、PWA |
| M3 | 第 9 周末 | iOS 壳 MVP |
| M4 | 第 11 周末 | 推送/Widget/后台恢复 |

## 部署与验证（每个 Phase）

1. `npm --prefix web run lint && typecheck && test && build`
2. 部署到 Mac mini（现有流程）
3. 你的 HappyClaw 域名冒烟：登录、聊天、文件、任务、设置
4. 看 `data/launchd.out.log`/`err.log`、浏览器 console、WS 连接
5. 记录回滚点（代码版本/构建产物）；不创建数据库备份（按 owner 策略）
