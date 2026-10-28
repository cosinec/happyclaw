import HappyClawCore
import SwiftUI

/// Shown over the placeholder background while a top-level load is still
/// running after a short delay, so a slow or unreachable server never looks
/// like a blank screen. The load timeout then hands over to RecoveryView.
struct ConnectingView: View {
  let server: ServerAddress?

  var body: some View {
    VStack(spacing: 12) {
      ProgressView()
        .controlSize(.large)
      Text(L10n.connecting)
        .font(.headline)
      if let server {
        Text(server.displayString)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
  }
}
