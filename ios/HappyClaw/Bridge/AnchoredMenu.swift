import HappyClawCore
import UIKit

/// System menus opened from a web control (`menu.request` with `anchor`).
///
/// An invisible button is placed exactly over the web control, given the
/// declared menu and asked to perform its primary action, so iOS presents a
/// real UIMenu from that spot (Liquid Glass on iOS 26, sections, checkmarks,
/// submenus). The choice, or nil when dismissed, is reported once the menu
/// has finished closing; the button is then removed.
final class AnchoredMenuPresenter {
  weak var host: UIView?
  var respond: (_ requestId: String, _ selected: String?) -> Void = { _, _ in }

  private var current: (id: String, button: AnchorButton)?

  /// `performPrimaryAction()` opening a button's menu needs iOS 17.4.
  static var isAvailable: Bool {
    if #available(iOS 17.4, *) { return true }
    return false
  }

  /// Returns false when this presentation is unavailable; the caller then
  /// falls back to the action sheet.
  func present(id: String, _ request: MenuRequest) -> Bool {
    guard #available(iOS 17.4, *), let host, let anchor = request.anchor else { return false }
    finish(selected: nil)

    // iOS 26 grows a button's menu out of the button itself, covering it.
    // The stand-in is a sliver under the web control, so the menu opens
    // below it and the control stays visible.
    let button = AnchorButton(frame: CGRect(x: anchor.x, y: anchor.y + anchor.height + 4, width: anchor.width, height: 2))
    button.accessibilityElementsHidden = true
    button.showsMenuAsPrimaryAction = true
    button.menu = UIMenu(
      title: request.title ?? "",
      children: request.items.map { element(for: $0, button: button) }
    )
    button.onEnd = { [weak self, weak button] in
      guard let self, let button, self.current?.button === button else { return }
      self.finish(selected: button.selection)
    }
    host.addSubview(button)
    current = (id, button)
    button.performPrimaryAction()
    return true
  }

  /// A new document or server: drop the menu without answering.
  func discard() {
    current?.button.removeFromSuperview()
    current = nil
  }

  private func finish(selected: String?) {
    guard let (id, button) = current else { return }
    current = nil
    button.removeFromSuperview()
    respond(id, selected)
  }

  private func element(for item: MenuItemDeclaration, button: AnchorButton) -> UIMenuElement {
    let image = item.symbol.flatMap { UIImage(systemName: $0) }
    if let children = item.children {
      var options: UIMenu.Options = item.inline == true ? .displayInline : []
      // A radio group: the parent row shows the current choice.
      if children.contains(where: { $0.checked != nil }) { options.insert(.singleSelection) }
      let menu = UIMenu(
        title: item.title,
        image: image,
        options: options,
        children: children.map { element(for: $0, button: button) }
      )
      if item.inline != true { menu.subtitle = children.first { $0.checked == true }?.title }
      return menu
    }
    var attributes: UIMenuElement.Attributes = []
    if item.destructive == true { attributes.insert(.destructive) }
    if item.disabled == true { attributes.insert(.disabled) }
    return UIAction(
      title: item.title,
      image: image,
      attributes: attributes,
      state: item.checked == true ? .on : .off
    ) { [weak button] _ in
      button?.selection = item.id
    }
  }
}

/// Transparent stand-in for the web control; reports when its menu closed.
private final class AnchorButton: UIButton {
  var selection: String?
  var onEnd: () -> Void = {}

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    if let animator { animator.addCompletion(onEnd) } else { onEnd() }
  }
}
