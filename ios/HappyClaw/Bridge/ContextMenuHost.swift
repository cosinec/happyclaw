import HappyClawCore
import UIKit

/// Native long-press menus over the web view.
///
/// One UIContextMenuInteraction sits on the whole WKWebView. When a finger
/// lands on an element that has a menu, the web sends `contextmenu.offer`
/// (its rect and items). If the long press that follows lands inside that
/// rect while the offer is fresh, the system menu appears with a snapshot of
/// the element lifted as the preview; otherwise this returns nil and WebKit
/// handles the press as usual. The choice is reported only after the menu
/// has finished closing, so a follow-up (a delete confirmation) does not
/// fight the dismissal animation.
final class ContextMenuHost: NSObject, UIContextMenuInteractionDelegate {
  weak var webView: UIView?
  var onSelect: (_ token: String, _ itemId: String) -> Void = { _, _ in }

  private var offer: (value: ContextMenuOffer, receivedAt: Date)?
  private var selection: (token: String, itemId: String)?
  /// The on-screen part of the element whose menu is showing.
  private var presentedRect: CGRect?

  /// A touch-down offer older than this belongs to an earlier gesture.
  private static let freshness: TimeInterval = 2
  /// Fingers drift a little during a long press.
  private static let slop: Double = 12

  func receive(_ offer: ContextMenuOffer) {
    self.offer = (offer, Date())
  }

  func reset() {
    offer = nil
    selection = nil
    presentedRect = nil
  }

  // MARK: UIContextMenuInteractionDelegate

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let current = offer?.value,
      let receivedAt = offer?.receivedAt,
      Date().timeIntervalSince(receivedAt) < Self.freshness,
      !current.items.isEmpty,
      current.rect.contains(x: location.x, y: location.y, slop: Self.slop),
      let bounds = webView?.bounds
    else { return nil }
    offer = nil
    selection = nil
    // A long reply can be taller than the screen; lift only what is visible.
    let rect = CGRect(x: current.rect.x, y: current.rect.y, width: current.rect.width, height: current.rect.height)
      .intersection(bounds)
    presentedRect = rect.isNull || rect.isEmpty ? nil : rect
    return UIContextMenuConfiguration(identifier: current.token as NSString, previewProvider: nil) { [weak self] _ in
      self?.menu(for: current)
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configuration: UIContextMenuConfiguration,
    highlightPreviewForItemWithIdentifier identifier: any NSCopying
  ) -> UITargetedPreview? {
    preview(for: configuration)
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configuration: UIContextMenuConfiguration,
    dismissalPreviewForItemWithIdentifier identifier: any NSCopying
  ) -> UITargetedPreview? {
    preview(for: configuration)
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    let deliver = { [weak self] in
      guard let self, let selection = self.selection else { return }
      self.selection = nil
      self.onSelect(selection.token, selection.itemId)
    }
    if let animator { animator.addCompletion(deliver) } else { deliver() }
  }

  // MARK: Building

  private func menu(for offer: ContextMenuOffer) -> UIMenu {
    let actions = offer.items.map { item in
      var attributes: UIMenuElement.Attributes = []
      if item.destructive == true { attributes.insert(.destructive) }
      if item.disabled == true { attributes.insert(.disabled) }
      return UIAction(
        title: item.title,
        image: item.symbol.flatMap { UIImage(systemName: $0) },
        attributes: attributes
      ) { [weak self] _ in
        self?.selection = (offer.token, item.id)
      }
    }
    return UIMenu(title: offer.title ?? "", children: actions)
  }

  /// The pressed element, lifted: a snapshot of exactly its visible rect.
  private func preview(for configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
    guard let webView, let rect = presentedRect,
      let snapshot = webView.resizableSnapshotView(
        from: rect, afterScreenUpdates: false, withCapInsets: .zero)
    else { return nil }
    let parameters = UIPreviewParameters()
    parameters.visiblePath = UIBezierPath(roundedRect: snapshot.bounds, cornerRadius: 16)
    return UITargetedPreview(
      view: snapshot,
      parameters: parameters,
      target: UIPreviewTarget(container: webView, center: CGPoint(x: rect.midX, y: rect.midY))
    )
  }
}
