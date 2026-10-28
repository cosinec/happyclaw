import CoreGraphics
import HappyClawCore
import Observation

/// Collects native chrome geometry and emits `layout.update` only when the
/// computed insets actually change.
@Observable
final class LayoutBridge {
  var safeArea: Insets = .zero
  /// Distance from the screen bottom to the floating tab bar's top edge.
  var tabBarOccupancy: Double = 0
  var keyboardHeight: Double = 0

  @ObservationIgnored private var lastSent: LayoutOutput?

  func output(tabBarVisible: Bool) -> LayoutOutput {
    LayoutCalculator.compute(
      LayoutInput(
        safeArea: safeArea,
        tabBarOccupancy: tabBarOccupancy,
        tabBarVisible: tabBarVisible,
        keyboardHeight: keyboardHeight
      )
    )
  }

  /// The message to send, or nil when the web already has this layout.
  func pendingUpdate(tabBarVisible: Bool, force: Bool = false) -> NativeMessage? {
    let next = output(tabBarVisible: tabBarVisible)
    if !force, next == lastSent { return nil }
    lastSent = next
    return next.message
  }

  func reset() { lastSent = nil }
}
