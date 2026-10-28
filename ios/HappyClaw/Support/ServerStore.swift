import Foundation
import HappyClawCore

/// Persists the instance address. `HAPPYCLAW_SERVER_URL` in the launch
/// environment overrides it, so simulator runs and UI tests can point at a
/// dev server without touching saved settings.
enum ServerStore {
  private static let key = "serverURL"

  static func load() -> ServerAddress? {
    if let override = ProcessInfo.processInfo.environment["HAPPYCLAW_SERVER_URL"],
      let address = try? ServerAddress(parsing: override)
    {
      return address
    }
    guard let saved = UserDefaults.standard.string(forKey: key) else { return nil }
    return try? ServerAddress(parsing: saved)
  }

  static func save(_ address: ServerAddress) {
    UserDefaults.standard.set(address.url.absoluteString, forKey: key)
  }
}

enum ShellBuild {
  static var info: ShellInfo {
    let bundle = Bundle.main
    return ShellInfo(
      version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
      build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
      os: ProcessInfo.processInfo.operatingSystemVersionString
    )
  }
}
