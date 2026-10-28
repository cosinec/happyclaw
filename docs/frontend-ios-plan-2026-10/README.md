# HappyClaw 前端 + iOS 原生质感 方案

- 版本：v0.1（供 review）
- 日期：2026-10-28
- 作者：家居（基于 `web/` 代码 review 和 MoviePilot-Frontend / MoviePilot-App 对照）
- 状态：**草案，未开始改代码**

## 一句话结论

先把 Web/PWA 的体验和工程底子补齐，再做一个 **SwiftUI 原生壳 + WKWebView + 桥接协议** 的 iOS App；原生只接管导航、TabBar、Sheet、菜单、推送、Widget，聊天和业务页面继续用现有 React 前端。不全原生重写、不引入 Vue/Vuetify、不做大爆炸重构。

## 目录

| 文件 | 内容 |
|---|---|
| `README.md` | 总览、结论、review 方式 |
| `00-executive-summary.md` | 目标、范围、时间线、成功指标、非目标 |
| `01-review-findings.md` | 之前 review 出来的问题清单（含证据、影响、处理、Phase） |
| `02-roadmap.md` | Phase 0–5 的任务、交付物、验收标准、工期 |
| `03-ios-native.md` | iOS 原生质感架构、桥接协议、组件清单、推送/Widget/签名 |
| `04-engineering-governance.md` | 结构重构、测试/CI、发布回滚、可观测性 |
| `05-decisions-risks.md` | 需要拍板的决策、风险登记、review 问题清单 |
| `06-file-map.md` | 两个仓库的关键文件地图，方便 review 时对照 |

## 范围

**包含**
- `web/`（React 19 + Vite + Tailwind + Radix + Zustand）的体验与工程改造
- PWA（安装、Web Push、离线/更新提示）
- iOS 原生壳（SwiftUI + WKWebView + 桥接协议）
- 必要的后端配合（搜索 API、通知事件、Push 订阅/APNs、Widget 快照）

**不包含**
- 重写聊天 UI（Web 聊天已经很强）
- 引入 Vue/Vuetify 或双框架
- 公司/第三方系统集成
- App Store 上架（个人自签优先，后续再评估）

## 需要拍板的 3 个决策

1. **iOS 分发**：个人自签（SideStore/AltStore，7 天续签）还是以后上 App Store？
2. **推送**：先做 Web Push（PWA，改动小）还是直接 APNs（原生，体验好）？
3. **i18n**：只做中文，还是这轮就做中英双语？

## 怎么 review

建议按这个顺序看：

1. `01-review-findings.md`：确认问题清单是否完整、优先级是否认同
2. `02-roadmap.md`：确认 Phase 顺序、工期、验收标准
3. `03-ios-native.md`：确认原生壳的边界（只做 chrome，不做业务重写）
4. `05-decisions-risks.md`：拍板 3 个决策、看风险是否还有遗漏

重点想请 reviewer 挑战：

- 是不是应该先做 Phase 1（搜索/通知）而不是 Phase 0（治理）？
- iOS 壳的 MVP 是否还可以再砍？哪些原生组件其实可以不做？
- Phase 2 的 `chat.ts` 拆分风险是否被低估？
- 推送选 Web Push 还是 APNs？后端成本是否算清？
- 有没有漏掉的安全/隐私/多用户权限问题？

## 现状快照

- HappyClaw Web：`web/`，React 19 / Vite 6 / TS strict / Tailwind 4 / Radix / Zustand / react-router 7 / cmdk / sonner / @tanstack/react-virtual
- MoviePilot-Frontend：`MoviePilot-Frontend`（v3.2.2，Vue 3.5 + Vuetify 3.7 + Pinia）
- MoviePilot-App：`MoviePilot-App`（SwiftUI/UIKit 原生壳 + WKWebView，GPL-3.0）
- 参考文档：`MoviePilot-App/integration/README.md`、`MoviePilot-App/README.md`
