import Foundation

/// The HappyClaw instance the shell loads. Keeps scheme, host, port and an
/// optional base path (for deployments under VITE_BASE_PATH); drops query and
/// fragment so the stored address is canonical.
public struct ServerAddress: Equatable, Sendable, Codable {
  public let url: URL

  public enum ParseError: Error, Equatable {
    case empty
    case invalid
    case unsupportedScheme(String)
  }

  public init(parsing input: String) throws(ParseError) {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .empty }
    let withScheme = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
    guard var components = URLComponents(string: withScheme) else { throw .invalid }
    let scheme = components.scheme?.lowercased() ?? ""
    guard scheme == "http" || scheme == "https" else { throw .unsupportedScheme(scheme) }
    guard let host = components.host, !host.isEmpty, !host.contains(" ") else { throw .invalid }
    components.scheme = scheme
    components.host = host.lowercased()
    components.query = nil
    components.fragment = nil
    components.user = nil
    components.password = nil
    var path = components.path
    if path.isEmpty || !path.hasSuffix("/") { path += "/" }
    components.path = path
    guard let url = components.url else { throw .invalid }
    self.url = url
  }

  /// Display form without trailing slash.
  public var displayString: String {
    let s = url.absoluteString
    return s.hasSuffix("/") ? String(s.dropLast()) : s
  }

  /// Whether `other` belongs to this instance: same scheme, host and port,
  /// and inside the base path.
  public func contains(_ other: URL) -> Bool {
    guard
      other.scheme?.lowercased() == url.scheme,
      other.host?.lowercased() == url.host,
      effectivePort(other) == effectivePort(url)
    else { return false }
    let base = url.path.hasSuffix("/") ? url.path : url.path + "/"
    let path = other.path.isEmpty ? "/" : other.path
    return base == "/" || (path + "/").hasPrefix(base)
  }

  private func effectivePort(_ u: URL) -> Int {
    if let port = u.port { return port }
    return u.scheme?.lowercased() == "https" ? 443 : 80
  }
}
