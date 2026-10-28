import SwiftUI

@main
struct HappyClawApp: App {
  @State private var model = ShellModel()

  var body: some Scene {
    WindowGroup {
      RootShell(model: model)
    }
  }
}
