import HappyClawCore
import SwiftUI
import UIKit

/// Window root: a NavigationStack whose root is the full-screen web view with
/// the floating native tab bar on top. The web view extends under the status
/// bar and home indicator so CSS env(safe-area-inset-*) keeps its browser
/// meaning; native chrome reports its extra coverage via layout.update.
struct RootShell: View {
  @Bindable var model: ShellModel
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack(path: $model.path) {
      content
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: ShellRoute.self) { route in
          switch route {
          case .serverSettings:
            ConnectView(initial: model.server, isSettings: true) { model.connect(to: $0) }
          case .diagnostics:
            DiagnosticsView(model: model)
          }
        }
    }
    .confirmBridge(model.confirm)
    .menuBridge(model.menu)
    .sheet(item: $model.sheet) { sheet in
      switch sheet {
      case .more:
        MoreSheet(
          items: model.more,
          selectedId: model.route?.tabId,
          onSelectPage: { model.selectTab($0) },
          onOpenRoute: { model.open($0) }
        )
      }
    }
    .preferredColorScheme(model.webScheme.map { $0 == .dark ? .dark : .light })
    .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
      updateKeyboard(note)
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
      model.layout.keyboardHeight = 0
      model.layoutChanged()
    }
  }

  @ViewBuilder
  private var content: some View {
    if model.server == nil {
      ConnectView(initial: nil, isSettings: false) { model.connect(to: $0) }
    } else {
      GeometryReader { proxy in
        let screenBottom = proxy.frame(in: .global).maxY + proxy.safeAreaInsets.bottom
        ZStack(alignment: .bottom) {
          WebHostView(controller: model.web)
            .ignoresSafeArea()

          if let nav = model.navBar, !model.webModalOpen {
            NativeNavBar(
              state: nav,
              background: model.webBackground,
              onBack: { model.goBack() },
              onAction: { model.performNavAction($0) }
            )
            .onGeometryChange(for: CGFloat.self) { bar in bar.frame(in: .global).maxY } action: { bottom in
              // The root view's global frame starts at the screen top.
              model.layout.navBarOccupancy = max(0, bottom)
              model.layoutChanged()
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .transition(.opacity)
          }

          if model.tabBarVisible, !model.webModalOpen {
            NativeTabBar(
              tabs: model.tabs,
              showsMore: !model.more.isEmpty,
              selectedSlot: model.selectedTabSlot,
              onSelect: { model.selectTab($0) },
              onMore: { model.openMore() }
            )
            .onGeometryChange(for: CGFloat.self) { bar in bar.frame(in: .global).minY } action: { top in
              model.layout.tabBarOccupancy = max(0, screenBottom - top)
              model.layoutChanged()
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
          }

          if let reason = model.recoveryReason {
            RecoveryView(
              reason: reason,
              server: model.server,
              onRetry: { model.retry() },
              onChangeServer: { model.open(.serverSettings) }
            )
            .ignoresSafeArea()
          }
        }
        .animation(.snappy(duration: 0.25), value: model.tabBarVisible)
        .animation(.snappy(duration: 0.2), value: model.navBar)
        .animation(.snappy(duration: 0.2), value: model.webModalOpen)
        .onChange(of: proxy.safeAreaInsets, initial: true) { _, insets in
          model.layout.safeArea = Insets(
            top: insets.top, right: insets.trailing, bottom: insets.bottom, left: insets.leading
          )
          model.layoutChanged()
        }
      }
      .ignoresSafeArea(.keyboard)
    }
  }

  private func updateKeyboard(_ note: Notification) {
    guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
      let screen = model.web.webView.window?.screen ?? UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.screen }).first
    else { return }
    model.layout.keyboardHeight = max(0, screen.bounds.maxY - frame.minY)
    model.layoutChanged()
  }
}
