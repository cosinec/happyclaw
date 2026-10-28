# HappyClaw iOS 原生壳

SwiftUI 原生壳 + WKWebView + 版本化 JSON 桥接。原生只接管 chrome（TabBar、导航栏标题与
返回按钮、导航栈、边缘返回、Sheet、操作菜单、确认框、触感、安全区/键盘、Liquid Glass），聊天和所有业务
页面继续由 `web/` 的 React 前端渲染。普通浏览器和 PWA 的行为不变。

方案背景见 `docs/frontend-ios-plan-2026-10/03-ios-native.md`；执行记录与对方案的偏离见
`docs/frontend-ios-plan-2026-10/07-execution-log.md`。

- 最低 iOS 17；iOS 26+ 的 TabBar 使用 Liquid Glass（`glassEffect`），更早系统用材质背景。
- 第一版仅 iPhone（`TARGETED_DEVICE_FAMILY = 1`），不做 iPad 布局。
- 文案只有中文，集中在 `HappyClaw/Support/L10n.swift` + `Localizable.xcstrings`。

## 目录

```text
ios/
├── HappyClaw.xcodeproj         工程（objectVersion 77，HappyClaw/ 为同步文件夹，新增文件无需改工程）
├── Config/
│   ├── Shared.xcconfig         版本号、默认 bundle id、签名方式
│   ├── Local.xcconfig.example  个人签名模板 → 复制为 Local.xcconfig（已 gitignore）
│   └── Info.plist              ATS / 本地网络 / 相机相册说明（与生成的 Info.plist 合并）
├── HappyClaw/                  App（SwiftUI，默认 MainActor 隔离，Swift 6）
│   ├── App.swift               入口
│   ├── RootShell.swift         NavigationStack + 全屏 WebView + 导航栏 + 浮动 TabBar + 恢复页
│   ├── NativeNavBar.swift      原生导航栏（标题、返回、一个右侧按钮，由 Web 声明）
│   ├── ShellModel.swift        WebView、桥接状态机与 SwiftUI chrome 的粘合层
│   ├── NativeTabBar.swift      原生底部 Tab（由 Web 声明）
│   ├── WebHostView.swift       WKWebView：持久数据存储、cookie 同步、导航代理、外链、JS 对话框
│   ├── DownloadHost.swift      网页下载（blob: / 附件）→ 临时文件 → 系统分享面板
│   ├── ConnectView.swift       服务器地址
│   ├── Bridge/
│   │   ├── BridgeChannel.swift 注入脚本 + 收发（只接受本实例顶层 frame）
│   │   ├── LayoutBridge.swift  安全区/TabBar/键盘 → layout.update（去重）
│   │   ├── SheetHost.swift     原生 Sheet（medium/large + grabber），MVP 承载「更多」
│   │   ├── MenuBridge.swift    原生操作菜单
│   │   └── ConfirmBridge.swift 原生确认框
│   ├── Recovery/               恢复页、诊断页
│   ├── Support/                文案、触感、地址存储
│   └── Resources/              Assets（图标取自 web/public/icons/logo-1024.png）
├── HappyClawCore/              纯 Swift 包：协议编解码、握手状态机、地址/外链策略、布局计算
│   └── Tests/                  `swift test`，无需模拟器
└── scripts/install-device.sh   构建并装到已连接的 iPhone（也用于 7 天续签）
```

Web 侧对应模块在 `web/src/native/`（`protocol.ts`、`session.ts`、`layout.ts`、
`navigation.ts`、`nav-bar.ts`、`bridge.ts`、`install.ts`）。

## 架构

```text
┌──────────── SwiftUI 原生壳 ────────────┐
│ NavigationStack（根：Web；推入：服务器地址、诊断）│
│ ┌──────── WKWebView（全屏）────────┐ │
│ │  React 前端（路由、聊天、业务）     │ │      REST / WS
│ │  web/src/native/* 桥接客户端  ◀────┼─┼──────────────▶ HappyClaw Server
│ └───────────────▲──────────────────┘ │
│   NativeTabBar  │ postMessage / callAsyncJavaScript
│   Sheet / 菜单 / 确认框 / 触感          │
└───────────────────────────────────────┘
```

- **单一 WebView**：所有 Tab 共用一个 WKWebView，避免多份 store、多条 WS 连接和状态分叉。
  原生 Tab 点击只发 `nav.select`，由 Web 的 react-router 跳转。
- **职责边界**：Web 拥有路由、数据、权限过滤和业务动作；原生只渲染 Web 的「声明」并回传
  「结果」。Tab 列表来自 Web 的导航元数据（`web/src/components/layout/nav-items.ts` 的
  `native` 字段），计费开关等过滤在 Web 侧完成。
- **布局**：WebView 铺满屏幕（含状态栏和 Home 指示条区域），所以 Web 已有的
  `env(safe-area-inset-*)` 含义与 Safari/PWA 完全一致。原生只额外报告浮动 TabBar 覆盖的
  高度：`--native-bottom`。`globals.css` 只在 `html[data-native-chrome="active"]` 下隐藏
  Web 底部胶囊导航，并把 `--mobile-nav-reserve` / `--mobile-nav-clearance` 切到原生高度。
- **导航栏**：每次 `route.changed` 带一份 `nav` 声明（是否显示、标题、返回、一个右侧按钮）。
  - 默认规则在 `navigation.ts`：Tab 与「更多」页面显示标题；`/users`、`/monitor` 是推入页，带返回
    （没有历史时回到 `/settings`）；工作台列表和打开的会话保留 Web 自己的页头，不显示原生栏。
  - 页内下钻（新建智能体面板、记忆详情）用 `useNativeNavBar({ title, onBack, action })` 覆盖；
    原生返回 / 右侧按钮回到 Web 执行（`nav.back` / `nav.action`），业务逻辑不进原生。
  - 原生栏上报 `--native-top`（屏幕顶到栏底，含状态栏），Web 据此给根布局留白并设
    `data-native-nav="visible"`，隐藏标了 `data-native-title` / `data-native-replaced` 的
    Web 标题、返回按钮和移动端页头；浏览器里这些标记不生效。
  - 栏底色取 Web 的 `--background`（`theme.changed.background`），键盘把整页推上去时内容
    被遮住而不是叠在标题上。
  - Web 打开 Dialog / Sheet / AlertDialog 时 `route.changed.modal=true`，原生暂时隐藏导航栏和
    TabBar，但继续上报原来的 inset，避免弹窗背后的页面跳动。
- **识别容器**：注入脚本在顶层 frame 定义只读的 `window.HappyClawNative`。Web 只靠它
  判断是否在 App 内，不看 UA。浏览器里该对象不存在，桥接代码（独立 chunk）根本不会下载。
- **失败策略**：
  - 握手超时（旧前端、非 HappyClaw 页面）→ **fail open**：保持纯 Web chrome，App 仍完整可用。
  - 协议版本不兼容 → 原生恢复页（不进入半原生状态）。
  - 加载失败 / 服务器不可达 → 原生恢复页（重试 / 修改地址），不白屏。
  - Web 内容进程被系统杀掉 → 自动重载；1 分钟内 3 次则进恢复页。
- **外链**：本实例同源（含 base path）的导航留在 WebView；其他 http(s) 顶层导航、
  `target=_blank` 和 `mailto:`/`tel:` 交给系统；未知 scheme（如 `javascript:`）丢弃。
  iframe 中的第三方内容保持内嵌。
- **下载**：WKWebView 默认会静默丢弃 `<a download>`（Web 的 `utils/download.ts` 统一走
  blob: URL）和附件响应。壳把它们转成 `WKDownload`，存到临时目录后弹出系统分享面板
  （存到「文件」/「照片」、隔空投送、用其他 App 打开），面板关闭后删除临时文件；Web 不需要改。
- **JS 对话框**：实现了 `alert/confirm/prompt` 的 WKUIDelegate。否则 WKWebView 里
  `confirm()` 会静默返回 false，Web 的「未保存离开」守卫会失效。
- **登录**：`WKWebsiteDataStore.default()` 持久化 cookie；401 由 Web 跳登录页，原生不拦截。
  页面加载完成后把本实例 cookie 同步进 `HTTPCookieStorage.shared`，供以后原生请求
  （Widget 快照、推送注册）复用。

## 桥接协议 v1

Swift：`HappyClawCore/Sources/HappyClawCore/BridgeProtocol.swift`；
TS：`web/src/native/protocol.ts`。两边必须同时修改。

### 信封

```json
{ "v": 1, "type": "route.changed", "id": "w3", "payload": {} }
```

- `v`：协议版本。`bridge.hello` 携带 Web 最高版本；之后双方都用协商结果。
- `id`：仅请求/响应使用（`confirm.request` ↔ `confirm.result`，`menu.request` ↔
  `menu.result`；Web 发起的请求 id 形如 `w1`）。
- 传输：Web → 原生用 `webkit.messageHandlers.happyclaw.postMessage(envelope)`；
  原生 → Web 用 `callAsyncJavaScript` 调 `window.__happyclawNativeReceive(envelope)`，
  数据以参数传入，不拼接字符串。
- 原生只接受**顶层 frame**、且来源属于当前服务器地址的消息。

### 握手与状态机

```text
Web                                   原生（BridgeSession）
                                      didCommit → negotiating（启动 10s 计时）
bridge.hello {versions:[1], ...} ──▶  协商版本
                                      ├ 无共同版本 → bridge.reject，进入 recovery
                ◀── bridge.welcome {session, version, capabilities, shell}
                ◀── layout.update（立即发送一次）   状态：prepared
收到首个 layout → 设置 CSS 变量 +
data-native-chrome="active"（隐藏 Web 底栏）
chrome.tabs / route.changed / theme.changed ──▶ 记录声明
bridge.ready {session} ──────────────▶ nativeNavigation：显示原生 TabBar
```

- Web 收到 welcome 但还没收到 layout 时不切换 chrome，避免内容跳动。
- 原生在 `bridge.ready` 之前不显示 TabBar，所以任何时刻都不会出现双层底栏。
- 双方各有超时（Web 4s 等 welcome，原生 10s 等 hello/ready），超时都回到纯 Web chrome。
- 每次主框架提交新文档（刷新、换地址）都会作废旧 session，重新握手。

### 消息（Web → 原生）

| type              | payload                                                                      | 说明                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bridge.hello`    | `versions[]`, `capabilities[]`, `client.build`                               | 任意 `v` 都接受，以便回复 reject                                                                                        |
| `bridge.ready`    | `session`                                                                    | Web 已提交原生布局                                                                                                      |
| `chrome.tabs`     | `tabs[]`, `more[]`（`id/title/symbol/path`）                                 | `symbol` 为 SF Symbol；计费等过滤已在 Web 完成                                                                          |
| `route.changed`   | `path`, `title`, `tabId`, `canGoBack`, `tabBar`, `nav?`, `modal?`            | `tabBar=false`：打开的会话、登录/初始化页；`nav`：`visible/title/back/action{id,title,symbol}`；`modal`：Web 弹窗打开中 |
| `theme.changed`   | `scheme: light/dark`, `background?`（`#rrggbb`）                             | 原生 chrome 跟随 Web 主题和底色                                                                                         |
| `confirm.request` | `title`, `message`, `confirmText`, `cancelText`, `destructive`               | 来自 `confirmDialog()`                                                                                                  |
| `menu.request`    | `title?`, `message?`, `items[]`（`id/title/symbol?/destructive?/disabled?`） | 原生操作菜单                                                                                                            |
| `haptic`          | `style: light/medium/success/warning/error`                                  | 来自 `useHaptic`                                                                                                        |
| `bridge.error`    | `code`, `message`, `ref?`                                                    | Web 无法处理原生消息时回报                                                                                              |

### 消息（原生 → Web）

| type             | payload                                         | 说明                                                              |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `bridge.welcome` | `session`, `version`, `capabilities[]`, `shell` |                                                                   |
| `bridge.reject`  | `code`, `message`, `supported[]`                | 原生随即显示恢复页                                                |
| `layout.update`  | `contentInsets`, `safeArea`, `keyboard`         | → `--native-top/right/bottom/left`、`--native-keyboard-occlusion` |
| `nav.select`     | `tabId`                                         | 原生 Tab / 「更多」项被点击                                       |
| `nav.back`       | `{}`                                            | 原生返回按钮：页内覆盖的 `onBack` → 历史后退 → 推入页的父路由     |
| `nav.action`     | `id`                                            | 导航栏右侧按钮被点击                                              |
| `confirm.result` | `confirmed`                                     | 带请求 `id`                                                       |
| `menu.result`    | `selected: string \| null`                      | `null` 为取消                                                     |
| `app.lifecycle`  | `state: active/inactive/background`             | 预留给 Phase 4 回前台重连                                         |
| `bridge.error`   | `code`, `message`, `ref?`                       | 带 `ref` 时 Web 把对应请求按取消处理                              |

错误码：`invalid_message`、`unsupported_type`、`version_unsupported`、`not_ready`、`busy`、
`cancelled`。

### 错误恢复约定

- 解析失败的消息不会抛异常：对方回 `bridge.error`（带原请求 `id` 作为 `ref`）。
- Web 的请求在桥接未激活、原生回错或超时（默认 120s）时都 resolve 为 `null`；
  `confirmDialog()` 视为「取消」，绝不默认确认。
- 新的确认/菜单请求会以「取消」结束上一个未完成的请求（与 Web 确认框语义一致）。
- 新文档提交或进入恢复页时，未完成的原生对话框直接丢弃。

### 版本演进

- 新增可选字段：不升版本，旧端忽略未知字段（Swift `Codable` 默认如此）。`nav`、`modal`、
  `background` 和 `navbar` 能力都是这样加进 v1 的：旧前端不发 `nav`，原生就不显示导航栏。
- 新增消息类型：对端回 `unsupported_type`，发送方应按能力（`capabilities`）判断后再发。
- 破坏性修改：升 `v`。原生的 `supportedVersions` 与 Web 的 `SUPPORTED_PROTOCOL_VERSIONS`
  以区间重叠协商；没有交集时原生显示恢复页，提示更新前端或 App。

## 本地构建

需要 Xcode 26+（本机验证：Xcode 27.1 / iOS SDK 27.1）。不需要 CocoaPods、xcodegen。

```bash
# 1. 核心包单测（macOS 本机，无需模拟器）
cd ios/HappyClawCore && swift test

# 2. 模拟器编译（不签名）
cd ios
xcodebuild -project HappyClaw.xcodeproj -scheme HappyClaw \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build

# 3. 真机构建（自动签名，需要先配置 Config/Local.xcconfig）
xcodebuild -project HappyClaw.xcodeproj -scheme HappyClaw -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  -allowProvisioningUpdates build
```

Web 侧：

```bash
npm --prefix web run dev -- --port 5173   # 前端（代理到 3000 端口的后端）
npm run dev                               # 后端
npx vitest run web/src/native             # 桥接单测
```

### 在模拟器里跑

模拟器与 Mac 共享网络，可以直接连 `localhost`。启动环境变量 `HAPPYCLAW_SERVER_URL`
会覆盖已保存的地址：

```bash
SIM=<模拟器 UDID>     # xcrun simctl list devices available
xcrun simctl boot $SIM
xcrun simctl install $SIM build/DerivedData/Build/Products/Debug-iphonesimulator/HappyClaw.app
SIMCTL_CHILD_HAPPYCLAW_SERVER_URL=http://localhost:5173 \
  xcrun simctl launch $SIM "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  build/DerivedData/Build/Products/Debug-iphonesimulator/HappyClaw.app/Info.plist)"
```

Debug 构建的 WebView 可以用 Safari「开发」菜单远程检查（`isInspectable`）。

## 用自己的开发者证书装到 iPhone

### 一次性准备

1. **签名配置**：复制 `Config/Local.xcconfig.example` 为 `Config/Local.xcconfig`，填写：
   - `DEVELOPMENT_TEAM`：证书里的 Team ID（OU 字段）：
     ```bash
     security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
     ```
   - `HAPPYCLAW_BUNDLE_ID`：全局唯一，例如 `com.<你的名字>.happyclaw`。
     该文件已 gitignore，团队信息和证书不进仓库。
2. **Xcode 账号**：Xcode → Settings → Accounts 已登录对应 Apple ID（自动签名要用它生成
   描述文件）。
3. **连接 iPhone**：数据线连接、解锁，点「信任这台电脑」。
4. **开发者模式**：iPhone「设置 → 隐私与安全性 → 开发者模式」打开，重启并确认。
5. 确认 Mac 能看到手机，状态不是 `unavailable`：
   ```bash
   xcrun devicectl list devices
   ```
   首次用数据线配对成功后，同一 Wi-Fi 下可以无线安装。

### 安装

```bash
ios/scripts/install-device.sh            # 自动选第一台可用的 iPhone（忽略模拟器）
ios/scripts/install-device.sh <UDID>     # 指定设备
```

脚本会构建、签名，用 `xcrun devicectl device install app` 安装并启动，同时打印描述文件
到期时间。也可以在 Xcode 里选中自己的 iPhone 直接 ⌘R。

首次打开如果提示「未受信任的开发者」：「设置 → 通用 → VPN 与设备管理」里信任自己的
开发者证书。

### 连接服务器

首次启动会显示「连接服务器」。手机访问 Mac 上的开发服务器时：

- 填 `http://<Mac 局域网 IP>:5173`（`ipconfig getifaddr en0`），手机和 Mac 在同一局域网；
- 首次访问局域网时 iOS 会请求「本地网络」权限，必须允许；
- 正式使用请填部署好的 HTTPS 域名。之后可在「更多 → 服务器地址」修改。

## 签名有效期与续签

| 账号类型                               | 描述文件有效期                         | 到期表现           | 续签                                                    |
| -------------------------------------- | -------------------------------------- | ------------------ | ------------------------------------------------------- |
| 免费 Apple ID（Personal Team）         | **7 天**                               | App 闪退、无法打开 | 重新运行 `ios/scripts/install-device.sh`（或 Xcode ⌘R） |
| 付费 Apple Developer Program（$99/年） | 开发描述文件 **1 年**（证书同样 1 年） | 同上               | 到期前重新构建安装；证书过期需在 Xcode 里重新生成       |

- 本机当前是**免费 Personal Team**（描述文件 TeamName 为个人姓名、7 天到期），
  `install-device.sh` 每次都会打印到期时间。
- 覆盖安装不会丢数据：登录 cookie 和服务器地址保存在 App 沙盒里，重装同一 bundle id 时保留；
  卸载后才会清空。
- 免费账号限制：每台设备最多 3 个自签 App；每 7 天最多注册 10 个 App ID。**不支持推送
  （APNs）和 App Groups**，所以原生推送和 Widget 需要付费账号；本轮推送先走 Web Push（PWA）。
- 想减少手动续签：可以把未签名产物交给 SideStore/AltStore 自动续签，这一轮还没做未签名
  IPA 打包脚本（见执行记录的下一步）。

## 许可

架构思路参考了 MoviePilot-App（GPL-3.0-only）：单 WebView + 版本化桥接、注入只读宿主对象、
纯 Swift 核心包可独立测试、握手失败显示原生恢复页。本目录代码全部独立编写，没有复制
MoviePilot-App 的源码、资源或依赖。
