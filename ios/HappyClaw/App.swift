import SwiftUI

@main
struct HappyClawApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var model = ShellModel()

  var body: some Scene {
    WindowGroup {
      RootShell(model: model)
    }
  }
}
