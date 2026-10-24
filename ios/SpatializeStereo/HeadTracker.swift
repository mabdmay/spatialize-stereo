import Combine
import CoreMotion
import Foundation

/// Reads the AirPods IMU and publishes head pose relative to a captured
/// reference frame.
///
/// `AVAudioEnvironmentNode` can do this itself via `isListenerHeadTrackingEnabled`,
/// but that property requires the `com.apple.developer.coremotion.head-pose`
/// entitlement, which Apple does not grant to ordinary development accounts.
/// Driving the listener by hand from `CMHeadphoneMotionManager` needs only
/// `NSMotionUsageDescription`, so it works on a free Apple ID.
@MainActor
final class HeadTracker: ObservableObject {

    enum Mode: String, CaseIterable, Identifiable {
        /// No rotation. The rig rides with the head, like ordinary stereo.
        case off = "Off"
        /// Rotate against head motion, so the speaker stays put in the room.
        case headTracked = "Head tracked"
        /// Freeze at the current pose: a stable image that ignores the IMU.
        case fixed = "Fixed"

        var id: String { rawValue }
    }

    @Published private(set) var yaw: Double = 0      // degrees, + is turning right
    @Published private(set) var pitch: Double = 0    // degrees, + is looking up
    @Published private(set) var roll: Double = 0     // degrees
    @Published private(set) var isConnected = false
    @Published private(set) var status = "Not started"

    @Published var mode: Mode = .headTracked {
        didSet { if mode == .off { zero() } }
    }

    /// Set when the measured yaw sign runs backwards for a given headphone.
    @Published var invertYaw = false

    private let manager = CMHeadphoneMotionManager()
    private var reference: CMAttitude?

    var isAvailable: Bool { manager.isDeviceMotionAvailable }

    func start() {
        guard manager.isDeviceMotionAvailable else {
            status = "These headphones have no motion sensors."
            return
        }
        guard !manager.isDeviceMotionActive else { return }

        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .denied, .restricted:
            status = "Motion access is off. Enable it in Settings \u{203a} Privacy \u{203a} Motion & Fitness."
            return
        default:
            break
        }

        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, error in
            guard let self else { return }
            if let error {
                self.status = "Motion error: \(error.localizedDescription)"
                return
            }
            guard let motion else { return }
            self.isConnected = true
            self.status = "Tracking"
            self.consume(motion)
        }
        status = "Waiting for AirPods\u{2026}"
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        isConnected = false
        status = "Stopped"
        zero()
    }

    /// Make the current head position "straight ahead".
    func recentre() {
        reference = nil
        zero()
    }

    private func zero() {
        yaw = 0
        pitch = 0
        roll = 0
    }

    private func consume(_ motion: CMDeviceMotion) {
        guard mode == .headTracked else { return }

        // CMAttitude can express itself relative to a stored reference, which is
        // exactly the re-centring behaviour Apple's "Fixed" frame of reference has.
        guard let attitude = motion.attitude.copy() as? CMAttitude else { return }
        if reference == nil {
            reference = motion.attitude.copy() as? CMAttitude
        }
        if let reference {
            attitude.multiply(byInverseOf: reference)
        }

        let toDegrees = 180.0 / Double.pi
        let rawYaw = attitude.yaw * toDegrees
        yaw = invertYaw ? -rawYaw : rawYaw
        pitch = attitude.pitch * toDegrees
        roll = attitude.roll * toDegrees
    }
}
