import HappyClawCore
import Observation
import SwiftUI

/// Native action menu for a web `menu.request`. The web declares already
/// permission-filtered items; the selected id goes back and the web runs the
/// business action itself.
@Observable
final class MenuBridge {
  struct Pending: Identifiable {
    let id: String
    let request: MenuRequest
  }

  private(set) var pending: Pending?
  @ObservationIgnored var respond: (String, String?) -> Void = { _, _ in }

  func present(id: String, _ request: MenuRequest) {
    if let previous = pending { respond(previous.id, nil) }
    pending = Pending(id: id, request: request)
  }

  func resolve(_ selected: String?) {
    guard let current = pending else { return }
    pending = nil
    respond(current.id, selected)
  }

  func discard() { pending = nil }
}

private struct MenuBridgeModifier: ViewModifier {
  @Bindable var bridge: MenuBridge

  func body(content: Content) -> some View {
    let isPresented = Binding(
      get: { bridge.pending != nil },
      set: { if !$0 { bridge.resolve(nil) } }
    )
    content.confirmationDialog(
      bridge.pending?.request.title ?? "",
      isPresented: isPresented,
      titleVisibility: bridge.pending?.request.title == nil ? .hidden : .visible,
      presenting: bridge.pending
    ) { pending in
      ForEach(pending.request.items) { item in
        Button(item.title, role: item.destructive == true ? .destructive : nil) {
          bridge.resolve(item.id)
        }
        .disabled(item.disabled == true)
      }
      Button(L10n.cancel, role: .cancel) { bridge.resolve(nil) }
    } message: { pending in
      if let message = pending.request.message { Text(message) }
    }
  }
}

extension View {
  func menuBridge(_ bridge: MenuBridge) -> some View {
    modifier(MenuBridgeModifier(bridge: bridge))
  }
}
