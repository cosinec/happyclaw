import Foundation
import HappyClawCore
import WebKit

/// Script injected at document start into the top frame only. It exposes a
/// frozen `window.HappyClawNative` — the web's sole signal that it runs in the
/// shell (it never sniffs the user agent).
enum BridgeBootstrap {
  static var source: String {
    """
    (() => {
      'use strict';
      if (window.top !== window || window.HappyClawNative) return;
      const handlers = window.webkit && window.webkit.messageHandlers;
      const handler = handlers && handlers.\(BridgeProtocol.handlerName);
      if (!handler) return;
      Object.defineProperty(window, 'HappyClawNative', {
        value: Object.freeze({
          platform: 'ios',
          protocolVersions: Object.freeze([\(BridgeProtocol.supportedVersions.map(String.init).joined(separator: ","))]),
          post: (message) => handler.postMessage(message),
        }),
        configurable: false,
        enumerable: false,
        writable: false,
      });
    })();
    """
  }
}

/// Transport between WKWebView and the shell. Decodes inbound envelopes,
/// drops anything not sent by the top frame of the configured instance, and
/// delivers outbound envelopes through `window.__happyclawNativeReceive`.
final class BridgeChannel: NSObject, WKScriptMessageHandler {
  var server: ServerAddress?
  var onMessage: (Result<DecodedWebMessage, BridgeDecodeError>) -> Void = { _ in }
  weak var webView: WKWebView?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, isFromServer(message.frameInfo.securityOrigin) else { return }
    guard JSONSerialization.isValidJSONObject(message.body),
      let data = try? JSONSerialization.data(withJSONObject: message.body)
    else {
      onMessage(.failure(.invalidEnvelope))
      return
    }
    do {
      onMessage(.success(try BridgeProtocol.decode(data)))
    } catch {
      onMessage(.failure(error))
    }
  }

  func send(_ message: NativeMessage, version: Int) {
    guard let webView else { return }
    let json = String(decoding: BridgeProtocol.encode(message, version: version), as: UTF8.self)
    webView.callAsyncJavaScript(
      "const r = window.__happyclawNativeReceive; if (typeof r === 'function') r(JSON.parse(json));",
      arguments: ["json": json],
      in: nil,
      in: .page,
      completionHandler: nil
    )
  }

  private func isFromServer(_ origin: WKSecurityOrigin) -> Bool {
    guard let server else { return false }
    var components = URLComponents()
    components.scheme = origin.protocol
    components.host = origin.host
    if origin.port != 0 { components.port = origin.port }
    components.path = server.url.path
    guard let url = components.url else { return false }
    return server.contains(url)
  }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}
