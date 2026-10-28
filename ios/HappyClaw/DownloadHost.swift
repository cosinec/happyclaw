import OSLog
import SwiftUI
import UIKit
import WebKit

/// Receives WKDownloads (the web's `<a download>` on blob: URLs, attachment
/// responses) into a private temporary folder and hands the finished file to
/// the system share sheet: save to Files or Photos, AirDrop, open in another
/// app. Without this WKWebView drops those downloads silently.
final class DownloadHost: NSObject, WKDownloadDelegate {
  var onFinished: (URL) -> Void = { _ in }
  var onFailed: (String) -> Void = { _ in }

  private var destinations: [ObjectIdentifier: URL] = [:]
  private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "HappyClaw", category: "download")

  private static var root: URL {
    FileManager.default.temporaryDirectory.appending(path: "downloads", directoryHint: .isDirectory)
  }

  func download(
    _ download: WKDownload,
    decideDestinationUsing response: URLResponse,
    suggestedFilename: String
  ) async -> URL? {
    // One folder per download keeps the web's filename intact without
    // colliding with an earlier file of the same name.
    let folder = Self.root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    } catch {
      Self.log.error("download folder: \(error.localizedDescription, privacy: .public)")
      return nil
    }
    let name = Self.sanitized(suggestedFilename)
    let destination = folder.appending(path: name, directoryHint: .notDirectory)
    destinations[ObjectIdentifier(download)] = destination
    return destination
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let file = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
    onFinished(file)
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    if let file = destinations.removeValue(forKey: ObjectIdentifier(download)) {
      Self.remove(file)
    }
    Self.log.error("download failed: \(error.localizedDescription, privacy: .public)")
    onFailed(error.localizedDescription)
  }

  /// Delete a shared file and its per-download folder once the sheet closes.
  static func remove(_ file: URL) {
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  /// Leftovers from a previous run (the app may be killed mid-share).
  static func purge() {
    try? FileManager.default.removeItem(at: root)
  }

  private static func sanitized(_ name: String) -> String {
    let cleaned = name
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: ":", with: "_")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty || cleaned.hasPrefix(".") ? "download" + cleaned : cleaned
  }
}

/// UIActivityViewController for a downloaded file.
struct ShareSheet: UIViewControllerRepresentable {
  let file: URL

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [file], applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
