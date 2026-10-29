import HappyClawCore
import SwiftUI

/// Top navigation bar for screens the web declares in `route.changed.nav`.
///
/// The bar floats over the page: the web keeps `--native-top` free above its
/// first row but lets content scroll beneath, where a material fading into
/// the page color softens it (status bar included), as iOS does at a
/// scroll edge. A leading back or menu button, the title, and up to a few
/// trailing buttons grouped in one capsule; on iOS 26+ the buttons are Liquid
/// Glass, earlier plain symbols. A trailing button that carries a menu opens
/// it as a system menu straight from the button.
struct NativeNavBar: View {
  let state: NavBarState
  let background: RGBColor?
  let onBack: () -> Void
  let onMenu: () -> Void
  let onAction: (_ action: NavBarState.Action, _ item: String?) -> Void

  static let height: CGFloat = 44
  private static let buttonSize: CGFloat = 40

  var body: some View {
    let trailing = state.trailing
    ZStack {
      if let title = state.title {
        Text(title)
          .font(.headline)
          .lineLimit(1)
          // Clear of the widest side so the title stays centred.
          .padding(.horizontal, 24 + Self.buttonSize * CGFloat(max(1, trailing.count)))
          .accessibilityAddTraits(.isHeader)
      }
      HStack(spacing: 8) {
        if state.back {
          circleButton(symbol: "chevron.backward", label: L10n.navBack, action: onBack)
        } else if state.menu == true {
          circleButton(symbol: "line.3.horizontal", label: L10n.navMenu, action: onMenu)
        }
        Spacer(minLength: 0)
        if !trailing.isEmpty {
          HStack(spacing: 0) {
            ForEach(trailing, id: \.id) { action in
              trailingButton(action)
            }
          }
          .modifier(GlassBackground(shape: Capsule()))
        }
      }
      .padding(.horizontal, 16)
    }
    .frame(height: Self.height)
    .frame(maxWidth: .infinity)
    .background(alignment: .top) { EdgeFade(color: background) }
  }

  private func icon(_ symbol: String) -> some View {
    Image(systemName: symbol)
      .font(.system(size: 17, weight: .semibold))
      .frame(width: Self.buttonSize, height: Self.buttonSize)
      .contentShape(Rectangle())
  }

  private func circleButton(symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { icon(symbol) }
      .buttonStyle(.plain)
      .foregroundStyle(Color.primary)
      .modifier(GlassBackground(shape: Circle()))
      .accessibilityLabel(label)
  }

  @ViewBuilder
  private func trailingButton(_ action: NavBarState.Action) -> some View {
    if let items = action.menu, !items.isEmpty {
      Menu {
        NavMenuItems(items: items) { onAction(action, $0) }
      } label: {
        icon(action.symbol)
      }
      .foregroundStyle(Color.primary)
      .accessibilityLabel(action.title)
    } else {
      Button { onAction(action, nil) } label: { icon(action.symbol) }
        .buttonStyle(.plain)
        .foregroundStyle(Color.primary)
        .accessibilityLabel(action.title)
    }
  }
}

/// Declared menu items as SwiftUI menu content: inline groups become
/// sections, other groups submenus.
private struct NavMenuItems: View {
  let items: [MenuItemDeclaration]
  let select: (String) -> Void

  var body: some View {
    ForEach(items) { item in
      if let children = item.children {
        if item.inline == true, item.title.isEmpty {
          Section { NavMenuItems(items: children, select: select) }
        } else if item.inline == true {
          Section(item.title) { NavMenuItems(items: children, select: select) }
        } else {
          Menu {
            NavMenuItems(items: children, select: select)
          } label: {
            label(for: item)
          }
        }
      } else {
        Button(role: item.destructive == true ? .destructive : nil) {
          select(item.id)
        } label: {
          label(for: item)
        }
        .disabled(item.disabled == true)
      }
    }
  }

  @ViewBuilder
  private func label(for item: MenuItemDeclaration) -> some View {
    if item.checked == true {
      Label(item.title, systemImage: "checkmark")
    } else if let symbol = item.symbol {
      Label(item.title, systemImage: symbol)
    } else {
      Text(item.title)
    }
  }
}

private struct GlassBackground<S: Shape>: ViewModifier {
  let shape: S

  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content.glassEffect(.regular.interactive(), in: shape)
    } else {
      content
    }
  }
}

/// The page color over a blur, solid behind the status bar and fading out a
/// little below the bar, so content scrolling under it stays legible.
private struct EdgeFade: View {
  let color: RGBColor?

  var body: some View {
    let page = color.map { Color(red: $0.red, green: $0.green, blue: $0.blue) } ?? Color(uiColor: .systemBackground)
    ZStack {
      Rectangle().fill(.ultraThinMaterial)
      page.opacity(0.72)
    }
    .mask {
      LinearGradient(
        stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.55), .init(color: .clear, location: 1)],
        startPoint: .top,
        endPoint: .bottom
      )
    }
    .padding(.bottom, -16)
    .ignoresSafeArea(edges: .top)
    .allowsHitTesting(false)
  }
}
