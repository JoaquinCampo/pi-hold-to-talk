// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "pi-hold-to-talk-helper",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "pi-hold-to-talk-helper", targets: ["HoldToTalkHelper"]),
    ],
    dependencies: [
        // Pinned to an exact commit: FluidAudio moves quickly and these APIs are young.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "a00964e"),
    ],
    targets: [
        .executableTarget(
            name: "HoldToTalkHelper",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
