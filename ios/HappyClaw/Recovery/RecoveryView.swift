import HappyClawCore
import SwiftUI

/// Shown instead of the web view when it cannot be used: the server is
/// unreachable, the web build is protocol-incompatible, or the content
/// process keeps dying. Never a blank page, never half-native chrome.
struct RecoveryView: View {
  let reason: BridgeSession.RecoveryReason
  let server: ServerAddress?
  let onRetry: () -> Void
  let onChangeServer: () -> Void

  var body: some View {
    VStack(spacing: 16) {
      Spacer()
      Image(systemName: symbol)
        .font(.system(size: 48))
        .foregroundStyle(.secondary)
      Text(title)
        .font(.title3.weight(.semibold))
        .multilineTextAlignment(.center)
      Text(message)
        .font(.callout)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      if let server {
        Text(server.displayString)
          .font(.footnote.monospaced())
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
      }
      Spacer()
      VStack(spacing: 10) {
        Button(action: onRetry) {
          Text(L10n.recoveryRetry).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        Button(L10n.recoveryChangeServer, action: onChangeServer)
          .controlSize(.large)
      }
    }
    .padding(.horizontal, 32)
    .padding(.vertical, 48)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemBackground))
  }

  private var symbol: String {
    switch reason {
    case .unreachable: "wifi.exclamationmark"
    case .incompatible: "arrow.triangle.2.circlepath"
    case .contentProcessLost: "exclamationmark.triangle"
    }
  }

  private var title: String {
    switch reason {
    case .unreachable: L10n.recoveryUnreachableTitle
    case .incompatible: L10n.recoveryIncompatibleTitle
    case .contentProcessLost: L10n.recoveryProcessTitle
    }
  }

  private var message: String {
    switch reason {
    case let .unreachable(description): description
    case .incompatible: L10n.recoveryIncompatibleMessage
    case .contentProcessLost: L10n.recoveryProcessMessage
    }
  }
}
