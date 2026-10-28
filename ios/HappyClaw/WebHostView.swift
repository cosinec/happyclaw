import HappyClawCore
import OSLog
import SwiftUI
import UIKit
import WebKit

/// Owns the single WKWebView of the active server. SwiftUI only embeds it
/// (WebHostView), so tab switches and sheet presentations never recreate it;
/// switching servers replaces the whole controller, because a web view's
/// data store is fixed at creation.
final class WebController: NSObject {
  let webView: WKWebView
  let dataStore: ServerInstance.DataStore
  let channel = BridgeChannel()
  let downloads = DownloadHost()
  let contextMenu = ContextMenuHost()
  let anchoredMenu = AnchoredMenuPresenter()

  var server: ServerAddress? {
    didSet { channel.server = server }
  }

  /// A new main-frame document committed (full load or reload).
  var onDocumentCommitted: () -> Void = {}
  var onLoadFailed: (String) -> Void = { _ in }
  var onContentProcessLost: () -> Void = {}

  private var processTerminations: [Date] = []

  init(dataStore: ServerInstance.DataStore) {
    self.dataStore = dataStore
    let configuration = WKWebViewConfiguration()
    // Persistent per-server store: logins survive relaunches like in Safari
    // and never leak between servers.
    configuration.websiteDataStore = Self.store(for: dataStore)
    configuration.allowsInlineMediaPlayback = true
    configuration.applicationNameForUserAgent = "HappyClawShell/\(ShellBuild.info.version)"
    configuration.userContentController.addUserScript(
      WKUserScript(source: BridgeBootstrap.source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()

    configuration.userContentController.add(WeakScriptHandler(channel), name: BridgeProtocol.handlerName)
    channel.webView = webView
    webView.navigationDelegate = self
    webView.uiDelegate = self
    contextMenu.webView = webView
    anchoredMenu.host = webView
    webView.addInteraction(UIContextMenuInteraction(delegate: contextMenu))
    // Edge swipe walks the web history, including react-router pushState entries.
    webView.allowsBackForwardNavigationGestures = true
    // The web lays out against env(safe-area-inset-*) and --native-*; the
    // scroll view must not add its own insets on top.
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.isOpaque = false
    webView.backgroundColor = .systemBackground
    #if DEBUG
      webView.isInspectable = true
    #endif
  }

  private static func store(for dataStore: ServerInstance.DataStore) -> WKWebsiteDataStore {
    switch dataStore {
    case .shared: .default()
    case let .isolated(id): WKWebsiteDataStore(forIdentifier: id)
    }
  }

  /// Deletes a removed server's cookies, storage and caches on this device.
  /// The server's own data is untouched.
  static func deleteData(of instance: ServerInstance) async {
    if let host = instance.address.url.host() {
      for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.domain.hasSuffix(host) {
        HTTPCookieStorage.shared.deleteCookie(cookie)
      }
    }
    switch instance.dataStore {
    case .shared:
      await WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    case let .isolated(id):
      do {
        try await WKWebsiteDataStore.remove(forIdentifier: id)
      } catch {
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "HappyClaw", category: "server")
          .error("remove data store: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  /// What shows until the page paints: the server's last known background.
  func setPlaceholder(_ color: RGBColor?) {
    let background = color.map { UIColor(red: $0.red, green: $0.green, blue: $0.blue, alpha: 1) } ?? .systemBackground
    webView.backgroundColor = background
    webView.scrollView.backgroundColor = background
  }

  func load(_ address: ServerAddress) {
    server = address
    webView.load(URLRequest(url: address.url))
  }

  func stopLoading() { webView.stopLoading() }

  func reload() {
    if webView.url == nil, let server {
      webView.load(URLRequest(url: server.url))
    } else {
      webView.reload()
    }
  }

  /// Copy the instance's cookies into the shared store so future native
  /// requests (widget snapshots, push registration) carry the web login.
  private func syncCookies() {
    guard let server else { return }
    webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
      for cookie in cookies {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        if server.url.host == domain || server.url.host?.hasSuffix(".\(domain)") == true {
          HTTPCookieStorage.shared.setCookie(cookie)
        }
      }
    }
  }

  private func openExternally(_ url: URL) {
    UIApplication.shared.open(url)
  }

  private var presenter: UIViewController? {
    var top = webView.window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

extension WebController: WKNavigationDelegate {
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let url = navigationAction.request.url, let server else { return .cancel }
    // `<a download>`: the web's download helper always produces a blob: URL;
    // direct links to the instance are accepted too. Anything else follows
    // the normal link policy.
    if navigationAction.shouldPerformDownload,
      url.scheme == "blob" || url.scheme == "data" || server.contains(url)
    {
      return .download
    }
    let decision = WebLinkPolicy.decide(
      url,
      server: server,
      isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
      opensNewWindow: navigationAction.targetFrame == nil
    )
    switch decision {
    case .allow:
      return .allow
    case .openExternally:
      openExternally(url)
      return .cancel
    case .cancel:
      return .cancel
    }
  }

  /// Attachments and types WebKit cannot display become downloads instead of
  /// a dead navigation.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse
  ) async -> WKNavigationResponsePolicy {
    let disposition = (navigationResponse.response as? HTTPURLResponse)?
      .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
    if disposition.hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
      return .download
    }
    return .allow
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = downloads
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = downloads
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    onDocumentCommitted()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    syncCookies()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    reportFailure(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    reportFailure(error)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // Reload transparently unless the process keeps dying.
    let now = Date()
    processTerminations = processTerminations.filter { now.timeIntervalSince($0) < 60 } + [now]
    if processTerminations.count >= 3 {
      onContentProcessLost()
    } else {
      reload()
    }
  }

  private func reportFailure(_ error: Error) {
    let nsError = error as NSError
    // Superseded loads and policy cancellations are not failures.
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
    if nsError.domain == "WebKitErrorDomain", nsError.code == 102 { return }
    onLoadFailed(nsError.localizedDescription)
  }
}

extension WebController: WKUIDelegate {
  /// `target=_blank` / `window.open`: same-instance pages load in place,
  /// anything else goes to the system.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let url = navigationAction.request.url, let server else { return nil }
    if server.contains(url) {
      webView.load(navigationAction.request)
    } else if WebLinkPolicy.decide(url, server: server, isMainFrame: true, opensNewWindow: true) == .openExternally {
      openExternally(url)
    }
    return nil
  }

  // Without these, window.alert/confirm/prompt silently return defaults in
  // WKWebView — and the web's unsaved-changes guard relies on confirm().
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
    await withCheckedContinuation { continuation in
      let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: L10n.ok, style: .default) { _ in continuation.resume() })
      guard let presenter else { return continuation.resume() }
      presenter.present(alert, animated: true)
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
    await withCheckedContinuation { continuation in
      let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: L10n.cancel, style: .cancel) { _ in continuation.resume(returning: false) })
      alert.addAction(UIAlertAction(title: L10n.ok, style: .default) { _ in continuation.resume(returning: true) })
      guard let presenter else { return continuation.resume(returning: false) }
      presenter.present(alert, animated: true)
    }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo
  ) async -> String? {
    await withCheckedContinuation { continuation in
      let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
      alert.addTextField { $0.text = defaultText }
      alert.addAction(UIAlertAction(title: L10n.cancel, style: .cancel) { _ in continuation.resume(returning: nil) })
      alert.addAction(UIAlertAction(title: L10n.ok, style: .default) { [weak alert] _ in
        continuation.resume(returning: alert?.textFields?.first?.text ?? "")
      })
      guard let presenter else { return continuation.resume(returning: nil) }
      presenter.present(alert, animated: true)
    }
  }
}

/// Embeds the controller's long-lived web view.
struct WebHostView: UIViewRepresentable {
  let controller: WebController

  func makeUIView(context: Context) -> WKWebView { controller.webView }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
