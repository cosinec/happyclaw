import HappyClawCore
import SwiftUI

/// Read-only bridge diagnostics for troubleshooting on a real device.
struct DiagnosticsView: View {
  let model: ShellModel

  var body: some View {
    let shell = ShellBuild.info
    List {
      Section {
        row(L10n.diagnosticsShell, "\(shell.version) (\(shell.build)) · iOS \(shell.os)")
        row(L10n.diagnosticsProtocol, "v\(BridgeProtocol.supportedVersions.lowerBound)–v\(BridgeProtocol.supportedVersions.upperBound)")
        row(L10n.diagnosticsState, describe(model.session.state))
        row(L10n.diagnosticsServer, model.server?.displayString ?? "—")
        row(L10n.diagnosticsWebBuild, model.webBuild ?? "—")
        row(L10n.diagnosticsRoute, model.route?.path ?? "—")
        row(L10n.diagnosticsLastError, model.lastError ?? "—")
      }
      Section {
        Button(L10n.diagnosticsReload) { model.retry() }
      }
    }
    .navigationTitle(L10n.diagnosticsTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.visible, for: .navigationBar)
  }

  private func row(_ label: String, _ value: String) -> some View {
    LabeledContent(label) {
      Text(value).textSelection(.enabled).multilineTextAlignment(.trailing)
    }
  }

  private func describe(_ state: BridgeSession.State) -> String {
    switch state {
    case .webNavigation: "webNavigation"
    case .negotiating: "negotiating"
    case let .prepared(session, version): "prepared v\(version) · \(session.prefix(8))"
    case let .nativeNavigation(session, version): "nativeNavigation v\(version) · \(session.prefix(8))"
    case let .recovery(reason): "recovery · \(reason)"
    }
  }
}
