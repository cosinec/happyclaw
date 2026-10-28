import Foundation

/// One HappyClaw instance the shell can connect to. Each keeps its own web
/// data (cookies, local storage), so switching never mixes logins.
public struct ServerInstance: Codable, Equatable, Sendable, Identifiable {
  public enum DataStore: Codable, Equatable, Sendable {
    /// WebKit's default store: the single address saved before instances
    /// existed keeps its login after the upgrade.
    case shared
    /// `WKWebsiteDataStore(forIdentifier:)`.
    case isolated(UUID)
  }

  public let id: UUID
  public var address: ServerAddress
  public let dataStore: DataStore

  public init(id: UUID = UUID(), address: ServerAddress, dataStore: DataStore) {
    self.id = id
    self.address = address
    self.dataStore = dataStore
  }
}

/// Saved instances and the active one. Pure value logic; persistence and
/// WebKit stores live in the app target.
public struct ServerRegistry: Codable, Equatable, Sendable {
  public private(set) var instances: [ServerInstance] = []
  public private(set) var activeID: UUID?

  public init() {}

  /// Migrates the pre-instance single address (if any) onto the shared store.
  public init(legacyAddress: ServerAddress?) {
    if let legacyAddress {
      let instance = ServerInstance(address: legacyAddress, dataStore: .shared)
      instances = [instance]
      activeID = instance.id
    }
  }

  public var active: ServerInstance? {
    instances.first { $0.id == activeID }
  }

  public func instance(for address: ServerAddress) -> ServerInstance? {
    instances.first { $0.address == address }
  }

  /// The existing instance for this address, or a new isolated one; either
  /// way it becomes active. An address is never stored twice.
  @discardableResult
  public mutating func activate(_ address: ServerAddress) -> ServerInstance {
    if let existing = instance(for: address) {
      activeID = existing.id
      return existing
    }
    let id = UUID()
    let instance = ServerInstance(id: id, address: address, dataStore: .isolated(id))
    instances.append(instance)
    activeID = id
    return instance
  }

  /// Switches to a saved instance. Unknown ids are ignored.
  public mutating func select(_ id: UUID) {
    guard instances.contains(where: { $0.id == id }) else { return }
    activeID = id
  }

  /// Removes an instance that is not active and returns it so the caller can
  /// delete its web data. The active one must be switched away from first.
  @discardableResult
  public mutating func remove(_ id: UUID) -> ServerInstance? {
    guard id != activeID, let index = instances.firstIndex(where: { $0.id == id }) else { return nil }
    return instances.remove(at: index)
  }
}
