import HappyClawCore
import SwiftUI

/// Top navigation bar for screens the web declares in `route.changed.nav`.
/// The web pads its root by `--native-top`, so normally nothing is beneath
/// the bar; it still paints the page color (status bar included) because the
/// keyboard can scroll the whole document up under it. Buttons use Liquid
/// Glass on iOS 26+, plain symbols earlier.
struct NativeNavBar: View {
  let state: NavBarState
  let background: RGBColor?
  let onBack: () -> Void
  let onAction: (NavBarState.Action) -> Void

  static let height: CGFloat = 44

  var body: some View {
    ZStack {
      if let title = state.title {
        Text(title)
          .font(.headline)
          .lineLimit(1)
          .padding(.horizontal, 64)
          .accessibilityAddTraits(.isHeader)
      }
      HStack {
        if state.back {
          button(symbol: "chevron.backward", label: L10n.navBack, action: onBack)
        }
        Spacer(minLength: 0)
        if let action = state.action {
          button(symbol: action.symbol, label: action.title) { onAction(action) }
        }
      }
      .padding(.horizontal, 12)
    }
    .frame(height: Self.height)
    .frame(maxWidth: .infinity)
    .background {
      if let background {
        Color(red: background.red, green: background.green, blue: background.blue)
          .ignoresSafeArea(edges: .top)
      } else {
        Rectangle().fill(.bar).ignoresSafeArea(edges: .top)
      }
    }
  }

  private func button(symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 17, weight: .semibold))
        .frame(width: 40, height: 40)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.primary)
    .modifier(NavButtonBackground())
    .accessibilityLabel(label)
  }
}

private struct NavButtonBackground: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content.glassEffect(.regular.interactive(), in: .circle)
    } else {
      content
    }
  }
}
