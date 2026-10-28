import HappyClawCore
import Observation
import SwiftUI

/// Native alert for the web's `confirmDialog()`. One request at a time: a new
/// request cancels the previous one, matching the web confirm store.
@Observable
final class ConfirmBridge {
  struct Pending: Identifiable {
    let id: String
    let request: ConfirmRequest
  }

  private(set) var pending: Pending?
  @ObservationIgnored var respond: (String, Bool) -> Void = { _, _ in }

  func present(id: String, _ request: ConfirmRequest) {
    if let previous = pending { respond(previous.id, false) }
    pending = Pending(id: id, request: request)
  }

  func resolve(_ confirmed: Bool) {
    guard let current = pending else { return }
    pending = nil
    respond(current.id, confirmed)
  }

  /// Bridge went away (new document, recovery): settle without answering.
  func discard() { pending = nil }
}

private struct ConfirmBridgeModifier: ViewModifier {
  @Bindable var bridge: ConfirmBridge

  func body(content: Content) -> some View {
    let isPresented = Binding(
      get: { bridge.pending != nil },
      set: { if !$0 { bridge.resolve(false) } }
    )
    content.alert(
      bridge.pending?.request.title ?? "",
      isPresented: isPresented,
      presenting: bridge.pending
    ) { pending in
      Button(pending.request.cancelText, role: .cancel) { bridge.resolve(false) }
      Button(pending.request.confirmText, role: pending.request.destructive ? .destructive : nil) {
        bridge.resolve(true)
      }
    } message: { pending in
      Text(pending.request.message)
    }
  }
}

extension View {
  func confirmBridge(_ bridge: ConfirmBridge) -> some View {
    modifier(ConfirmBridgeModifier(bridge: bridge))
  }
}
