# 执行摘要

## 背景

HappyClaw Web 前端（`web/`）的聊天能力已经比较成熟：虚拟列表、流式 Markdown、草稿、追问队列/steer、子 Agent 时间线、分享为图片、移动端底部导航、权限感知导航、命令面板。这些是资产，方案里明确**不重写聊天**。

但对照 MoviePilot-Frontend 和一次只读 review，发现几类问题：

- **P0 体验/质量**：路由级 `Suspense fallback={null}` 白屏、两套 Toast、移动端 Usage/Memory 无入口、web 包没有 lint/test/typecheck 门禁
- **P1 能力**：搜索只到页面/会话级、没有通知中心、`DataTable` 很基础、没有日志查看器、E2E 只有移动 Chromium
- **P2 结构**：多个 1000–6000 行的巨型文件、没有 server-state 层、导航元数据三处重复、图表各写各的、插件/技能/MCP 目录重复、主题能力有限、PWA 无离线/更新提示
- **P3 长期**：没有 i18n、没有可拖拽工作台、A11y 只做了一部分

同时，用户希望有 **iOS 原生质感**。MoviePilot-App 已经验证了最佳范式：**SwiftUI 原生壳 + WKWebView 承载业务前端 + 版本化桥接协议**，原生只接管 chrome（导航/TabBar/Sheet/菜单/推送/Widget），业务页面和聊天继续用 Web。

## 目标

1. **体验**：消除白屏闪烁；统一 Toast；补全局搜索、通知中心、日志查看器、可用表格；移动端所有页面可达
2. **工程**：拆巨型文件；引入 server-state 层；统一导航元数据；补 lint/test/typecheck/CI；补 A11y 与 E2E
3. **iOS 原生质感**：SwiftUI 壳 + WKWebView，原生 TabBar/导航/Sheet/上下文菜单/分享/选图/Passkey/推送/Widget；Web 内容用 `--native-*` 变量避让原生 chrome
4. **不破坏现有聊天**：所有改造以聊天为回归重点，阶段上线、可回滚

## 策略

- **PWA 优先**：先修 Web/PWA，所有改进对浏览器、PWA、原生壳同时生效
- **原生可选**：iOS 壳是增强，不是前置条件；没有 App 也能完整使用
- **渐进改造**：Phase 0 止血 → Phase 1 能力 → Phase 2 结构 → Phase 3 原生壳 → Phase 4 原生增强
- **单一业务源**：Web 继续拥有路由、数据、聊天、弹窗内容；原生只做 chrome 和 OS 能力
- **每个 Phase 部署验证**：按 AGENTS.md，构建后部署到 Mac mini，做生产环境验证再报完成

## 时间线（粗略）

假设 1 名高级前端 + 后端配合：

| Phase | 内容 | 工期 |
|---|---|---|
| Phase 0 | 止血 + 工程治理 | 1 周 |
| Phase 1 | 搜索 / 通知 / 日志 / 表格 | 2 周 |
| Phase 2 | 结构重构 + 目录/主题/PWA | 3 周 |
| Phase 3 | iOS 原生壳 MVP | 2–3 周 |
| Phase 4 | 推送 / Widget / 后台恢复 | 2 周 |
| Phase 5 | 原生聊天（可选） | 按需 |

总计约 **10–12 周**（1 人）；如果 Web 和 iOS 两人并行，约 **6–8 周**。估算不含 App Store 审核和长期维护。

## 成功指标

**Phase 0**
- 路由切换无白屏闪烁（骨架屏覆盖）
- 只剩一套 Toast，且有 `aria-live`
- 移动端 Usage/Memory 有入口
- `npm --prefix web run lint/typecheck/test/build` 全绿，CI 门禁生效

**Phase 1**
- 全局搜索覆盖消息、文件、技能、MCP、插件、最近搜索
- 通知中心支持未读、去重、全部已读、badge
- 日志查看器 600 行流畅，支持过滤/搜索/暂停/跟随尾部
- DataTable 支持排序、分页、吸顶、选择、密度

**Phase 2**
- `chat.ts` 拆到单模块 < 1500 行，核心路径有测试
- 图表共用 axes/tooltip/legend primitives
- 插件/技能/MCP 统一目录，可搜索筛选
- 主题支持强调色/圆角，跨设备同步
- PWA 有离线页和版本更新提示

**Phase 3 / 4（iOS）**
- App 能加载你的 HappyClaw 地址，登录态保持
- 原生 TabBar/导航/返回/Sheet 正常；分享、选图可用
- Passkey 登录可用（可回退密码）
- 推送 < 5s 到达并可深链；Widget 定时刷新
- 后台回来不丢会话；桥接失败有原生恢复页
- Crash-free sessions ≥ 99.5%（个人使用基线）

## 非目标

- 不把聊天重写成原生 SwiftUI
- 不引入 Vue/Vuetify 或第二套前端框架
- 不做一次性大爆炸重构
- 不默认上 App Store（个人自签优先）
- 不在本轮做多语言（除非决策要做中英）
- 不接公司/第三方系统

## 关键取舍

- **Web 聊天保留**：原生壳不做消息列表，避免双实现和流式逻辑分叉
- **PWA 先行**：先让无 App 用户受益，再让原生壳复用同一套 Web
- **原生只做 chrome**：导航/TabBar/Sheet/菜单/推送/Widget 是原生价值最大的部分
- **推送二选一或都做**：Web Push 快但 iOS 限制多；APNs 体验好但需要证书和后端
- **重构按模块**：先拆 `chat.ts` 周边、再拆 UI，不做大文件一次性重写

## 近期事件（为什么现在做）

- **2026-10-28 11:52**：一次前端部署后资源 hash 全变，旧 PWA/浏览器缓存导致白屏/打不开；说明 PWA 更新提示和缓存策略必须补
- **2026-10-27**：NAS 主板 POST 红灯（ASRock CPU/DRAM）导致家庭服务短时离线；claw 在 Mac mini 上，走本机 frp 不受影响。原生 App 的离线恢复页也应覆盖这类“服务端暂时不可达”的场景
