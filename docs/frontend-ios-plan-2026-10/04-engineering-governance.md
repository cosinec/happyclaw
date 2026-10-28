# 工程治理与重构

## 目标

让 `web/` 从“能跑”变成“可持续改”：

- 单文件可读、可测
- 服务端状态有统一层
- 导航/权限/文案只有一个来源
- 每次改动有 CI 门禁
- 线上问题可观测、可回滚

## 目标结构

```
web/src/
  pages/                 # 路由壳：只做权限/布局/懒加载
  views/                 # 领域 UI
    chat/
      ChatView.tsx
      ChatHeader.tsx
      SessionTabs.tsx
      Composer/
      MessageList/
      MessageBubble/
      ContextPanel/
    tasks/
    usage/
    billing/
    settings/
    capabilities/
  components/
    ui/                  # 基础原语（现有）
    common/              # AsyncState/DataTable/PageHeader...
    chat/                # 跨领域聊天展示件（可选）
  features/              # 领域逻辑（store 切片、hooks、API 适配）
    chat/
    tasks/
    ...
  stores/                # UI/会话状态（Zustand）
  api/                   # client/ws + query 层
  lib/                   # 纯工具、navigation、shortcuts
  native/                # iOS 桥接（Phase 3）
```

原则：

- `pages/` 不写业务，只组合
- `views/` 可以大，但单文件目标 < 800 行
- `features/` 放可测试的纯逻辑/hooks
- `components/ui` 不放业务
- 跨页面复用的东西才进 `common/`

## 重构策略

**1. 先测后搬**
- 给要搬的模块补行为测试（Vitest + Testing Library）
- 测试覆盖用户可见行为，不测实现细节
- 先加“characterization tests”，再搬代码

**2. Strangler（绞杀者）模式**
- 新组件先与旧组件并存，用 feature flag 切换
- 一次只搬一个模块；PR 控制在可 review 的规模
- 旧实现保留一个版本周期，确认无回归再删

**3. 不做大爆炸**
- 禁止一次性重写 `chat.ts`
- 按域切片：groups → sessions → messages → streaming → drafts → usage
- 每切一片，跑聊天回归 + 部署验证

**4. 迁移清单（每个模块）**
- [ ] 列出对外 API/被引用点
- [ ] 补行为测试
- [ ] 新建模块并迁移
- [ ] 旧模块改为 re-export 或删除
- [ ] 跑单测/E2E/手工回归
- [ ] 部署 Mac mini 验证
- [ ] 记录 ADR/变更说明

## Server-state 层

**问题**：现在每个 store/page 手写 loading/error/retry/cache/race。

**方案**：引入 TanStack Query（推荐）或轻量 query cache。

- 服务端数据（列表/详情/统计）走 query
- Zustand 只保留：
  - UI 状态（侧栏、主题、面板）
  - 会话/流式状态（需要细粒度订阅）
  - 本地草稿
- 统一：
  - `staleTime`/`gcTime`
  - 取消/竞态
  - 错误归一化（复用 `api/client.ts` 的 `ApiError`）
  - 乐观更新（任务开关、已读）
- 迁移顺序：Tasks → Users → Usage → Billing → 其余

**注意**
- 聊天流式不要塞进 query cache；继续用 Zustand/WS
- 先迁 2–3 个页面验证，再推广

## 单一导航元数据

新建 `web/src/lib/navigation.ts`：

```ts
type NavItem = {
  id: string
  path: string
  label: string
  icon: LucideIcon
  permission?: string
  mobile?: 'tab' | 'more' | 'hidden'
  group: 'main' | 'system'
}
```

派生：
- 侧栏 `nav-items.ts`
- 设置 `SettingsNav.tsx`
- 命令面板 `command-items.ts`
- 面包屑/页面标题

验收：新增页面只改一处；权限/图标/文案不会三处不一致。

## 设计系统

- 继续用 `styles/globals.css` 的语义 tokens（surface/foreground/border/success/warning/error）
- 新增组件必须用 tokens，不写死颜色
- 角色字号 `text-micro`…`text-display`
- 组件变体用 `cva` + `cn`
- 禁止在业务组件里引入新的 UI 库

## 图表

抽 `components/charts/primitives`：

- `ChartFrame`（尺寸/响应式/空态/加载）
- `Axis`、`Grid`、`Tooltip`、`Legend`
- `useChartScale`
- 颜色来自 `--chart-*` tokens

迁移：Usage → Billing → Monitor。统一交互：hover、键盘、空数据、暗色。

## DataTable

统一 `components/common/DataTable.tsx`：

- 列定义（accessor/header/cell/sortable/width）
- 排序、分页、吸顶、行选择、密度、列显隐
- 桌面表格 / 移动卡片双呈现
- 空态/加载/错误用 `AsyncState`
- 可选用 TanStack Table，或自研轻量版（避免大依赖）

## 可访问性（A11y）

- 所有交互控件可键盘到达；焦点可见
- Dialog/Sheet 焦点陷阱 + Esc 关闭 + 返回焦点
- Toast/通知用 `aria-live="polite"`/`role="status"`
- 图标按钮必须有 `aria-label`
- 表单 label 关联、错误 `aria-describedby`
- CI 加 axe 冒烟（登录、聊天、任务、设置）
- 目标：axe 无 critical；核心流程纯键盘可完成

## 测试策略

**单元/组件（Vitest + Testing Library）**
- 纯逻辑/hooks 优先
- 组件测用户行为，不测 className
- 新增模块要求覆盖核心分支

**E2E（Playwright）**
- 项目：Chromium 桌面（1440）、Chromium 移动（Pixel 7）、WebKit（后续）
- 冒烟：登录、聊天发送/流式、文件预览、任务创建、设置保存、搜索、通知
- native 模式模拟：设置 `data-native-chrome` + `--native-*`，验证无双层导航

**CI 门禁**
- `lint` + `format:check` + `typecheck` + `test` + `build`
- E2E 在合并前跑关键集；夜间跑全量
- 覆盖率阈值（先 60%，逐步到 80%）

**手工回归**
- 聊天：长会话、流式、停止、追问、图片、文件
- 移动端：键盘、Sheet、返回、安全区
- 原生壳（Phase 3+）：登录、Tab、Sheet、分享、选图、后台恢复

## 性能预算

- 首屏 JS：不显著增长（新增依赖需评估）
- 路由 chunk：单 chunk < 300KB gzip（目标）
- 聊天滚动：60fps（长会话）
- 搜索：P95 < 300ms（本地规模）
- 日志：600 行滚动不卡
- 部署后检查 Web Vitals（LCP/INP/CLS）

## 可观测性

- 前端 ErrorBoundary 上报（本地日志或后端接口）
- WS 连接状态/重连次数在设置页可见
- 构建版本号显示在设置页/关于
- 部署后对比错误率、白屏率、WS 断连率

## 发布与回滚

- 构建产物带版本号；`index.html` 保持 `no-cache`，assets `immutable`
- 部署后旧页提示更新（Phase 0）
- 回滚：保留上一版产物/代码 tag；出问题直接切回
- 不创建数据库备份（按 owner 策略）；回滚只回代码/前端产物
- 每次部署记录：版本、时间、变更、验证结果

## 文档与 ADR

- 每个 Phase 的关键决策写 ADR（架构决策记录）
- `README`/`CLAUDE.md` 更新目录结构和约定
- 桥接协议单独文档（`03-ios-native.md`），版本变更记录
- 新同学/其他 Agent 能按文档独立跑起来

## Definition of Done（每个功能）

- [ ] 行为符合验收标准
- [ ] 单测/组件测试覆盖核心分支
- [ ] E2E/手工回归通过
- [ ] 无新增 axe critical
- [ ] lint/typecheck/build 绿
- [ ] 部署到 Mac mini 并验证
- [ ] 文档/变更说明更新
- [ ] 可回滚
