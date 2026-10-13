import CoreGraphics

/// Watches the physical Space key while listening. Terminals do not report key releases, so
/// without this the extension can only guess that Space was let go once its auto-repeat stops.
enum SpaceKey {
    /// `kVK_Space` from Carbon's HIToolbox.
    private static let keyCode: CGKeyCode = 49

    static func isDown() -> Bool {
        CGEventSource.keyState(.combinedSessionState, key: keyCode)
    }

    /// Calls `onRelease` once Space goes up, provided it was seen down first. Seeing it down
    /// guards against systems where key state is unreadable (it then always reads as up):
    /// in that case nothing is reported and the extension's own release timer applies.
    static func watch(onRelease: @escaping @Sendable () -> Void) -> Task<Void, Never> {
        Task {
            var seenDown = false
            while !Task.isCancelled {
                if isDown() {
                    seenDown = true
                } else if seenDown {
                    onRelease()
                    return
                }
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
    }
}
