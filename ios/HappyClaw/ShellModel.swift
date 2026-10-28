import HappyClawCore
import Observation
import OSLog
import SwiftUI

/// Pushed onto the root NavigationStack. Web content is the stack's root;
/// shell-owned screens (server address, diagnostics) push natively.
enum ShellRoute: Hashable {
  case serverSettings
  case diagnostics
}

/// Glue between the web view, the pure BridgeSession state machine and the
/// SwiftUI chrome. Everything here runs on the main actor.
@Observable
final class ShellModel {
  private(set) var server: ServerAddress?
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
  private(set) var webBuild: String?
  private(set) var lastError: String?

  var path: [ShellRoute] = []
  var sheet: ShellSheet?
  var downloadError: String?
  /// The file behind an open share sheet; deleted when the sheet closes.
  @ObservationIgnored private var sharedFile: URL?

  let layout = LayoutBridge()
  let confirm = ConfirmBridge()
  let menu = MenuBridge()
  @ObservationIgnored let web = WebController()
  @ObservationIgnored private var handshakeTimer: Task<Void, Never>?

  private static let handshakeTimeout: Duration = .seconds(10)
  private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "HappyClaw", category: "bridge")

  init() {
    web.channel.onMessage = { [weak self] result in self?.receive(result) }
    web.onDocumentCommitted = { [weak self] in self?.documentCommitted() }
    web.onLoadFailed = { [weak self] message in self?.loadFailed(message) }
    web.onContentProcessLost = { [weak self] in
      guard let self else { return }
      self.discardRequests()
      self.apply(self.session.contentProcessLost())
    }
    DownloadHost.purge()
    web.downloads.onFinished = { [weak self] file in
      guard let self else { return }
      Haptics.play(.success)
      if let previous = self.sharedFile { DownloadHost.remove(previous) }
      self.sharedFile = file
      self.sheet = .share(file)
    }
    web.downloads.onFailed = { [weak self] message in
      Haptics.play(.error)
      self?.downloadError = message
    }
    confirm.respond = { [weak self] id, confirmed in self?.send(.confirmResult(id: id, confirmed: confirmed)) }
    menu.respond = { [weak self] id, selected in self?.send(.menuResult(id: id, selected: selected)) }

    if let saved = ServerStore.load() { connect(to: saved, persist: false) }
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

  var recoveryReason: BridgeSession.RecoveryReason? {
    if case let .recovery(reason) = session.state { return reason }
    return nil
  }

  // MARK: User intents

  func connect(to address: ServerAddress, persist: Bool = true) {
    if persist { ServerStore.save(address) }
    server = address
    path.removeAll()
    resetDeclarations()
    apply(session.retry())
    web.load(address)
  }

  func retry() {
    apply(session.retry())
    lastError = nil
    web.reload()
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
    discardRequests()
    resetDeclarations()
    layout.reset()
    apply(session.documentCommitted())
  }

  private func loadFailed(_ message: String) {
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
    case let .hello(versions, _, build):
      webBuild = build
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
    case let .tabs(tabs, more):
      self.tabs = tabs
      self.more = more
    case let .routeChanged(state):
      route = state
      layoutChanged()
    case let .themeChanged(scheme, background):
      webScheme = scheme
      webBackground = background
    case let .confirmRequest(id, request):
      confirm.present(id: id, request)
    case let .menuRequest(id, request):
      menu.present(id: id, request)
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
  }

  private func resetDeclarations() {
    tabs = []
    more = []
    route = nil
  }
}
