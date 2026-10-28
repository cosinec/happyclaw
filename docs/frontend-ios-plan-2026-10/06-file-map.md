# 文件地图（review 用）

> 路径基于 2026-10-28 的本地代码。行号会漂移，review 时以文件/符号为准。

## HappyClaw Web（`web/`）

### 入口 / 路由 / 布局

| 文件 | 用途 |
|---|---|
| `src/App.tsx` | 路由表、懒加载、`Suspense`（P0 白屏点）、`Toaster`、WS 订阅 |
| `src/components/layout/AppLayout.tsx` | 桌面 sidebar + canvas、全局 WS、ErrorBoundary、命令面板宿主 |
| `src/components/layout/UnifiedSidebar.tsx` | 品牌/账户、搜索、新建会话、导航、workspace/session 树、折叠/拖宽 |
| `src/components/layout/BottomTabBar.tsx` | 移动端浮动底栏 |
| `src/components/layout/nav-items.ts` | 导航配置（Usage/Memory `hideOnMobile`） |
| `src/components/settings/SettingsNav.tsx` | 设置分区导航（与 nav-items/command-items 重复） |
| `src/components/auth/AuthGuard.tsx` | 权限/首次设置/强制改密 |

### 页面

| 文件 | 用途 |
|---|---|
| `src/pages/ChatPage.tsx` | 聊天路由壳 / 移动端 workspace 列表 |
| `src/pages/TasksPage.tsx` | 定时任务、运行历史、回收站 |
| `src/pages/MonitorPage.tsx` | 容器/队列/provider 监控 |
| `src/pages/UsagePage.tsx` | 用量趋势/归因/CSV |
| `src/pages/BillingPage.tsx` | 用户/管理员账单 |
| `src/pages/MemoryPage.tsx` | workspace memory 编辑/历史 |
| `src/pages/CapabilitiesPage.tsx` | 技能/MCP/插件 tabs |
| `src/pages/SkillsPage.tsx` / `McpServersPage.tsx` / `PluginsPage.tsx` | 三个近似 catalog |
| `src/pages/SettingsPage.tsx` | 22 个设置分区 |
| `src/pages/UsersPage.tsx` | 用户/邀请/审计 |
| `src/pages/AgentProfilesPage.tsx` | Agent 身份/提示词/策略 |
| `src/pages/LoginPage.tsx` / `SetupPage.tsx` | 登录/初始化 |

### 聊天

| 文件 | 用途 |
|---|---|
| `src/components/chat/ChatView.tsx` | 聊天主编排（header、session tabs、消息、composer、context panel、terminal） |
| `src/components/chat/MessageList.tsx` | 虚拟列表、日期分隔、滚动恢复、空态 |
| `src/components/chat/MessageBubble.tsx` | Markdown、附件、thinking、ProcessCard、子 Agent、分享 |
| `src/components/chat/StreamingDisplay.tsx` / `StreamingMarkdown.tsx` | 流式渲染、分块、围栏修复 |
| `src/components/chat/MarkdownRenderer.tsx` | 按需加载 Basic/Code/Math/Raw/Enhanced |
| `src/components/chat/MessageInput.tsx` | 草稿、图片/文件夹上传、追问/steer、模型选择、快捷键 |
| `src/components/chat/FilePanel.tsx` | 文件树、上传、预览/编辑、PDF/视频/音频/图片 |
| `src/stores/chat.ts` | 6436 行聊天状态（重点拆分对象） |
| `src/api/ws.ts` | WebSocket 单例、退避重连、事件总线 |
| `src/api/client.ts` | `apiFetch`、超时、取消、401/403 归一化 |

### 通用 / 设计系统

| 文件 | 用途 |
|---|---|
| `src/components/common/DataTable.tsx` | 基础表格（P1 升级对象） |
| `src/components/common/EmptyState.tsx` / `Skeletons.tsx` / `LoadErrorNotice.tsx` | 空/加载/错误（AsyncState 的拼装件） |
| `src/components/common/ConfirmDialog.tsx` / `PromptDialog.tsx` | 确认/输入弹窗 |
| `src/components/command/CommandPalette.tsx` | cmdk 命令面板（P1 扩展对象） |
| `src/lib/command-items.ts` | 命令项数据源（与 nav 重复） |
| `src/components/ui/*` | 27 个 shadcn 风格原语 |
| `src/styles/globals.css` | 1082 行 tokens/scheme/type scale/safe-area |
| `src/hooks/useTheme.ts` | light/dark/system + scheme + font |

### PWA

| 文件 | 用途 |
|---|---|
| `web/public/manifest.webmanifest` | standalone、图标、start_url |
| `web/public/sw.js` | 仅旧 Workbox 缓存迁移，不缓存、不推送 |
| `web/index.html` | `apple-mobile-web-app-capable`、viewport-fit、theme-color |
| `src/utils/legacyPwaCleanup.ts` | 旧 SW 清理 |
| `src/utils/toast.ts` | 自写 DOM toast（P0 统一对象） |

### 测试 / 构建

| 文件 | 用途 |
|---|---|
| `web/playwright.config.ts` | 仅 Chromium 移动（Pixel 7） |
| `web/tests/e2e/*` | 22 个聊天为主 harness |
| `vitest.config.ts`（仓库根） | 单测配置 |
| `web/package.json` | 只有 `build`/`test:e2e`，无 lint/typecheck/test |
| `.github/workflows/ci.yml` | CI（不含 web lint） |

---

## MoviePilot-Frontend（`MoviePilot-Frontend`）

### 可直接借鉴的交互/逻辑

| 文件 | 可借鉴点 |
|---|---|
| `src/components/states/NoDataFound.vue` | 空态 + 行动按钮 + 动效降级 |
| `src/components/misc/RemoteComponentError.vue` / `RemoteComponentLoading.vue` | 异步组件错误/加载兜底 |
| `src/layouts/default/components/OfflinePage.vue` | 全页离线覆盖 |
| `src/utils/loadingStateManager.ts` | 多源加载协调 |
| `src/components/dialog/SearchBarDialog.vue` | ⌘K、最近搜索、权限过滤、桌面/移动呈现 |
| `src/layouts/default/components/UserNotification.vue` | SSE 通知抽屉、未读/去重/分组/全部已读 |
| `src/utils/badge.ts` | app badge 事件 |
| `src/views/system/LoggingView.vue` | 日志批量/过滤/搜索/跟随尾部/暂停 |
| `src/components/misc/ProgressiveCardGrid.vue` | 渐进/虚拟卡片网格 |
| `src/components/cards/MediaCard.vue` | 懒加载/骨架/错误回退 |
| `src/components/theme/ThemeCustomizer.vue` | 强调色/圆角/玻璃/服务端持久化 |
| `src/composables/useThemeCustomizer.ts` / `src/utils/themePalette.ts` | 主题 token/调色 |
| `src/views/plugin/PluginCardListView.vue` | 插件目录卡片/筛选/排序 |
| `src/components/dialog/PluginMarketDetailDialog.vue` | 详情抽屉/版本/安装状态 |
| `src/components/render/FormRender.vue` / `PageRender.vue` / `DashboardRender.vue` | 声明式表单/页面/仪表盘 |
| `src/components/agent/AgentAssistantPanel.vue` | 流式对话/工具段/选择卡/恢复（对照，不必照搬） |
| `src/utils/sseManager.ts` | SSE 重连/后台关闭/去重 |
| `src/utils/requestOptimizer.ts` | 路由切换中止请求 |
| `src/utils/backgroundManager.ts` | 后台暂停轮询/SSE |
| `src/service-worker.ts` | 分层缓存策略 |
| `tests/setup.ts` / `tests/support/render.ts` | Vitest + MSW 测试基座 |

### 原生桥接（前端侧）

| 文件 | 用途 |
|---|---|
| `src/native/protocol.ts` | 原生协议类型/版本 |
| `src/native/registry.ts` / `panel.ts` | 面板注册/权限过滤/声明 |
| `src/native/layout.ts` | `data-native-chrome` + `--native-*` insets |
| `src/native/native.scss` / `cardMenus.scss` | 原生模式下隐藏 Web chrome |
| `src/native/header.ts` / `menu.ts` / `sheet.ts` / `confirmation.ts` / `page.ts` / `presentation.ts` | 各类声明投影 |
| `src/composables/usePWA.ts` | display-mode/standalone 检测 |
| `src/composables/useAvailableHeight.ts` | 安全区/可视高度测量 |

---

## MoviePilot-App（`MoviePilot-App`）

> GPL-3.0-only：只借架构，不要复制代码。

| 文件 | 用途 |
|---|---|
| `README.md` | iOS 17+、原生导航/搜索/面板、Liquid Glass、SideStore 安装 |
| `integration/README.md` | 前端/App 兼容契约：原生面板、业务 Sheet、卡片菜单、恢复页 |
| `ios/MoviePilot/ShellController.swift` | 根壳：导航、TabBar、工具栏、边缘返回、上下文菜单、Sheet、`.prominentGlass()` |
| `ios/MoviePilot/BottomNavigationView.swift` | 原生底部 Tab |
| `ios/MoviePilot/NativeWebSheetController.swift` | Web 内容 + 原生 Sheet（detents/grabber） |
| `ios/MoviePilot/NativePanelController.swift` | 原生面板 |
| `ios/MoviePilot/OperationMenuController.swift` | 原生操作菜单 |
| `ios/MoviePilot/CardMenuBridge.swift` / `CardMenuInteraction.swift` | 卡片长按菜单 |
| `ios/MoviePilot/PasskeyAuthenticator.swift` | Passkey |
| `ios/MoviePilot/NotificationController.swift` / `NotificationService.swift` | 通知 |
| `Sources/MoviePilotCore/BridgeProtocol.swift` | 协议定义 |
| `Sources/MoviePilotCore/ChromeSession.swift` | 握手/状态机（webNavigation→negotiating→prepared→nativeNavigation→releasing/recovery） |
| `Sources/MoviePilotCore/NativePanelFeedState.swift` | 原生面板状态 |
| `Sources/MoviePilotCore/OperationMenu.swift` | 操作菜单模型 |
| `Sources/MoviePilotCore/EdgeBackGesture.swift` | 边缘返回 |
| `Sources/MoviePilotCore/NavigationSnapshot.swift` | 导航快照 |
| `Sources/MoviePilotCore/Passkey.swift` | Passkey 通行证 |
| `Sources/MoviePilotCore/Widget*.swift` | Widget 桥/数据/存储 |
| `Sources/MoviePilotCore/Notification*.swift` | 通知地址/意图 |

---

## 快速检查命令

```bash
# HappyClaw Web
cd web/
rg -n "Suspense|fallback=\{null\}" src
rg -n "from '@/utils/toast'|sonner" src
rg -n "hideOnMobile|BottomTabBar" src/components/layout
rg -n "PushManager|showNotification|serviceWorker" src public

# MoviePilot-Frontend
cd MoviePilot-Frontend
rg -n "native-chrome|--native-|contentInsets" src/native src/styles
rg -n "display-mode|standalone" src/composables

# MoviePilot-App
cd MoviePilot-App
rg -n "prominentGlass|sheetPresentationController|edgeBack|contextMenu" ios Sources
```
