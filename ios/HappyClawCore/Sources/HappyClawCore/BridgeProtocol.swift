import Foundation

/// Wire format shared with `web/src/native/protocol.ts`. Both sides change
/// together; `ios/README.md` documents every message.
///
/// Envelope: `{ "v": Int, "type": String, "id"?: String, "payload": {...} }`.
/// Only declarations and results cross the bridge — never business data.
public enum BridgeProtocol {
  /// Versions this shell speaks.
  public static let supportedVersions: ClosedRange<Int> = 1...1
  /// `window.webkit.messageHandlers.<name>` registered by the shell.
  public static let handlerName = "happyclaw"
  /// Capabilities the shell offers to the web (subset of web's list).
  public static let shellCapabilities = ["layout", "tabs", "confirm", "menu", "haptic", "theme", "navbar", "shortcuts", "contextmenu", "anchoredmenu"]

  /// Highest version both sides speak, or nil when there is none.
  public static func negotiate(_ webVersions: [Int]) -> Int? {
    webVersions.filter { supportedVersions.contains($0) }.max()
  }
}

// MARK: - Shared value types

public struct Insets: Codable, Equatable, Sendable {
  public var top: Double
  public var right: Double
  public var bottom: Double
  public var left: Double

  public static let zero = Insets(top: 0, right: 0, bottom: 0, left: 0)

  public init(top: Double, right: Double, bottom: Double, left: Double) {
    self.top = top
    self.right = right
    self.bottom = bottom
    self.left = left
  }
}

public struct TabDeclaration: Codable, Equatable, Sendable, Identifiable, Hashable {
  public var id: String
  public var title: String
  /// SF Symbol name.
  public var symbol: String
  public var path: String

  public init(id: String, title: String, symbol: String, path: String) {
    self.id = id
    self.title = title
    self.symbol = symbol
    self.path = path
  }
}

/// An sRGB color sent by the web, components 0...1.
public struct RGBColor: Codable, Equatable, Sendable {
  public var red: Double
  public var green: Double
  public var blue: Double

  /// Accepts `#rrggbb` only, which is what the web normalizes to.
  public init?(hex: String) {
    guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    red = Double((value >> 16) & 0xFF) / 255
    green = Double((value >> 8) & 0xFF) / 255
    blue = Double(value & 0xFF) / 255
  }
}

public struct RouteState: Codable, Equatable, Sendable {
  public var path: String
  public var title: String?
  public var tabId: String?
  public var canGoBack: Bool
  public var tabBar: Bool
  /// Optional within v1: an older web build omits it and gets no native bar.
  public var nav: NavBarState?
  /// A web dialog or sheet is open; bars hide but insets stay as they were.
  public var modal: Bool?

  public init(
    path: String, title: String?, tabId: String?, canGoBack: Bool, tabBar: Bool,
    nav: NavBarState? = nil, modal: Bool? = nil
  ) {
    self.path = path
    self.title = title
    self.tabId = tabId
    self.canGoBack = canGoBack
    self.tabBar = tabBar
    self.nav = nav
    self.modal = modal
  }
}

/// The native navigation bar the web declares for the current screen.
public struct NavBarState: Codable, Equatable, Sendable {
  public struct Action: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var symbol: String

    public init(id: String, title: String, symbol: String) {
      self.id = id
      self.title = title
      self.symbol = symbol
    }
  }

  public var visible: Bool
  public var title: String?
  public var back: Bool
  public var action: Action?

  public init(visible: Bool, title: String?, back: Bool, action: Action?) {
    self.visible = visible
    self.title = title
    self.back = back
    self.action = action
  }
}

public struct ConfirmRequest: Codable, Equatable, Sendable {
  public var title: String
  public var message: String
  public var confirmText: String
  public var cancelText: String
  public var destructive: Bool
}

public struct MenuItemDeclaration: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var symbol: String?
  public var destructive: Bool?
  public var disabled: Bool?
  /// Shows a checkmark (radio-style choices such as theme).
  public var checked: Bool?
  /// A group: a submenu, or with `inline` a titled section of this menu.
  public var children: [MenuItemDeclaration]?
  public var inline: Bool?

  /// Selectable leaves in order, for presentations without nesting.
  public var leaves: [MenuItemDeclaration] {
    guard let children else { return [self] }
    return children.flatMap(\.leaves)
  }
}

public struct MenuRequest: Codable, Equatable, Sendable {
  public var title: String?
  public var message: String?
  public var items: [MenuItemDeclaration]
  /// The control that opened the menu (web view points). With it the shell
  /// shows a system menu from that spot (`anchoredmenu`); without it, or
  /// where that is unavailable, an action sheet of the leaves.
  public var anchor: Rect?
}

/// A rectangle in web view points (CSS pixels of the visual viewport).
public struct Rect: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public func contains(x px: Double, y py: Double, slop: Double = 0) -> Bool {
    px >= x - slop && px <= x + width + slop && py >= y - slop && py <= y + height + slop
  }
}

/// Sent by the web when a finger lands on an element that has a long-press
/// menu. The shell only shows it if the long press that follows lands inside
/// `rect` while the offer is fresh; otherwise WebKit keeps the gesture.
public struct ContextMenuOffer: Codable, Equatable, Sendable {
  public var token: String
  public var title: String?
  public var rect: Rect
  public var items: [MenuItemDeclaration]

  public init(token: String, title: String?, rect: Rect, items: [MenuItemDeclaration]) {
    self.token = token
    self.title = title
    self.rect = rect
    self.items = items
  }
}

public enum HapticStyle: String, Codable, Sendable {
  case light, medium, success, warning, error
}

public enum ColorSchemeName: String, Codable, Sendable {
  case light, dark
}

public enum BridgeErrorCode: String, Codable, Sendable {
  case invalidMessage = "invalid_message"
  case unsupportedType = "unsupported_type"
  case versionUnsupported = "version_unsupported"
  case notReady = "not_ready"
  case busy
  case cancelled
}

// MARK: - Web → native

public enum WebMessage: Equatable, Sendable {
  case hello(versions: [Int], capabilities: [String], build: String)
  case ready(session: String)
  case tabs(tabs: [TabDeclaration], more: [TabDeclaration])
  case routeChanged(RouteState)
  /// `background` (page color) and `accent` (palette --primary) are #rrggbb,
  /// both optional within v1.
  case themeChanged(ColorSchemeName, background: RGBColor?, accent: RGBColor?)
  case confirmRequest(id: String, ConfirmRequest)
  case menuRequest(id: String, MenuRequest)
  case contextMenuOffer(ContextMenuOffer)
  case haptic(HapticStyle)
  case error(code: String, message: String, ref: String?)
}

public struct DecodedWebMessage: Equatable, Sendable {
  public var version: Int
  public var message: WebMessage
}

public enum BridgeDecodeError: Error, Equatable {
  case invalidEnvelope
  case unsupportedVersion(Int, ref: String?)
  case unknownType(String, ref: String?)
  case invalidPayload(String, ref: String?)

  public var code: BridgeErrorCode {
    switch self {
    case .invalidEnvelope, .invalidPayload: .invalidMessage
    case .unsupportedVersion: .versionUnsupported
    case .unknownType: .unsupportedType
    }
  }

  public var ref: String? {
    switch self {
    case .invalidEnvelope: nil
    case .unsupportedVersion(_, let ref), .unknownType(_, let ref), .invalidPayload(_, let ref): ref
    }
  }
}

private struct RawEnvelope: Decodable {
  var v: Int
  var type: String
  var id: String?
}

private struct PayloadEnvelope<P: Decodable>: Decodable {
  var payload: P
}

private struct HelloPayload: Decodable {
  struct Client: Decodable { var build: String }
  var versions: [Int]
  var capabilities: [String]
  var client: Client
}

private struct ReadyPayload: Decodable { var session: String }
private struct TabsPayload: Decodable {
  var tabs: [TabDeclaration]
  var more: [TabDeclaration]
}
private struct ThemePayload: Decodable { var scheme: ColorSchemeName; var background: String?; var accent: String? }
private struct HapticPayload: Decodable { var style: HapticStyle }
private struct ErrorPayload: Decodable {
  var code: String
  var message: String
  var ref: String?
}

extension BridgeProtocol {
  /// Decode a web → native envelope from JSON data.
  ///
  /// `bridge.hello` is accepted at any version so the shell can answer an
  /// incompatible web build with `bridge.reject` instead of silence.
  public static func decode(_ data: Data) throws(BridgeDecodeError) -> DecodedWebMessage {
    let decoder = JSONDecoder()
    guard let raw = try? decoder.decode(RawEnvelope.self, from: data) else {
      throw .invalidEnvelope
    }
    if raw.type != "bridge.hello", !supportedVersions.contains(raw.v) {
      throw .unsupportedVersion(raw.v, ref: raw.id)
    }

    func payload<P: Decodable>(_: P.Type) throws(BridgeDecodeError) -> P {
      do {
        return try decoder.decode(PayloadEnvelope<P>.self, from: data).payload
      } catch {
        throw .invalidPayload(raw.type, ref: raw.id)
      }
    }
    func requestId() throws(BridgeDecodeError) -> String {
      guard let id = raw.id, !id.isEmpty else { throw .invalidPayload(raw.type, ref: nil) }
      return id
    }

    let message: WebMessage
    switch raw.type {
    case "bridge.hello":
      let p = try payload(HelloPayload.self)
      message = .hello(versions: p.versions, capabilities: p.capabilities, build: p.client.build)
    case "bridge.ready":
      message = .ready(session: try payload(ReadyPayload.self).session)
    case "chrome.tabs":
      let p = try payload(TabsPayload.self)
      message = .tabs(tabs: p.tabs, more: p.more)
    case "route.changed":
      message = .routeChanged(try payload(RouteState.self))
    case "theme.changed":
      let theme = try payload(ThemePayload.self)
      // An unparseable color is dropped rather than failing the message.
      message = .themeChanged(
        theme.scheme,
        background: theme.background.flatMap(RGBColor.init(hex:)),
        accent: theme.accent.flatMap(RGBColor.init(hex:)))
    case "confirm.request":
      message = .confirmRequest(id: try requestId(), try payload(ConfirmRequest.self))
    case "menu.request":
      message = .menuRequest(id: try requestId(), try payload(MenuRequest.self))
    case "contextmenu.offer":
      message = .contextMenuOffer(try payload(ContextMenuOffer.self))
    case "haptic":
      message = .haptic(try payload(HapticPayload.self).style)
    case "bridge.error":
      let p = try payload(ErrorPayload.self)
      message = .error(code: p.code, message: p.message, ref: p.ref)
    default:
      throw .unknownType(raw.type, ref: raw.id)
    }
    return DecodedWebMessage(version: raw.v, message: message)
  }
}

// MARK: - Native → web

public struct ShellInfo: Codable, Equatable, Sendable {
  public var platform = "ios"
  public var version: String
  public var build: String
  public var os: String

  public init(version: String, build: String, os: String) {
    self.version = version
    self.build = build
    self.os = os
  }
}

public enum LifecycleState: String, Codable, Sendable {
  case active, inactive, background
}

public enum NativeMessage: Equatable, Sendable {
  case welcome(session: String, version: Int, capabilities: [String], shell: ShellInfo)
  case reject(message: String)
  case layout(contentInsets: Insets, safeArea: Insets, keyboard: Double)
  case navSelect(tabId: String)
  case navBack
  case navAction(id: String)
  case appShortcut(id: String)
  case contextMenuResult(token: String, selected: String)
  case confirmResult(id: String, confirmed: Bool)
  case menuResult(id: String, selected: String?)
  case lifecycle(LifecycleState)
  case error(code: BridgeErrorCode, message: String, ref: String?)

  public var type: String {
    switch self {
    case .welcome: "bridge.welcome"
    case .reject: "bridge.reject"
    case .layout: "layout.update"
    case .navSelect: "nav.select"
    case .navBack: "nav.back"
    case .navAction: "nav.action"
    case .appShortcut: "app.shortcut"
    case .contextMenuResult: "contextmenu.result"
    case .confirmResult: "confirm.result"
    case .menuResult: "menu.result"
    case .lifecycle: "app.lifecycle"
    case .error: "bridge.error"
    }
  }
}

private struct OutboundEnvelope<P: Encodable>: Encodable {
  var v: Int
  var type: String
  var id: String?
  var payload: P
}

private struct Empty: Encodable {}

extension BridgeProtocol {
  /// Encode a native → web envelope as JSON data.
  public static func encode(_ message: NativeMessage, version: Int) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    func envelope<P: Encodable>(_ payload: P, id: String? = nil) -> Data {
      // Encoding plain value types cannot fail.
      try! encoder.encode(OutboundEnvelope(v: version, type: message.type, id: id, payload: payload))
    }

    switch message {
    case let .welcome(session, negotiated, capabilities, shell):
      struct P: Encodable { var session: String; var version: Int; var capabilities: [String]; var shell: ShellInfo }
      return envelope(P(session: session, version: negotiated, capabilities: capabilities, shell: shell))
    case let .reject(text):
      struct P: Encodable { var code = "version_unsupported"; var message: String; var supported: [Int] }
      return envelope(P(message: text, supported: Array(supportedVersions)))
    case let .layout(contentInsets, safeArea, keyboard):
      struct P: Encodable { var contentInsets: Insets; var safeArea: Insets; var keyboard: Double }
      return envelope(P(contentInsets: contentInsets, safeArea: safeArea, keyboard: keyboard))
    case let .navSelect(tabId):
      struct P: Encodable { var tabId: String }
      return envelope(P(tabId: tabId))
    case .navBack:
      return envelope(Empty())
    case let .navAction(id), let .appShortcut(id):
      struct P: Encodable { var id: String }
      return envelope(P(id: id))
    case let .contextMenuResult(token, selected):
      struct P: Encodable { var token: String; var selected: String }
      return envelope(P(token: token, selected: selected))
    case let .confirmResult(id, confirmed):
      struct P: Encodable { var confirmed: Bool }
      return envelope(P(confirmed: confirmed), id: id)
    case let .menuResult(id, selected):
      // `selected: null` must be present on the wire, so encode explicitly.
      struct P: Encodable {
        var selected: String?
        func encode(to encoder: Encoder) throws {
          var c = encoder.container(keyedBy: CodingKeys.self)
          try c.encode(selected, forKey: .selected)
        }
        enum CodingKeys: String, CodingKey { case selected }
      }
      return envelope(P(selected: selected), id: id)
    case let .lifecycle(state):
      struct P: Encodable { var state: LifecycleState }
      return envelope(P(state: state))
    case let .error(code, text, ref):
      struct P: Encodable { var code: BridgeErrorCode; var message: String; var ref: String? }
      return envelope(P(code: code, message: text, ref: ref))
    }
  }
}
