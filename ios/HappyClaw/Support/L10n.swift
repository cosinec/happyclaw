import Foundation

/// Every user-visible native string. This round ships Chinese only; keys are
/// stable so a String Catalog can add languages without touching call sites.
enum L10n {
  private static func t(_ key: String.LocalizationValue) -> String { String(localized: key) }

  static let appName = "HappyClaw"

  // Connect
  static var connectTitle: String { t("connect.title") }
  static var connectHeadline: String { t("connect.headline") }
  static var connectFieldLabel: String { t("connect.field") }
  static var connectFieldPlaceholder: String { "http://192.168.1.10:5173" }
  static var connectFooter: String { t("connect.footer") }
  static var connectButton: String { t("connect.button") }
  static var connectSaveButton: String { t("connect.save") }
  static var connectErrorEmpty: String { t("connect.error.empty") }
  static var connectErrorInvalid: String { t("connect.error.invalid") }
  static var connectErrorScheme: String { t("connect.error.scheme") }
  static var connecting: String { t("connecting") }
  static var connectTimeout: String { t("connect.timeout") }

  // Tabs / sheets
  static var tabMore: String { t("tab.more") }
  static var navBack: String { t("nav.back") }

  // Servers
  static var serverListTitle: String { t("server.list.title") }
  static var serverListFooter: String { t("server.list.footer") }
  static var serverAdd: String { t("server.add") }
  static var serverCurrent: String { t("server.current") }
  static var serverRemove: String { t("server.remove") }
  static var serverRemoveTitle: String { t("server.remove.title") }
  static var serverRemoveMessage: String { t("server.remove.message") }
  static var downloadFailed: String { t("download.failed") }
  static var moreTitle: String { t("more.title") }
  static var morePagesSection: String { t("more.pages") }
  static var moreAppSection: String { t("more.app") }
  static var moreServer: String { t("more.server") }
  static var moreDiagnostics: String { t("more.diagnostics") }
  static var done: String { t("common.done") }
  static var cancel: String { t("common.cancel") }
  static var ok: String { t("common.ok") }

  // Recovery
  static var recoveryUnreachableTitle: String { t("recovery.unreachable.title") }
  static var recoveryIncompatibleTitle: String { t("recovery.incompatible.title") }
  static var recoveryIncompatibleMessage: String { t("recovery.incompatible.message") }
  static var recoveryProcessTitle: String { t("recovery.process.title") }
  static var recoveryProcessMessage: String { t("recovery.process.message") }
  static var recoveryRetry: String { t("recovery.retry") }
  static var recoveryChangeServer: String { t("recovery.changeServer") }

  // Diagnostics
  static var diagnosticsTitle: String { t("diagnostics.title") }
  static var diagnosticsShell: String { t("diagnostics.shell") }
  static var diagnosticsProtocol: String { t("diagnostics.protocol") }
  static var diagnosticsState: String { t("diagnostics.state") }
  static var diagnosticsServer: String { t("diagnostics.server") }
  static var diagnosticsRoute: String { t("diagnostics.route") }
  static var diagnosticsWebBuild: String { t("diagnostics.webBuild") }
  static var diagnosticsLastError: String { t("diagnostics.lastError") }
  static var diagnosticsReload: String { t("diagnostics.reload") }
}
