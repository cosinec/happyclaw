import Foundation
import HappyClawCore

/// Persists the saved servers (ServerRegistry) in UserDefaults.
///
/// The single `serverURL` saved before instances existed migrates onto
/// WebKit's shared store, so its login survives. `HAPPYCLAW_SERVER_URL` in the
/// launch environment (install-device.sh, simulator runs) is added if new and
/// made active, so a later cold start from the home screen reaches it too.
enum ServerStore {
  private static let key = "servers.v1"
  private static let legacyKey = "serverURL"

  static func load() -> ServerRegistry {
    var registry: ServerRegistry
    if let data = UserDefaults.standard.data(forKey: key),
      let decoded = try? JSONDecoder().decode(ServerRegistry.self, from: data)
    {
      registry = decoded
    } else {
      let legacy = UserDefaults.standard.string(forKey: legacyKey).flatMap { try? ServerAddress(parsing: $0) }
      registry = ServerRegistry(legacyAddress: legacy)
    }
    if let override = ProcessInfo.processInfo.environment["HAPPYCLAW_SERVER_URL"],
      let address = try? ServerAddress(parsing: override)
    {
      registry.activate(address)
    }
    save(registry)
    return registry
  }

  static func save(_ registry: ServerRegistry) {
    guard let data = try? JSONEncoder().encode(registry) else { return }
    UserDefaults.standard.set(data, forKey: key)
    UserDefaults.standard.removeObject(forKey: legacyKey)
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
