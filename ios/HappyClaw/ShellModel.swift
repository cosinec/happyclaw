import HappyClawCore
import Observation
import OSLog
import SwiftUI

/// Pushed onto the root NavigationStack. Web content is the stack's root;
/// shell-owned screens (servers, diagnostics) push natively.
enum ShellRoute: Hashable {
  case serverSettings
  case addServer
  case diagnostics
}

/// Glue between the web view, the pure BridgeSession state machine and the
/// SwiftUI chrome. Everything here runs on the main actor.
@Observable
final class ShellModel {
  private(set) var registry: ServerRegistry
  var server: ServerAddress? { registry.active?.address }
  private(set) var session = BridgeSession() {
    didSet {
      if session.state != oldValue.state { Self.log.notice("bridge state → \(String(describing: self.session.state), privacy: .public)") }
    }
  }

  // Declarations from the web (already permission-filtered there).
  private(set) var tabs: [TabDeclaration] = []
  private(set) var more: [TabDeclaration] = []
  private(set) var route: RouteState?
  private(set) var webScheme: ColorSchemeName?
  /// Page background, so the navigation bar matches whatever palette is on.
  private(set) var webBackground: RGBColor?
  /// Palette accent, tints the system tab bar's selection.
  private(set) var webAccent: RGBColor?
  private(set) var webBuild: String?
  /// What the web said it handles in bridge.hello.
  private(set) var webCapabilities: Set<String> = []
  private(set) var lastError: String?

  var path: [ShellRoute] = []
  var sheet: ShellSheet?
  var downloadError: String?
  /// The file behind an open share sheet; deleted when the sheet closes.
  @ObservationIgnored private var sharedFile: URL?

  let layout = LayoutBridge()
  let confirm = ConfirmBridge()
  let menu = MenuBridge()
  /// Replaced when the active server changes (its data store differs).
  private(set) var web: WebController
  @ObservationIgnored private var handshakeTimer: Task<Void, Never>?
  @ObservationIgnored private var loadTimer: Task<Void, Never>?
  /// A top-level load has run long enough to show 「正在连接…」.
  private(set) var isConnecting = false

  private static let handshakeTimeout: Duration = .seconds(10)
  /// Below this a load finishes without any indicator flashing.
  private static let connectingDelay: Duration = .milliseconds(600)
  /// An unreachable LAN address can hang for a minute before the network
  /// stack gives up; the recovery page is more useful long before that.
  private static let loadTimeout: Duration = .seconds(15)
  private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "HappyClaw", category: "bridge")

  init() {
    let registry = ServerStore.load()
    self.registry = registry
    web = WebController(dataStore: registry.active?.dataStore ?? .shared)
    DownloadHost.purge()
    confirm.respond = { [weak self] id, confirmed in self?.send(.confirmResult(id: id, confirmed: confirmed)) }
    menu.respond = { [weak self] id, selected in self?.send(.menuResult(id: id, selected: selected)) }
    wire(web)
    if let active = registry.active { show(active) }
  }

  private func wire(_ web: WebController) {
    web.channel.onMessage = { [weak self] result in self?.receive(result) }
    web.onDocumentCommitted = { [weak self] in self?.documentCommitted() }
    web.onLoadFailed = { [weak self] message in self?.loadFailed(message) }
    web.onContentProcessLost = { [weak self] in
      guard let self else { return }
      self.discardRequests()
      self.apply(self.session.contentProcessLost())
    }
    web.downloads.onFinished = { [weak self] file in
      guard let self else { return }
      Haptics.play(.success)
      if let previous = self.sharedFile { DownloadHost.remove(previous) }
      self.sharedFile = file
      self.sheet = .share(file)
    }
    web.anchoredMenu.respond = { [weak self] id, selected in
      self?.send(.menuResult(id: id, selected: selected))
    }
    web.contextMenu.onSelect = { [weak self] token, itemId in
      self?.send(.contextMenuResult(token: token, selected: itemId))
    }
    web.downloads.onFailed = { [weak self] message in
      Haptics.play(.error)
      self?.downloadError = message
    }
  }

  // MARK: Derived chrome state

  var tabBarVisible: Bool {
    session.isNativeChromeActive && (route?.tabBar ?? false) && layout.keyboardHeight == 0
  }

  /// Declared by the web per screen; nil when hidden or before bridge.ready.
  var navBar: NavBarState? {
    guard session.isNativeChromeActive, let nav = route?.nav, nav.visible else { return nil }
    return nav
  }

  /// While a web dialog or sheet is open the bars step aside so they never
  /// cover it. Layout keeps the declared values: the page behind stays put.
  var webModalOpen: Bool { route?.modal ?? false }

  /// Highlighted bar slot: a primary tab id, or "more" for overflow pages.
  var selectedTabSlot: String? {
    guard let id = route?.tabId else { return nil }
    if tabs.contains(where: { $0.id == id }) { return id }
    if more.contains(where: { $0.id == id }) { return Self.moreSlot }
    return nil
  }

  static let moreSlot = "__more__"

  var isMoreSheetOpen: Bool {
    if case .more = sheet { return true }
    return false
  }

  var recoveryReason: BridgeSession.RecoveryReason? {
    if case let .recovery(reason) = session.state { return reason }
    return nil
  }

  // MARK: User intents

  /// First launch or 「添加服务器」: the address becomes the active server
  /// (an already saved one is reused, keeping its login).
  func connect(to address: ServerAddress) {
    show(registry.activate(address))
  }

  func switchServer(to id: UUID) {
    guard id != registry.activeID else {
      path.removeAll()
      return
    }
    registry.select(id)
    if let active = registry.active { show(active) }
  }

  /// Forgets an inactive server and deletes its web data on this device.
  func removeServer(_ id: UUID) {
    guard let removed = registry.remove(id) else { return }
    ServerStore.save(registry)
    AppearanceStore.remove(removed.id)
    Task { await WebController.deleteData(of: removed) }
  }

  private func show(_ instance: ServerInstance) {
    ServerStore.save(registry)
    if web.dataStore != instance.dataStore {
      discardRequests()
      web = WebController(dataStore: instance.dataStore)
      wire(web)
    }
    path.removeAll()
    sheet = nil
    resetDeclarations()
    layout.reset()
    let appearance = AppearanceStore.load(instance.id)
    webScheme = appearance?.scheme
    webBackground = appearance?.background
    webAccent = appearance?.accent
    web.setPlaceholder(appearance?.background)
    apply(session.retry())
    web.load(instance.address)
    beginLoad()
  }

  private func beginLoad() {
    loadTimer?.cancel()
    isConnecting = false
    loadTimer = Task { [weak self] in
      try? await Task.sleep(for: Self.connectingDelay)
      guard !Task.isCancelled, let self else { return }
      self.isConnecting = true
      try? await Task.sleep(for: Self.loadTimeout - Self.connectingDelay)
      guard !Task.isCancelled else { return }
      self.web.stopLoading()
      self.loadFailed(L10n.connectTimeout)
    }
  }

  private func endLoad() {
    loadTimer?.cancel()
    loadTimer = nil
    isConnecting = false
  }

  func retry() {
    apply(session.retry())
    lastError = nil
    web.reload()
    beginLoad()
  }

  func selectTab(_ tab: TabDeclaration) {
    Haptics.play(.light)
    send(.navSelect(tabId: tab.id))
  }

  func goBack() {
    Haptics.play(.light)
    send(.navBack)
  }

  func performNavAction(_ action: NavBarState.Action) {
    Haptics.play(.light)
    send(.navAction(id: action.id))
  }

  /// Runs a pending home-screen quick action once native chrome is active;
  /// until then (cold launch, web still loading) it stays in the inbox.
  func deliverQuickAction() {
    let inbox = QuickActionInbox.shared
    guard let action = inbox.pending, session.isNativeChromeActive else { return }
    inbox.pending = nil
    path.removeAll()
    sheet = nil
    switch action {
    case QuickAction.newConversation where webCapabilities.contains("shortcuts"):
      send(.appShortcut(id: action))
    case QuickAction.newConversation, QuickAction.tasks:
      // An older web without shortcut support still gets a sensible tab.
      let tab = action == QuickAction.tasks ? "tasks" : "chat"
      if tabs.contains(where: { $0.id == tab }) { send(.navSelect(tabId: tab)) }
    default:
      break
    }
  }

  func sheetDismissed() {
    guard let file = sharedFile else { return }
    // A new share may already be on screen; keep its file.
    if case .share(file) = sheet { return }
    DownloadHost.remove(file)
    sharedFile = nil
  }

  func openMore() {
    Haptics.play(.light)
    sheet = .more
  }

  func open(_ route: ShellRoute) {
    path.append(route)
  }

  func scenePhaseChanged(_ phase: ScenePhase) {
    let state: LifecycleState =
      switch phase {
      case .active: .active
      case .inactive: .inactive
      default: .background
      }
    send(.lifecycle(state))
  }

  /// Re-send layout when geometry, keyboard or tab bar visibility changed.
  func layoutChanged() {
    guard let version = session.version,
      let update = layout.pendingUpdate(tabBarVisible: tabBarVisible, navBarVisible: navBar != nil)
    else { return }
    web.channel.send(update, version: version)
  }

  // MARK: Bridge events

  private func documentCommitted() {
    endLoad()
    discardRequests()
    resetDeclarations()
    layout.reset()
    apply(session.documentCommitted())
  }

  private func loadFailed(_ message: String) {
    endLoad()
    lastError = message
    Self.log.error("load failed: \(message, privacy: .public)")
    discardRequests()
    apply(session.loadFailed(message))
  }

  private func receive(_ result: Result<DecodedWebMessage, BridgeDecodeError>) {
    let decoded: DecodedWebMessage
    switch result {
    case let .failure(error):
      lastError = "bridge: \(error)"
      Self.log.error("inbound message rejected: \(String(describing: error), privacy: .public)")
      send(.error(code: error.code, message: "\(error)", ref: error.ref))
      return
    case let .success(value):
      decoded = value
    }

    let message = decoded.message
    guard session.accepts(message) else {
      if case let .confirmRequest(id, _) = message {
        send(.error(code: .notReady, message: "native chrome inactive", ref: id))
      } else if case let .menuRequest(id, _) = message {
        send(.error(code: .notReady, message: "native chrome inactive", ref: id))
      }
      return
    }

    switch message {
    case let .hello(versions, capabilities, build):
      webBuild = build
      webCapabilities = Set(capabilities)
      apply(session.receiveHello(versions: versions, shell: ShellBuild.info))
      // The web commits native chrome on its first layout after welcome.
      if let version = session.version {
        web.channel.send(
          layout.pendingUpdate(tabBarVisible: tabBarVisible, navBarVisible: navBar != nil, force: true)!,
          version: version
        )
      }
    case let .ready(id):
      apply(session.receiveReady(session: id))
      layoutChanged()
      deliverQuickAction()
    case let .tabs(tabs, more):
      self.tabs = tabs
      self.more = more
    case let .routeChanged(state):
      route = state
      layoutChanged()
    case let .themeChanged(scheme, background, accent):
      webScheme = scheme
      webBackground = background
      webAccent = accent
      if let id = registry.activeID {
        AppearanceStore.save(.init(scheme: scheme, background: background, accent: accent), for: id)
      }
    case let .confirmRequest(id, request):
      confirm.present(id: id, request)
    case let .menuRequest(id, request):
      // From a web control: a system menu at that spot when possible.
      if !web.anchoredMenu.present(id: id, request) {
        menu.present(id: id, request)
      }
    case let .contextMenuOffer(offer):
      web.contextMenu.receive(offer)
    case let .haptic(style):
      Haptics.play(style)
    case let .error(code, text, _):
      lastError = "web: \(code) \(text)"
      Self.log.error("web reported \(code, privacy: .public): \(text, privacy: .public)")
    }
  }

  // MARK: Effects

  private func apply(_ effects: [BridgeSession.Effect]) {
    for effect in effects {
      switch effect {
      case let .send(message, version):
        web.channel.send(message, version: version)
      case .startHandshakeTimer:
        handshakeTimer?.cancel()
        handshakeTimer = Task { [weak self] in
          try? await Task.sleep(for: Self.handshakeTimeout)
          guard !Task.isCancelled, let self else { return }
          self.apply(self.session.handshakeTimedOut())
        }
      case .cancelHandshakeTimer:
        handshakeTimer?.cancel()
        handshakeTimer = nil
      }
    }
  }

  private func send(_ message: NativeMessage) {
    guard let version = session.version else { return }
    web.channel.send(message, version: version)
  }

  private func discardRequests() {
    confirm.discard()
    menu.discard()
    web.contextMenu.reset()
    web.anchoredMenu.discard()
  }

  private func resetDeclarations() {
    tabs = []
    more = []
    route = nil
  }
}
