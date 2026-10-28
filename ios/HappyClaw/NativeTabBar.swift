import HappyClawCore
import SwiftUI
import UIKit

/// Bottom tab bar replacing the web's mobile bottom nav. It is the system
/// UITabBar, so iOS 26 draws the floating Liquid Glass bar with its selection
/// lens, refraction and press feedback, and earlier systems the standard bar;
/// none of that is redrawn here. Items come from the web's `chrome.tabs`
/// declaration; 「更多」 opens the overflow sheet instead of selecting a page.
struct NativeTabBar: UIViewRepresentable {
  let tabs: [TabDeclaration]
  let showsMore: Bool
  let selectedSlot: String?
  /// Re-evaluates the selection when the overflow sheet closes.
  let sheetOpen: Bool
  /// The web palette's accent; nil keeps the app's AccentColor.
  let accent: RGBColor?
  let onSelect: (TabDeclaration) -> Void
  let onMore: () -> Void

  private static let moreTag = -1

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UITabBar {
    let bar = UITabBar()
    bar.delegate = context.coordinator
    bar.itemPositioning = .fill
    return bar
  }

  func updateUIView(_ bar: UITabBar, context: Context) {
    let coordinator = context.coordinator
    coordinator.parent = self
    bar.tintColor = accent.map { UIColor(red: $0.red, green: $0.green, blue: $0.blue, alpha: 1) }

    let signature = tabs.map { "\($0.id)|\($0.title)|\($0.symbol)" } + (showsMore ? ["more"] : [])
    if signature != coordinator.signature {
      coordinator.signature = signature
      var items = tabs.enumerated().map { index, tab in
        UITabBarItem(title: tab.title, image: UIImage(systemName: tab.symbol), tag: index)
      }
      if showsMore {
        items.append(UITabBarItem(title: L10n.tabMore, image: UIImage(systemName: "ellipsis"), tag: Self.moreTag))
      }
      bar.setItems(items, animated: false)
    }

    let tag: Int? =
      if selectedSlot == ShellModel.moreSlot || sheetOpen { Self.moreTag }
      else { tabs.firstIndex { $0.id == selectedSlot } }
    let target = tag.flatMap { tag in bar.items?.first { $0.tag == tag } }
    if bar.selectedItem !== target { bar.selectedItem = target }
  }

  /// UIKit reports the bar's own height for the proposed width, including
  /// the home indicator area when the bar reaches the screen bottom.
  func sizeThatFits(_ proposal: ProposedViewSize, uiView bar: UITabBar, context: Context) -> CGSize? {
    let width = proposal.width ?? bar.window?.bounds.width ?? 390
    let height = bar.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    return CGSize(width: width, height: height)
  }

  final class Coordinator: NSObject, UITabBarDelegate {
    var parent: NativeTabBar?
    var signature: [String] = []

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
      guard let parent else { return }
      if item.tag == NativeTabBar.moreTag {
        parent.onMore()
      } else if parent.tabs.indices.contains(item.tag) {
        parent.onSelect(parent.tabs[item.tag])
      }
    }
  }
}
