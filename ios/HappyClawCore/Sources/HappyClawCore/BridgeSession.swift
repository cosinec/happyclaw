import Foundation

/// Handshake and chrome ownership for one web document.
///
///     webNavigation ─commit─▶ negotiating ─hello─▶ prepared ─ready─▶ nativeNavigation
///          ▲                       │ timeout          │ timeout
///          └───────────────────────┴──────────────────┘   (fail open: web chrome)
///     hello with no common version / load failure / process loss ─▶ recovery
///
/// Native chrome is only shown in `nativeNavigation`. Until the web confirms
/// with `bridge.ready` it keeps its own chrome, so the two never overlap.
/// Pure value type: the WebKit glue feeds events in and performs the effects.
public struct BridgeSession: Equatable, Sendable {
  public enum RecoveryReason: Equatable, Sendable {
    /// Web build speaks no protocol version this shell supports.
    case incompatible(webVersions: [Int])
    /// The server could not be reached or the page failed to load.
    case unreachable(String)
    /// The web content process died repeatedly.
    case contentProcessLost
  }

  public enum State: Equatable, Sendable {
    /// No native chrome. Initial state, and the fail-open fallback.
    case webNavigation
    /// A document committed; waiting for its `bridge.hello`.
    case negotiating
    /// Welcome sent; waiting for the web to commit its native layout.
    case prepared(session: String, version: Int)
    /// Native chrome owns tab bar, dialogs and menus.
    case nativeNavigation(session: String, version: Int)
    /// Full-screen native recovery page instead of the web view.
    case recovery(RecoveryReason)
  }

  public enum Effect: Equatable, Sendable {
    case send(NativeMessage, version: Int)
    case startHandshakeTimer
    case cancelHandshakeTimer
  }

  public private(set) var state: State = .webNavigation
  private let makeSessionId: @Sendable () -> String

  public init(makeSessionId: @escaping @Sendable () -> String = { UUID().uuidString }) {
    self.makeSessionId = makeSessionId
  }

  public static func == (lhs: BridgeSession, rhs: BridgeSession) -> Bool { lhs.state == rhs.state }

  /// Version to stamp on outbound messages, when a session exists.
  public var version: Int? {
    switch state {
    case let .prepared(_, version), let .nativeNavigation(_, version): version
    default: nil
    }
  }

  public var isNativeChromeActive: Bool {
    if case .nativeNavigation = state { return true }
    return false
  }

  /// A new main-frame document committed; any previous session is void.
  public mutating func documentCommitted() -> [Effect] {
    state = .negotiating
    return [.startHandshakeTimer]
  }

  /// The handshake timer fired before the web finished negotiating.
  public mutating func handshakeTimedOut() -> [Effect] {
    switch state {
    case .negotiating, .prepared:
      state = .webNavigation
    default:
      break
    }
    return []
  }

  public mutating func receiveHello(versions: [Int], shell: ShellInfo) -> [Effect] {
    // A hello is only meaningful for a freshly committed document. A repeat
    // in prepared/native state (web re-ran its bootstrap) restarts the session.
    switch state {
    case .negotiating, .prepared, .nativeNavigation, .webNavigation:
      break
    case .recovery:
      return []
    }
    guard let version = BridgeProtocol.negotiate(versions) else {
      state = .recovery(.incompatible(webVersions: versions))
      let reject = NativeMessage.reject(
        message: "web protocol \(versions) is not supported by shell \(BridgeProtocol.supportedVersions)"
      )
      return [.cancelHandshakeTimer, .send(reject, version: versions.max() ?? 1)]
    }
    let session = makeSessionId()
    state = .prepared(session: session, version: version)
    return [
      .startHandshakeTimer,
      .send(.welcome(session: session, version: version, capabilities: BridgeProtocol.shellCapabilities, shell: shell), version: version),
    ]
  }

  public mutating func receiveReady(session: String) -> [Effect] {
    guard case let .prepared(current, version) = state, current == session else { return [] }
    state = .nativeNavigation(session: session, version: version)
    return [.cancelHandshakeTimer]
  }

  public mutating func loadFailed(_ description: String) -> [Effect] {
    state = .recovery(.unreachable(description))
    return [.cancelHandshakeTimer]
  }

  public mutating func contentProcessLost() -> [Effect] {
    state = .recovery(.contentProcessLost)
    return [.cancelHandshakeTimer]
  }

  /// User asked to retry from the recovery page; a reload follows.
  public mutating func retry() -> [Effect] {
    state = .webNavigation
    return [.cancelHandshakeTimer]
  }

  /// Whether a decoded message may be acted on in the current state.
  /// Declarations (tabs/route/theme) are accepted while prepared so the shell
  /// has them before it shows its chrome on `bridge.ready`.
  public func accepts(_ message: WebMessage) -> Bool {
    switch message {
    case .hello, .error:
      return true
    case .ready:
      if case .prepared = state { return true }
      return false
    case .tabs, .routeChanged, .themeChanged:
      switch state {
      case .prepared, .nativeNavigation: return true
      default: return false
      }
    case .confirmRequest, .menuRequest, .haptic:
      return isNativeChromeActive
    }
  }
}
