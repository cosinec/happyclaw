import HappyClawCore
import SwiftUI

/// Floating capsule tab bar replacing the web's mobile bottom nav. Items come
/// from the web's `chrome.tabs` declaration; 「更多」 opens the overflow sheet.
/// iOS 26+ renders with Liquid Glass, earlier systems with a material.
struct NativeTabBar: View {
  let tabs: [TabDeclaration]
  let showsMore: Bool
  let selectedSlot: String?
  let onSelect: (TabDeclaration) -> Void
  let onMore: () -> Void

  var body: some View {
    HStack(spacing: 2) {
      ForEach(tabs) { tab in
        item(title: tab.title, symbol: tab.symbol, selected: selectedSlot == tab.id) { onSelect(tab) }
      }
      if showsMore {
        item(title: L10n.tabMore, symbol: "ellipsis.circle", selected: selectedSlot == ShellModel.moreSlot, action: onMore)
      }
    }
    .padding(6)
    .modifier(TabBarBackground())
    .padding(.bottom, 4)
  }

  private func item(title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 2) {
        Image(systemName: symbol)
          .font(.system(size: 18, weight: selected ? .semibold : .regular))
          .frame(height: 22)
        Text(title)
          .font(.system(size: 10, weight: selected ? .semibold : .regular))
          .lineLimit(1)
      }
      .foregroundStyle(selected ? Color.primary : Color.secondary)
      .frame(width: 60, height: 46)
      .background {
        if selected {
          Capsule().fill(Color.primary.opacity(0.08))
        }
      }
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
  }
}

private struct TabBarBackground: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content.glassEffect(.regular.interactive(), in: .capsule)
    } else {
      content
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }
  }
}
