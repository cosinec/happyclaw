import Observation
import UIKit

/// Home-screen quick actions (Info.plist `UIApplicationShortcutItems`). UIKit
/// hands them to the app/scene delegates; ShellModel picks them up from here
/// once the bridge is ready, because a cold launch delivers the action
/// before the web has loaded.
@Observable
final class QuickActionInbox {
  static let shared = QuickActionInbox()

  /// Raw `UIApplicationShortcutItem.type`, cleared once handled.
  var pending: String?
}

enum QuickAction {
  /// Handled by the web (`app.shortcut`): a fresh conversation.
  static let newConversation = "new-conversation"
  /// A plain tab switch (`nav.select`).
  static let tasks = "tasks"
}

final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    configurationForConnecting session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    // Cold launch from a quick action.
    if let item = options.shortcutItem { QuickActionInbox.shared.pending = item.type }
    let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
  /// Quick action while the app is already running.
  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem
  ) async -> Bool {
    QuickActionInbox.shared.pending = shortcutItem.type
    return true
  }
}
