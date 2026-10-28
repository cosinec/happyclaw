// swift-tools-version: 6.0
// Platform-independent core of the HappyClaw iOS shell: bridge protocol,
// handshake state machine, server address and link policy, layout math.
// Kept free of UIKit/WebKit so `swift test` runs on macOS without a simulator.
import PackageDescription

let package = Package(
  name: "HappyClawCore",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "HappyClawCore", targets: ["HappyClawCore"])],
  targets: [
    .target(name: "HappyClawCore"),
    .testTarget(name: "HappyClawCoreTests", dependencies: ["HappyClawCore"]),
  ],
  swiftLanguageModes: [.v6]
)
