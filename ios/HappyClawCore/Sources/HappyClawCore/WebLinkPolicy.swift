import Foundation

/// Where a navigation from the web view should go.
public enum WebLinkDecision: Equatable, Sendable {
  /// Load inside the shell's web view.
  case allow
  /// Hand to the system (Safari, Mail, Phone, another app) and cancel.
  case openExternally
  /// Drop silently (e.g. unknown internal schemes).
  case cancel
}

public enum WebLinkPolicy {
  /// - Parameters:
  ///   - isMainFrame: false for iframe loads (previews, embedded content).
  ///   - opensNewWindow: `target=_blank` / `window.open`.
  public static func decide(
    _ url: URL,
    server: ServerAddress,
    isMainFrame: Bool,
    opensNewWindow: Bool
  ) -> WebLinkDecision {
    let scheme = url.scheme?.lowercased() ?? ""
    switch scheme {
    case "about", "blob", "data":
      return opensNewWindow ? .cancel : .allow
    case "http", "https":
      if server.contains(url) { return .allow }
      // Embedded third-party frames stay embedded; top-level navigation away
      // from the instance would strand the user outside the app chrome.
      return isMainFrame || opensNewWindow ? .openExternally : .allow
    case "mailto", "tel", "sms", "facetime", "maps", "itms-apps":
      return .openExternally
    default:
      return .cancel
    }
  }
}
