# Review 问题清单

## 方法

- 只读 review `web/`（React 19 + Vite + TS + Tailwind + Radix + Zustand）
- 对照 `MoviePilot-Frontend`（v3.2.2）和 `MoviePilot-App` 的成熟做法
- 行号为 review 时的近似值，改代码后会漂移；以文件/符号为准
- 本文只列问题，不包含具体改法；改法见 `02-roadmap.md`

## 先保留的资产（不要在重构中丢掉）

1. **聊天工程**：虚拟列表、分块流式 Markdown、代码围栏修复、重连快照、草稿、追问队列/steer、子 Agent/工具时间线、分享为图片
2. **性能纪律**：路由级懒加载、入口预加载、Markdown 变体按需加载、Vite 插件裁剪图标/字体
3. **设计系统**：语义 CSS tokens、3 套 scheme × light/dark、角色字号、surface 层级
4. **移动端**：浮动底部导航、Sheet、滑动返回、安全区、键盘高度处理、移动端不挂桌面 sidebar
5. **传输/错误层**：超时、取消、401/403 归一化、WS 退避重连、stale chunk reload、路由 ErrorBoundary
6. **权限感知导航** + 键盘优先的命令面板

---

## P0：先修，低风险高收益

### F-01 路由白屏：`Suspense fallback={null}`

- 证据：`web/src/App.tsx:240-317`、`web/src/components/chat/ChatView.tsx:1449,1538`
- 影响：慢路由/弱网切换时整页空白，用户以为打不开；和 10-28 的“白屏”体感叠加
- 处理：统一 `<AsyncState>` + 路由级骨架屏；禁止 `fallback={null}`
- Phase：0
- 验收：切换所有一级路由不出现纯白空屏；弱网 3G 模拟下仍有骨架

### F-02 两套 Toast 并存

- 证据：sonner（`App.tsx` 的 `Toaster`，44 个文件使用）；自写 DOM toast `web/src/utils/toast.ts`（13 个文件使用，如 `TasksPage`、`FilePanel`、`stores/files.ts`、`ImBindingDialog`）
- 影响：主题不一致、无 `aria-live`、暗色硬编码、关闭行为不一致
- 处理：统一到 sonner；删除 `utils/toast.ts` 或改成 sonner 的薄封装；重要通知进入通知中心（F-06）
- Phase：0
- 验收：全仓只有一套 toast API；屏幕阅读器能播报

### F-03 移动端 Usage/Memory 没有入口

- 证据：`web/src/components/layout/nav-items.ts:25-26` 标了 `hideOnMobile`；`BottomTabBar` 没有替代入口
- 影响：手机上无法进入用量/记忆页
- 处理：底部 Tab 加「更多」Sheet，或把两项并入「设置」
- Phase：0
- 验收：手机端一级页面全部可达，不需要手输 URL

### F-04 Web 包没有 lint/test/typecheck 门禁

- 证据：`web/package.json` 只有 `build`、`test:e2e`；`web/` 下无 ESLint/Prettier 配置；CI 只跑 root vitest + e2e，不 lint web
- 影响：风格漂移、类型错误靠人眼、重构风险高
- 处理：补 `lint`/`format:check`/`typecheck`/`test` 脚本；CI 加 web lint + typecheck + 单测
- Phase：0
- 验收：CI 在 PR 上跑 web 门禁；故意引入类型错误能被拦下

### F-05 PWA 更新/缓存没有兜底（10-28 事故直接相关）

- 证据：`web/public/sw.js` 只做旧 Workbox 缓存迁移，不缓存、不拦截；`index.html` 的 `no-cache` 正确，但旧 PWA/浏览器仍可能在部署后短暂白屏；无版本更新提示
- 影响：前端重建后旧 JS/CSS hash 404，页面白屏/打不开（10-28 11:52 已发生）
- 处理：加版本更新 toast（检测新 SW/构建号）、离线页、部署后提示硬刷新；保留 `sw.js` 迁移逻辑
- Phase：0（更新提示/缓存策略）、2（离线页）
- 验收：部署新版本后，旧页能提示更新并一键刷新；断网有离线页

---

## P1：能力补齐

### F-06 全局搜索太浅

- 证据：`web/src/components/command/CommandPalette.tsx`、`web/src/lib/command-items.ts` 只覆盖页面、workspace、session、设置、主题、新建会话、退出；无消息全文、文件、技能、MCP、插件；无最近搜索
- 影响：会话/文件多了以后找不到东西；命令面板价值被低估
- 处理：扩数据源 + 后端搜索 API；加最近搜索、权限过滤、移动端全屏
- Phase：1
- 验收：5 类数据源都能搜到；最近 5 条持久化；结果按权限过滤

### F-07 没有通知中心

- 证据：只有 sonner toast；`web/src/api/ws.ts` 有事件总线，但没有通知存储/抽屉/未读
- 影响：任务完成、后台任务、审批请求容易被错过；切走页面就丢
- 处理：新增 `stores/notifications.ts` + `NotificationDrawer`；扩展 WS 事件；未读/去重/全部已读/badge
- Phase：1
- 验收：任务完成/失败有通知；未读角标；全部已读；刷新后仍在

### F-08 `DataTable` 太基础

- 证据：`web/src/components/common/DataTable.tsx`；`UsersPage`、`BillingPage`、`MonitorPage`、`UsagePage` 各自实现排序/分页
- 影响：交互不一致、重复代码、移动端表格体验差
- 处理：统一表格能力：排序、分页、吸顶、行选择、密度、列显隐；桌面表格/移动卡片双呈现
- Phase：1
- 验收：四个页面复用同一套表格；移动端自动切卡片

### F-09 没有日志查看器

- 证据：`ProcessCard`/`ExecutionTrace` 只展示片段；Monitor 页没有容器/任务日志流
- 影响：排障要回终端；产品内看不到完整日志
- 处理：照 MP `LoggingView.vue` 做 React 版：批量刷新、600 行上限、级别过滤、搜索、跟随尾部、暂停/继续、待处理计数、下载
- Phase：1
- 验收：600 行日志滚动流畅；暂停后能跳回最新；可按级别/关键词过滤

### F-10 E2E 覆盖偏窄

- 证据：`web/playwright.config.ts` 只有一个 Chromium 移动项目（Pixel 7）；22 个 harness 以聊天为主；设置/账单/记忆/用户/能力库没有 E2E
- 影响：桌面端和非聊天页面回归靠手测
- 处理：加桌面视口项目；补 5 个关键页面的冒烟；后续加 WebKit
- Phase：1
- 验收：CI 跑桌面+移动两套冒烟；关键页 200/无 console error

### F-11 A11y 只做了一部分

- 证据：约 84 处 `aria-*`/live region；自写 toast 无 `aria-live`；无 axe 自动检查；纯图标按钮依赖 `IconButton` 自觉
- 影响：屏幕阅读器/键盘用户体验不稳定
- 处理：axe 冒烟、toast live region、Dialog/Sheet 焦点管理、键盘可达性测试
- Phase：1（基础）/2（全面）
- 验收：axe 无 critical；键盘可完成核心流程

---

## P2：结构调整

### F-12 巨型文件

- 证据（行数为 review 时）：
  - `stores/chat.ts` 6436
  - `components/chat/MessageInput.tsx` 1756
  - `components/chat/ChatView.tsx` 1606
  - `components/chat/MessageList.tsx` 1561
  - `components/chat/FilePanel.tsx` 1515
  - `components/chat/ProcessRows.tsx` 1014
  - `pages/AgentProfilesPage.tsx` 2359
  - `pages/MemoryPage.tsx` 1551
  - `pages/UsagePage.tsx` 1369
  - `components/chat/MessageBubble.tsx` 872
- 影响：难测试、难并行开发、review 成本高、改动容易互相踩
- 处理：`pages/`（路由壳）vs `views/`（领域 UI）拆分；chat store 按 domain 拆 slice；先补测试再搬
- Phase：2
- 验收：单文件目标 < 800–1500 行；核心 chat 路径有单测；行为无回归

### F-13 没有 server-state 层

- 证据：各 store/page 手写 loading/error/retry/cache/race；`utils/latest-request.ts`；部分页面订阅整个 store
- 影响：重复逻辑、竞态难查、缓存策略不一致
- 处理：引入 query cache（TanStack Query 或轻量自研），把服务端状态从 Zustand 分离；Zustand 只留 UI/会话状态
- Phase：2
- 验收：列表/详情统一 stale/retry/取消；不出现旧请求覆盖新请求

### F-14 导航/命令元数据三处重复

- 证据：`components/layout/nav-items.ts`、`components/settings/SettingsNav.tsx`、`lib/command-items.ts`
- 影响：加一个页面要改三处；权限/图标/文案容易不一致
- 处理：单一 `navigation.ts`（route/label/icon/permission/mobile visibility），三处派生
- Phase：0 起步，Phase 2 完成
- 验收：新增页面只改一处；命令面板/侧栏/设置一致

### F-15 图表各写各的

- 证据：`components/usage/UsageTrendChart.tsx`、`components/billing/DailyUsageChart.tsx` 手写 SVG；无共享 axes/tooltip/legend
- 影响：样式与交互不一致；新增图表重复劳动
- 处理：抽 chart primitives（scale/axis/tooltip/legend/empty/loading），复用 `--chart-*` tokens
- Phase：2
- 验收：Usage/Billing/Monitor 共用同一套图表组件

### F-16 插件/技能/MCP 三个页面近似

- 证据：`pages/SkillsPage.tsx`、`pages/McpServersPage.tsx`、`pages/PluginsPage.tsx` 结构相近，各自实现列表/详情/状态
- 影响：同一类“能力目录”体验分裂
- 处理：统一 catalog：卡片网格 + 详情抽屉 + 安装/更新状态 + 搜索/筛选 + 权限
- Phase：2
- 验收：三处共用组件；新增能力类型只加数据适配

### F-17 主题能力有限

- 证据：`hooks/useTheme.ts` 只有 light/dark/system、3 套 scheme、2 种字体；localStorage 保存
- 影响：跨设备不同步；个性化不足
- 处理：强调色预设/自定义 hex、圆角/密度；服务端用户配置同步
- Phase：2
- 验收：换设备登录后主题一致；重置可用

### F-18 PWA 无离线/推送

- 证据：`public/sw.js` 无缓存；`Notification` API 只在页面内使用；无 `PushManager`/`push` handler
- 影响：断网/关页收不到；PWA 更像网页而不是 App
- 处理：离线页 + 可选 Web Push（VAPID + 订阅存储 + SW `push`）；或原生 APNs
- Phase：1（Web Push 评估）/2（离线页）
- 验收：断网有离线页；订阅后关页能收到测试推送

---

## P3：可延后

### F-19 没有 i18n

- 证据：JSX/配置全硬编码中文；日期格式化 `zh-CN`
- 影响：要做英文/多语言时成本高
- 处理：message catalog、locale 检测、`html lang`；先抽词条再翻译
- Phase：3 / 可选
- 验收：至少中英切换；无硬编码漏网

### F-20 没有可定制工作台

- 证据：Monitor/Usage/Tasks 是固定页面，无 dashboard
- 影响：常用指标不能一屏看
- 处理：可选 GridStack/widget board；先做只读卡片，再做拖拽
- Phase：5 / 可选
- 验收：可保存布局；移动端降级为单列

---

## 优先级汇总

| 优先级 | 问题 | Phase |
|---|---|---|
| P0 | F-01 白屏、F-02 Toast、F-03 移动入口、F-04 门禁、F-05 PWA 更新 | 0 |
| P1 | F-06 搜索、F-07 通知、F-08 表格、F-09 日志、F-10 E2E、F-11 A11y | 1 |
| P2 | F-12 巨型文件、F-13 server-state、F-14 导航元数据、F-15 图表、F-16 目录、F-17 主题、F-18 PWA 离线/推送 | 2 |
| P3 | F-19 i18n、F-20 Dashboard | 3/5 |
