import Foundation
import Testing
@testable import HappyClawCore

private func json(_ string: String) -> Data { Data(string.utf8) }
private let shell = ShellInfo(version: "0.1.0", build: "1", os: "27.1")

@Suite struct ProtocolDecodingTests {
  @Test func decodesHelloAtAnyVersion() throws {
    let decoded = try BridgeProtocol.decode(json(#"""
      {"v":3,"type":"bridge.hello","payload":{"versions":[2,3],"capabilities":["layout"],"client":{"name":"happyclaw-web","build":"dev"}}}
      """#))
    #expect(decoded.version == 3)
    #expect(decoded.message == .hello(versions: [2, 3], capabilities: ["layout"], build: "dev"))
  }

  @Test func decodesDeclarationsAndRequests() throws {
    let route = try BridgeProtocol.decode(json(#"""
      {"v":1,"type":"route.changed","payload":{"path":"/chat/main","title":"工作台","tabId":"chat","canGoBack":true,"tabBar":false}}
      """#))
    #expect(route.message == .routeChanged(RouteState(path: "/chat/main", title: "工作台", tabId: "chat", canGoBack: true, tabBar: false)))

    let nullTitle = try BridgeProtocol.decode(json(#"""
      {"v":1,"type":"route.changed","payload":{"path":"/login","title":null,"tabId":null,"canGoBack":false,"tabBar":false}}
      """#))
    if case let .routeChanged(state) = nullTitle.message {
      #expect(state.tabId == nil)
      #expect(state.nav == nil)  // older web builds omit it
    } else { Issue.record("wrong case") }

    let withNav = try BridgeProtocol.decode(json(#"""
      {"v":1,"type":"route.changed","payload":{"path":"/memory","title":"记忆","tabId":"memory","canGoBack":false,"tabBar":true,
       "nav":{"visible":true,"title":"记忆详情","back":true,"action":{"id":"page","title":"分区","symbol":"list.bullet"}}}}
      """#))
    if case let .routeChanged(state) = withNav.message {
      #expect(state.nav == NavBarState(
        visible: true, title: "记忆详情", back: true,
        action: .init(id: "page", title: "分区", symbol: "list.bullet")))
    } else { Issue.record("wrong case") }

    let theme = try BridgeProtocol.decode(json(#"""
      {"v":1,"type":"theme.changed","payload":{"scheme":"light","background":"#faf9f5","accent":"#f97316"}}
      """#))
    #expect(theme.message == .themeChanged(.light, background: RGBColor(hex: "#faf9f5"), accent: RGBColor(hex: "#f97316")))
    #expect(RGBColor(hex: "#ff0000")?.red == 1)
    #expect(RGBColor(hex: "oklch(0.1 0 0)") == nil)

    let confirm = try BridgeProtocol.decode(json(#"""
      {"v":1,"type":"confirm.request","id":"w1","payload":{"title":"删除？","message":"不可恢复","confirmText":"删除","cancelText":"取消","destructive":true}}
      """#))
    guard case let .confirmRequest(id, request) = confirm.message else { Issue.record("wrong case"); return }
    #expect(id == "w1")
    #expect(request.destructive)
  }

  @Test func rejectsBadInput() {
    #expect(throws: BridgeDecodeError.invalidEnvelope) { try BridgeProtocol.decode(json("[]")) }
    #expect(throws: BridgeDecodeError.unsupportedVersion(9, ref: "x")) {
      try BridgeProtocol.decode(json(#"{"v":9,"type":"haptic","id":"x","payload":{"style":"light"}}"#))
    }
    #expect(throws: BridgeDecodeError.unknownType("nope", ref: nil)) {
      try BridgeProtocol.decode(json(#"{"v":1,"type":"nope","payload":{}}"#))
    }
    #expect(throws: BridgeDecodeError.invalidPayload("haptic", ref: nil)) {
      try BridgeProtocol.decode(json(#"{"v":1,"type":"haptic","payload":{"style":"boom"}}"#))
    }
    // Requests without an id cannot be answered, so they are invalid.
    #expect(throws: BridgeDecodeError.invalidPayload("menu.request", ref: nil)) {
      try BridgeProtocol.decode(json(#"{"v":1,"type":"menu.request","payload":{"title":null,"message":null,"items":[]}}"#))
    }
  }

  @Test func encodesEnvelopes() throws {
    let data = BridgeProtocol.encode(.menuResult(id: "w2", selected: nil), version: 1)
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["v"] as? Int == 1)
    #expect(object["type"] as? String == "menu.result")
    #expect(object["id"] as? String == "w2")
    let payload = try #require(object["payload"] as? [String: Any])
    #expect(payload.keys.contains("selected"))
    #expect(payload["selected"] is NSNull)

    let back = try #require(try JSONSerialization.jsonObject(with: BridgeProtocol.encode(.navBack, version: 1)) as? [String: Any])
    #expect((back["payload"] as? [String: Any])?.isEmpty == true)
  }
}

@Suite struct SessionTests {
  private func fresh() -> BridgeSession { BridgeSession(makeSessionId: { "s1" }) }

  @Test func happyPath() {
    var session = fresh()
    #expect(session.documentCommitted() == [.startHandshakeTimer])
    let effects = session.receiveHello(versions: [1], shell: shell)
    #expect(session.state == .prepared(session: "s1", version: 1))
    #expect(effects.contains(.send(.welcome(session: "s1", version: 1, capabilities: BridgeProtocol.shellCapabilities, shell: shell), version: 1)))
    #expect(!session.isNativeChromeActive)
    #expect(session.accepts(.tabs(tabs: [], more: [])))
    #expect(!session.accepts(.haptic(.light)))

    #expect(session.receiveReady(session: "other").isEmpty)
    #expect(session.receiveReady(session: "s1") == [.cancelHandshakeTimer])
    #expect(session.isNativeChromeActive)
    #expect(session.accepts(.haptic(.light)))
  }

  @Test func incompatibleWebGoesToRecoveryWithReject() {
    var session = fresh()
    _ = session.documentCommitted()
    let effects = session.receiveHello(versions: [2], shell: shell)
    #expect(session.state == .recovery(.incompatible(webVersions: [2])))
    #expect(effects.contains { if case .send(.reject, _) = $0 { true } else { false } })
  }

  @Test func timeoutFailsOpenToWebChrome() {
    var session = fresh()
    _ = session.documentCommitted()
    _ = session.handshakeTimedOut()
    #expect(session.state == .webNavigation)

    _ = session.documentCommitted()
    _ = session.receiveHello(versions: [1], shell: shell)
    _ = session.handshakeTimedOut()
    #expect(session.state == .webNavigation)
    #expect(session.receiveReady(session: "s1").isEmpty)
  }

  @Test func newDocumentVoidsActiveSession() {
    var session = fresh()
    _ = session.documentCommitted()
    _ = session.receiveHello(versions: [1], shell: shell)
    _ = session.receiveReady(session: "s1")
    _ = session.documentCommitted()
    #expect(session.state == .negotiating)
    #expect(!session.accepts(.routeChanged(RouteState(path: "/", title: nil, tabId: nil, canGoBack: false, tabBar: false))))
  }

  @Test func recoveryAndRetry() {
    var session = fresh()
    _ = session.loadFailed("offline")
    #expect(session.state == .recovery(.unreachable("offline")))
    // A hello from a stale page must not leave recovery.
    #expect(session.receiveHello(versions: [1], shell: shell).isEmpty)
    _ = session.retry()
    #expect(session.state == .webNavigation)
  }
}

@Suite struct AddressAndLinkTests {
  @Test func normalizesAddresses() throws {
    #expect(try ServerAddress(parsing: " 192.168.1.5:5173 ").url.absoluteString == "http://192.168.1.5:5173/")
    #expect(try ServerAddress(parsing: "HTTPS://Claw.Example.com/app?x=1#y").url.absoluteString == "https://claw.example.com/app/")
    #expect(throws: ServerAddress.ParseError.empty) { try ServerAddress(parsing: "  ") }
    #expect(throws: ServerAddress.ParseError.unsupportedScheme("ftp")) { try ServerAddress(parsing: "ftp://x") }
  }

  @Test func containsRespectsOriginAndBasePath() throws {
    let root = try ServerAddress(parsing: "https://claw.example.com")
    #expect(root.contains(URL(string: "https://claw.example.com:443/chat/main")!))
    #expect(!root.contains(URL(string: "http://claw.example.com/chat")!))
    #expect(!root.contains(URL(string: "https://evil.example.com/")!))

    let based = try ServerAddress(parsing: "https://h.example/claw")
    #expect(based.contains(URL(string: "https://h.example/claw")!))
    #expect(based.contains(URL(string: "https://h.example/claw/chat")!))
    #expect(!based.contains(URL(string: "https://h.example/clawed")!))
  }

  @Test func linkDecisions() throws {
    let server = try ServerAddress(parsing: "http://10.0.0.2:5173")
    let same = URL(string: "http://10.0.0.2:5173/tasks")!
    let other = URL(string: "https://github.com/riba2534/happyclaw")!
    #expect(WebLinkPolicy.decide(same, server: server, isMainFrame: true, opensNewWindow: false) == .allow)
    #expect(WebLinkPolicy.decide(other, server: server, isMainFrame: true, opensNewWindow: false) == .openExternally)
    #expect(WebLinkPolicy.decide(other, server: server, isMainFrame: false, opensNewWindow: false) == .allow)
    #expect(WebLinkPolicy.decide(URL(string: "mailto:a@b.c")!, server: server, isMainFrame: true, opensNewWindow: false) == .openExternally)
    #expect(WebLinkPolicy.decide(URL(string: "javascript:alert(1)")!, server: server, isMainFrame: true, opensNewWindow: false) == .cancel)
  }
}

@Suite struct LayoutTests {
  private let safe = Insets(top: 59, right: 0, bottom: 34, left: 0)

  @Test func tabBarCoversBottom() {
    let out = LayoutCalculator.compute(LayoutInput(safeArea: safe, tabBarOccupancy: 96.33, tabBarVisible: true, keyboardHeight: 0))
    #expect(out.contentInsets == Insets(top: 0, right: 0, bottom: 96.5, left: 0))
    #expect(out.safeArea == safe)
  }

  @Test func hiddenBarOrKeyboardFreesBottom() {
    #expect(LayoutCalculator.compute(LayoutInput(safeArea: safe, tabBarOccupancy: 96, tabBarVisible: false, keyboardHeight: 0)).contentInsets.bottom == 0)
    let typing = LayoutCalculator.compute(LayoutInput(safeArea: safe, tabBarOccupancy: 96, tabBarVisible: true, keyboardHeight: 336))
    #expect(typing.contentInsets.bottom == 0)
    #expect(typing.keyboard == 336)
  }

  @Test func navBarCoversTopIncludingStatusBar() {
    let shown = LayoutCalculator.compute(LayoutInput(
      safeArea: safe, tabBarOccupancy: 0, tabBarVisible: false, keyboardHeight: 336,
      navBarOccupancy: 103, navBarVisible: true))
    // Stays while typing, unlike the tab bar.
    #expect(shown.contentInsets.top == 103)
    let hidden = LayoutCalculator.compute(LayoutInput(
      safeArea: safe, tabBarOccupancy: 0, tabBarVisible: false, keyboardHeight: 0,
      navBarOccupancy: 103, navBarVisible: false))
    #expect(hidden.contentInsets.top == 0)
    // Before the bar is measured it still reports more than the status bar.
    let unmeasured = LayoutCalculator.compute(LayoutInput(
      safeArea: safe, tabBarOccupancy: 0, tabBarVisible: false, keyboardHeight: 0,
      navBarOccupancy: 0, navBarVisible: true))
    #expect(unmeasured.contentInsets.top > safe.top)
  }
}

@Suite struct ServerRegistryTests {
  private func address(_ text: String) throws -> ServerAddress { try ServerAddress(parsing: text) }

  @Test func migratesLegacyAddressOntoSharedStore() throws {
    let registry = ServerRegistry(legacyAddress: try address("http://192.168.1.10:5173"))
    #expect(registry.instances.count == 1)
    #expect(registry.active?.dataStore == .shared)
    #expect(ServerRegistry(legacyAddress: nil).active == nil)
  }

  @Test func activateDeduplicatesByAddressAndIsolatesNewOnes() throws {
    var registry = ServerRegistry(legacyAddress: try address("http://192.168.1.10:5173"))
    let legacy = try #require(registry.active)
    let home = registry.activate(try address("https://claw.example.com:8443/"))
    #expect(home.dataStore == .isolated(home.id))
    #expect(registry.activeID == home.id)
    // Same server typed differently is the same instance.
    let again = registry.activate(try address("HTTPS://CLAW.example.com:8443"))
    #expect(again.id == home.id)
    #expect(registry.instances.count == 2)
    registry.select(legacy.id)
    #expect(registry.active == legacy)
  }

  @Test func onlyInactiveInstancesCanBeRemoved() throws {
    var registry = ServerRegistry()
    let a = registry.activate(try address("http://a.local"))
    let b = registry.activate(try address("http://b.local"))
    #expect(registry.remove(b.id) == nil)  // active
    #expect(registry.remove(a.id) == a)
    #expect(registry.instances == [b])
    registry.select(UUID())  // unknown id is ignored
    #expect(registry.activeID == b.id)
  }

  @Test func roundTripsThroughJSON() throws {
    var registry = ServerRegistry(legacyAddress: try address("http://a.local"))
    registry.activate(try address("http://b.local"))
    let decoded = try JSONDecoder().decode(ServerRegistry.self, from: JSONEncoder().encode(registry))
    #expect(decoded == registry)
  }
}

@Suite struct ContextMenuTests {
  @Test func decodesOfferAndEncodesResult() throws {
    let decoded = try BridgeProtocol.decode(Data(#"""
      {"v":1,"type":"contextmenu.offer","payload":{"token":"m3","title":null,
       "rect":{"x":16,"y":200,"width":300,"height":80},
       "items":[{"id":"copy","title":"复制文本","symbol":"doc.on.doc"},{"id":"delete","title":"删除","destructive":true}]}}
      """#.utf8))
    guard case let .contextMenuOffer(offer) = decoded.message else { Issue.record("wrong case"); return }
    #expect(offer.token == "m3")
    #expect(offer.items.map(\.id) == ["copy", "delete"])
    #expect(offer.items[1].destructive == true)
    #expect(offer.rect.contains(x: 20, y: 210))
    #expect(!offer.rect.contains(x: 20, y: 300))
    #expect(offer.rect.contains(x: 20, y: 285, slop: 8))

    let result = try #require(try JSONSerialization.jsonObject(
      with: BridgeProtocol.encode(.contextMenuResult(token: "m3", selected: "copy"), version: 1)) as? [String: Any])
    #expect(result["type"] as? String == "contextmenu.result")
    #expect((result["payload"] as? [String: String]) == ["token": "m3", "selected": "copy"])
  }

  @Test func offersAreOnlyAcceptedWithNativeChrome() throws {
    let offer = WebMessage.contextMenuOffer(
      ContextMenuOffer(token: "m1", title: nil, rect: Rect(x: 0, y: 0, width: 1, height: 1), items: []))
    #expect(!BridgeSession().accepts(offer))
  }
}

@Suite struct AnchoredMenuTests {
  @Test func decodesNestedAnchoredMenus() throws {
    let decoded = try BridgeProtocol.decode(Data(#"""
      {"v":1,"type":"menu.request","id":"w4","payload":{"title":null,"message":null,
       "anchor":{"x":300,"y":60,"width":44,"height":44},
       "items":[{"id":"profile","title":"个人设置","symbol":"person.crop.circle"},
                {"id":"theme","title":"主题","inline":true,"children":[
                  {"id":"theme:light","title":"浅色","checked":true},{"id":"theme:dark","title":"深色"}]},
                {"id":"logout","title":"退出登录","destructive":true}]}}
      """#.utf8))
    guard case let .menuRequest(id, request) = decoded.message else { Issue.record("wrong case"); return }
    #expect(id == "w4")
    #expect(request.anchor == Rect(x: 300, y: 60, width: 44, height: 44))
    #expect(request.items[1].inline == true)
    #expect(request.items[1].children?.first?.checked == true)
    #expect(request.items.flatMap(\.leaves).map(\.id) == ["profile", "theme:light", "theme:dark", "logout"])
  }
}
