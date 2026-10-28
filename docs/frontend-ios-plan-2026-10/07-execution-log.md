# 执行记录

本文件记录按 `02-roadmap.md` 推进时的实际结果、基线和对方案的偏离。方案文档（00–06）
保持为 review 对象，不在原文修改。

## 2026-10-28 第一轮：基线 + iOS 壳骨架

### Web 质量基线（改动前）

环境：Node 22.19.0、npm 10.9.3，`npm ci`（根目录 + `web/`）按已提交 lockfile 安装。

| 检查      | 命令                                                      | 结果                                                                 |
| --------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| typecheck | `cd web && npx tsc --noEmit`                              | ✅ 通过                                                              |
| 单测      | `npx vitest run web/`（web 单测由根目录 vitest 配置运行） | ✅ 64 个文件 / 820 个用例通过                                        |
| build     | `npm --prefix web run build`                              | ✅ 通过（仅 chunk 体积提示）                                         |
| lint      | —                                                         | ⚪ **不存在**：`web/` 没有 ESLint 配置和 `lint` 脚本（与 F-04 一致） |
| format    | `npx prettier --check "web/src/**/*.{ts,tsx}"`            | 🟡 已有 19 个文件不符合 Prettier（存量，非本轮引入）                 |

结论：没有「本来就红」的门禁；lint 缺失是 F-04 本身。补 ESLint 需要新增依赖，待确认后
再做（见下方待决问题）。本轮只格式化本轮改动的文件，不批量重排存量文件。

### 本轮交付

- `web/src/native/`：桥接客户端（协议类型与校验、握手状态机、布局变量、Tab/路由映射），
  只在 App 注入 `window.HappyClawNative` 时以独立 chunk 动态加载，浏览器/PWA 不下载。
- `nav-items.ts` 增加 `native` 字段（Tab 或「更多」、SF Symbol），原生 Tab 从同一份
  导航元数据派生。
- `confirmDialog()` 与 `useHaptic` 在原生激活时走原生；否则行为不变。
- `globals.css`：底部导航占位改为 `--mobile-nav-reserve` / `--mobile-nav-clearance`
  变量（浏览器下取值与改动前完全相同），仅在 `data-native-chrome="active"` 下切换为原生高度
  并隐藏 Web 胶囊导航。
- `ios/`：SwiftUI 工程、`HappyClawCore` 纯 Swift 包（`swift test`）、真机安装脚本、README。

### 验证

- Web：`tsc` 通过；`npx vitest run web/` 全量通过（含新增 12 个桥接用例）；`build` 通过。
- iOS：`swift test` 14 个用例通过；模拟器编译通过；
  `xcodebuild -destination 'generic/platform=iOS' -allowProvisioningUpdates build`
  使用 `Apple Development` 证书签名成功（Personal Team，描述文件 7 天到期）。
- 模拟器（iPhone 17 / iOS 27）：App 通过 WKWebView 加载本机 Vite dev server，显示
  HappyClaw 初始化页面。

## 对方案的偏离与发现

1. **「TabView + NavigationStack」与单 WebView 冲突**（03-ios-native.md「原生壳组件」）。
   SwiftUI `TabView` 每个 Tab 持有独立内容，若每个 Tab 放一个 WKWebView，会出现多份
   Zustand store、多条 WS 连接和登录态/草稿分叉，违背「单一业务源」。实现改为：
   **单 WKWebView + 自绘浮动原生 TabBar**，点击只发 `nav.select` 让 Web 路由跳转；
   `NavigationStack` 以 Web 为根，用于推入原生页面（服务器地址、诊断）。
   方案里「原生拥有路由栈、Web 到根后原生 pop」在单 WebView 下没有可 pop 的原生页，
   本轮用 `allowsBackForwardNavigationGestures`（覆盖 pushState 历史）实现边缘返回。
   若以后要原生导航栏标题/返回按钮，需要逐页隐藏 Web 的 PageHeader，工作量应计入 Phase 3。
2. **握手失败不一律进恢复页**。方案写「握手失败或版本不兼容：显示原生恢复页」。MoviePilot
   这样做是因为 App 不提供网页导航；HappyClaw 的 Web 自带完整移动端导航，所以：
   版本不兼容 → 恢复页；**握手超时（旧前端、无桥接代码）→ 保持纯 Web chrome，App 仍可用**。
3. **`.prominentGlass()` 不是 iOS 26 的 API 名**。Liquid Glass 的视图修饰符是
   `glassEffect(_:in:)`（按钮样式为 `.glassProminent`）。实现使用 `glassEffect`，
   iOS 17–25 回退到材质背景。
4. **桥接消息结构**：方案示例为扁平字段（`{"v":1,"type":"confirm","id":"c1","title":...}`），
   实现统一为 `{v, type, id?, payload}` 信封，便于 Swift `Codable` 按类型解码、
   并对未知字段向前兼容。消息名也与方案草案略有不同（如 `confirm` → `confirm.request`），
   以 `ios/README.md` 为准。
5. **WKWebView 的 `confirm()` 必须由原生实现**。CLAUDE.md 约定「未保存离开守卫保持同步的
   原生 `confirm()`」；WKWebView 不实现 `WKUIDelegate` 对话框时 `confirm()` 静默返回
   `false`。壳已实现 alert/confirm/prompt，这一点应加入 Phase 3 验收清单。
6. **文件输入需要相机/相册权限说明**。WKWebView 的 `<input type=file>` 菜单含「拍照」，
   缺少 `NSCameraUsageDescription` 会直接崩溃；已在 Info.plist 补齐。
7. **免费 Personal Team 已确认**（本机描述文件 TeamName 为个人姓名、7 天有效）。
   与 R-06/R-08 一致：APNs 和 App Groups（Widget 共享数据）不可用。Phase 4 的
   原生推送/Widget 需要付费账号，否则只能走 Web Push。
8. **工期**：Phase 3 估 2–3 周偏乐观的部分在「原生导航栏」（见 1）和真机登录闭环；
   本轮骨架（壳 + 桥接 v1 + Tab）已打通，Sheet/分享/选图/Passkey 尚未开始。

## 2026-10-28 第二轮：原生导航栏 + 真机

决定：原生导航栏（标题、返回按钮）进入 MVP。

### 交付

- 协议 v1 增量（全部可选，不升版本）：`route.changed.nav` / `modal`、`theme.changed.background`、
  原生 → Web `nav.action`、能力 `navbar`。
- Web：`useNativeNavBar()` 页内覆盖；`data-native-title` / `data-native-replaced` 标记；已接入
  PageHeader、PageTopBar、智能体（新建面板）、记忆（移动端详情）、设置（分区按钮）。
- iOS：`NativeNavBar`（iOS 26 玻璃按钮），`LayoutCalculator` 增加顶部 inset。

### 验证

- 浏览器：Playwright 在 390×844 视口里注入模拟壳（按 ShellModel 的方式应答握手、画出原生栏
  位置），28 项检查通过，覆盖标题替换、根布局留白、页内返回、推入页冷启动返回、右侧按钮、
  弹窗时让位、主题底色、普通浏览器不受影响。
- 真机（iPhone 17 / iOS 26.5，免费签名）：App 经同一局域网连接本机 dev server，登录后
  原生 TabBar、任务/智能体/设置的原生标题、新建智能体的原生返回、「更多」Sheet、设置分区
  按钮都按预期工作。
- Web 全量单测、build、`swift test` 通过。

### 真机发现并修复

1. 输入框聚焦时键盘把整个文档推上去，内容滚到透明的原生标题栏下面叠在标题上。修复：
   栏底色取 Web 的 `--background`（Web 用 canvas 把任意 CSS 颜色转成 `#rrggbb`）。
2. 原生栏会盖住 Web 的 Dialog / Sheet。修复：Web 上报 `modal`，原生暂时隐藏两条栏，inset 不变。
3. 设置的分区抽屉顶部被状态栏遮住（独立 PWA 同样存在）。修复：抽屉补 safe-area 内边距。

### 仍待处理

- 打开的会话（`/chat/:folder`）保留 Web 页头：页头里有会话切换、上下文面板等业务入口，
  原生栏只能放一个按钮，硬替换会丢功能；边缘返回可用。
- 自动化限制：第三方输入法常驻后台时 WDA 认错前台 App，无法直接输入文字；密码框需要人工输入。

## 待决问题

- 是否为 `web/` 新增 ESLint（及 `lint` 脚本、CI 门禁）？需要新增开发依赖。
