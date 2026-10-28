import Foundation

/// Converts native chrome geometry into the `layout.update` the web maps to
/// `--native-*` CSS variables.
///
/// The web view fills the screen, so CSS `env(safe-area-inset-*)` keeps its
/// browser meaning; `contentInsets` only adds what native chrome covers on top
/// of that. With the floating tab bar visible, the bottom inset is measured
/// from the screen edge to the bar's top, which already includes the home
/// indicator area.
public struct LayoutInput: Equatable, Sendable {
  public var safeArea: Insets
  /// Height of the floating tab bar from screen bottom to its top edge, or 0.
  public var tabBarOccupancy: Double
  public var tabBarVisible: Bool
  public var keyboardHeight: Double

  public init(safeArea: Insets, tabBarOccupancy: Double, tabBarVisible: Bool, keyboardHeight: Double) {
    self.safeArea = safeArea
    self.tabBarOccupancy = tabBarOccupancy
    self.tabBarVisible = tabBarVisible
    self.keyboardHeight = keyboardHeight
  }
}

public struct LayoutOutput: Equatable, Sendable {
  public var contentInsets: Insets
  public var safeArea: Insets
  public var keyboard: Double

  public var message: NativeMessage {
    .layout(contentInsets: contentInsets, safeArea: safeArea, keyboard: keyboard)
  }
}

public enum LayoutCalculator {
  public static func compute(_ input: LayoutInput) -> LayoutOutput {
    let keyboard = max(0, input.keyboardHeight)
    // The tab bar hides while the keyboard is up, so it covers nothing then.
    let barCovers = input.tabBarVisible && keyboard == 0
    let bottom = barCovers ? max(input.tabBarOccupancy, input.safeArea.bottom) : 0
    return LayoutOutput(
      contentInsets: Insets(top: 0, right: 0, bottom: rounded(bottom), left: 0),
      safeArea: input.safeArea,
      keyboard: rounded(keyboard)
    )
  }

  /// Half-point precision avoids re-sending layouts for sub-pixel jitter.
  private static func rounded(_ value: Double) -> Double {
    (value * 2).rounded() / 2
  }
}
