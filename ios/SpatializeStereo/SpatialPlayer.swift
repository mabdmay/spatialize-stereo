import AVFoundation
import Combine
import Foundation

/// The native counterpart to `docs/engine.js`, built on AVAudioEngine.
///
/// The architecture is forced by one line in Apple's own documentation for
/// `AVAudioEnvironmentNode`:
///
///   "Spatialization applies only to inputs with a mono channel connection
///    format. This class doesn't spatialize stereo inputs."
///
/// So a stereo file cannot simply be handed to the spatialiser. It is first
/// decomposed into mono virtual-loudspeaker feeds (mid/side), and each feed gets
/// its own player node, its own position and its own HRTF render. That is almost
/// certainly what "Spatialize Stereo" does internally.
///
/// Audio is streamed in chunks rather than decoded whole: five mono copies of a
/// five-minute song would otherwise sit in memory at roughly 290 MB.
@MainActor
final class SpatialPlayer: ObservableObject {

    // MARK: Virtual loudspeaker bed

    /// Which decomposed signal drives a speaker.
    enum Feed {
        case left, right, mid, side
    }

    struct SpeakerSpec {
        let id: String
        let feed: Feed
        let azimuth: Float      // degrees, + is to the right
        let elevation: Float
        let gain: Float
        let delayMs: Double     // decorrelation + crude early reflection
    }

    /// A 5.0 cinema bed: fronts at +/-30, a hard centre, surrounds at +/-110.
    static let bed: [SpeakerSpec] = [
        .init(id: "L",  feed: .left,  azimuth: -30,  elevation: 0, gain: 1.00, delayMs: 0),
        .init(id: "R",  feed: .right, azimuth:  30,  elevation: 0, gain: 1.00, delayMs: 0),
        .init(id: "C",  feed: .mid,   azimuth:   0,  elevation: 0, gain: 0.70, delayMs: 0),
        .init(id: "Ls", feed: .side,  azimuth: -110, elevation: 0, gain: 0.45, delayMs: 11),
        .init(id: "Rs", feed: .side,  azimuth:  110, elevation: 0, gain: 0.45, delayMs: 17),
    ]

    // MARK: Published state

    @Published private(set) var isPlaying = false
    @Published private(set) var trackName = "Nothing loaded"
    @Published private(set) var duration: Double = 0
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var lastError: String?

    @Published var azimuth: Float = 0     { didSet { placeSpeakers() } }
    @Published var elevation: Float = -5  { didSet { placeSpeakers() } }
    @Published var distance: Float = 4    { didSet { placeSpeakers() } }
    @Published var spread: Float = 1      { didSet { placeSpeakers() } }
    @Published var reverbLevel: Float = -10 { didSet { applyReverb() } }

    // MARK: Engine

    private let engine = AVAudioEngine()
    private let environment = AVAudioEnvironmentNode()
    private var players: [AVAudioPlayerNode] = []

    private var file: AVAudioFile?
    private var readPosition: AVAudioFramePosition = 0
    private var startFrameOffset: AVAudioFramePosition = 0
    private var scheduledChunks = 0
    private var isScheduling = false

    /// One second of audio per scheduled chunk.
    private let chunkFrames: AVAudioFrameCount = 48_000
    private let prerollChunks = 3

    /// Running tails for the delayed side feeds, so chunk edges stay seamless.
    private var delayTails: [String: [Float]] = [:]

    private let ioQueue = DispatchQueue(label: "spatialize.io", qos: .userInitiated)

    // MARK: Setup

    init() {
        configureSession()
        buildGraph()
    }

    private func configureSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            lastError = "Audio session: \(error.localizedDescription)"
        }
    }

    private func buildGraph() {
        engine.attach(environment)

        // Headphones is the only output where any of this means anything.
        environment.outputType = .headphones
        environment.renderingAlgorithm = .HRTFHQ

        environment.distanceAttenuationParameters.distanceAttenuationModel = .inverse
        environment.distanceAttenuationParameters.referenceDistance = 1
        environment.distanceAttenuationParameters.maximumDistance = 120
        environment.distanceAttenuationParameters.rolloffFactor = 0.65

        environment.reverbParameters.enable = true
        environment.reverbParameters.loadFactoryReverbPreset(.mediumRoom)
        environment.reverbParameters.level = reverbLevel

        engine.connect(environment, to: engine.mainMixerNode, format: nil)

        // Mono in — the spatialiser ignores anything wider.
        let mono = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)

        for spec in Self.bed {
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: environment, format: mono)

            player.renderingAlgorithm = .HRTFHQ
            player.sourceMode = .pointSource
            player.reverbBlend = 0.3
            player.volume = spec.gain

            players.append(player)
            delayTails[spec.id] = []
        }

        placeSpeakers()

        do {
            try engine.start()
        } catch {
            lastError = "Engine: \(error.localizedDescription)"
        }
    }

    // MARK: Geometry

    /// Place every speaker in the room frame. The listener is rotated separately,
    /// which is what keeps the rig world-locked.
    private func placeSpeakers() {
        for (i, spec) in Self.bed.enumerated() where i < players.count {
            let az = (azimuth + spec.azimuth * spread) * .pi / 180
            let el = (elevation + spec.elevation * spread) * .pi / 180
            let horiz = cosf(el)
            players[i].position = AVAudio3DPoint(
                x: distance * sinf(az) * horiz,
                y: distance * sinf(el),
                z: -distance * cosf(az) * horiz
            )
        }
    }

    private func applyReverb() {
        environment.reverbParameters.level = reverbLevel
    }

    /// STAGE 4 — world-locking. Rotating the listener leaves the speakers where
    /// they are in the room, so turning your head sweeps the image past you.
    func setListenerPose(yaw: Double, pitch: Double, roll: Double) {
        environment.listenerAngularOrientation = AVAudio3DAngularOrientation(
            yaw: Float(yaw), pitch: Float(pitch), roll: Float(roll)
        )
    }

    // MARK: Transport

    func load(url: URL) {
        stop()

        // Files chosen through the document picker are security-scoped.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        do {
            let opened = try AVAudioFile(forReading: url)
            file = opened
            readPosition = 0
            startFrameOffset = 0
            duration = Double(opened.length) / opened.processingFormat.sampleRate
            trackName = url.deletingPathExtension().lastPathComponent
            elapsed = 0
            lastError = nil
            for key in delayTails.keys { delayTails[key] = [] }
        } catch {
            lastError = "Could not open that file: \(error.localizedDescription)"
            file = nil
        }
    }

    func play() {
        guard file != nil else { return }
        if !engine.isRunning {
            do { try engine.start() } catch {
                lastError = "Engine: \(error.localizedDescription)"
                return
            }
        }
        for _ in 0..<prerollChunks { scheduleNextChunk() }
        players.forEach { $0.play() }
        isPlaying = true
    }

    func pause() {
        players.forEach { $0.pause() }
        isPlaying = false
    }

    func stop() {
        players.forEach { $0.stop() }
        isPlaying = false
        scheduledChunks = 0
        readPosition = 0
        elapsed = 0
    }

    func seek(to seconds: Double) {
        guard let file else { return }
        let wasPlaying = isPlaying
        players.forEach { $0.stop() }
        scheduledChunks = 0
        let frame = AVAudioFramePosition(seconds * file.processingFormat.sampleRate)
        readPosition = max(0, min(frame, file.length))
        startFrameOffset = readPosition
        for key in delayTails.keys { delayTails[key] = [] }
        elapsed = seconds
        if wasPlaying { play() }
    }

    /// Where the renderer actually is, taken from the first player's node time.
    func refreshElapsed() {
        guard isPlaying,
              let node = players.first,
              let nodeTime = node.lastRenderTime,
              let playerTime = node.playerTime(forNodeTime: nodeTime)
        else { return }
        let played = Double(playerTime.sampleTime) / playerTime.sampleRate
        let offset = Double(startFrameOffset) / (file?.processingFormat.sampleRate ?? 48_000)
        elapsed = min(duration, max(0, offset + played))
    }

    // MARK: Streaming

    /// Read one chunk, decompose it into the five mono feeds, and hand each feed
    /// to its own player. Refills itself from the completion callback.
    private func scheduleNextChunk() {
        guard let file, !isScheduling else { return }
        guard readPosition < file.length else { return }
        isScheduling = true

        let format = file.processingFormat
        let frames = min(chunkFrames, AVAudioFrameCount(file.length - readPosition))
        guard frames > 0,
              let staging = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
        else { isScheduling = false; return }

        do {
            file.framePosition = readPosition
            try file.read(into: staging, frameCount: frames)
        } catch {
            lastError = "Read failed: \(error.localizedDescription)"
            isScheduling = false
            return
        }
        readPosition += AVAudioFramePosition(staging.frameLength)

        let count = Int(staging.frameLength)
        guard count > 0, let channels = staging.floatChannelData else {
            isScheduling = false
            return
        }

        let left = channels[0]
        let right = format.channelCount > 1 ? channels[1] : channels[0]

        // STAGE 1 — mid/side. M is what the channels agree on (a real point
        // source); S is what they disagree on (already-decorrelated ambience).
        var mid = [Float](repeating: 0, count: count)
        var side = [Float](repeating: 0, count: count)
        for i in 0..<count {
            mid[i] = (left[i] + right[i]) * 0.5
            side[i] = (left[i] - right[i]) * 0.5
        }

        let monoFormat = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate,
                                       channels: 1)!

        for (i, spec) in Self.bed.enumerated() where i < players.count {
            var samples: [Float]
            switch spec.feed {
            case .left:  samples = Array(UnsafeBufferPointer(start: left, count: count))
            case .right: samples = Array(UnsafeBufferPointer(start: right, count: count))
            case .mid:   samples = mid
            case .side:  samples = side
            }

            // STAGE 5 — decorrelation, carried across chunk boundaries so there
            // is no click where one chunk meets the next.
            if spec.delayMs > 0 {
                let delaySamples = Int(spec.delayMs * format.sampleRate / 1000)
                var tail = delayTails[spec.id] ?? []
                if tail.count != delaySamples {
                    tail = [Float](repeating: 0, count: delaySamples)
                }
                let combined = tail + samples
                samples = Array(combined[0..<count])
                delayTails[spec.id] = Array(combined[count...])
            }

            guard let out = AVAudioPCMBuffer(pcmFormat: monoFormat,
                                             frameCapacity: AVAudioFrameCount(count)),
                  let dst = out.floatChannelData?[0]
            else { continue }
            out.frameLength = AVAudioFrameCount(count)
            samples.withUnsafeBufferPointer { src in
                dst.update(from: src.baseAddress!, count: count)
            }

            let isLast = (i == Self.bed.count - 1)
            players[i].scheduleBuffer(out, completionCallbackType: .dataConsumed) { [weak self] _ in
                guard isLast else { return }
                Task { @MainActor in
                    self?.scheduledChunks -= 1
                    self?.scheduleNextChunk()
                }
            }
        }

        scheduledChunks += 1
        isScheduling = false
    }

    // MARK: Presets

    struct Preset: Identifiable {
        let id: String
        let label: String
        let azimuth: Float
        let elevation: Float
        let distance: Float
        let spread: Float
        let reverb: Float
    }

    static let presets: [Preset] = [
        .init(id: "room",    label: "Across the room", azimuth: 0,    elevation: -8, distance: 4,  spread: 1.0,  reverb: -10),
        .init(id: "kitchen", label: "Kitchen speaker", azimuth: 68,   elevation: 4,  distance: 7,  spread: 0.55, reverb: -4),
        .init(id: "behind",  label: "Behind me",       azimuth: -145, elevation: 0,  distance: 3,  spread: 0.8,  reverb: -9),
        .init(id: "cinema",  label: "Cinema front",    azimuth: 0,    elevation: -2, distance: 2.2, spread: 1.25, reverb: -16),
        .init(id: "venue",   label: "Live venue",      azimuth: 0,    elevation: 6,  distance: 11, spread: 1.4,  reverb: 0),
    ]

    func apply(_ preset: Preset) {
        azimuth = preset.azimuth
        elevation = preset.elevation
        distance = preset.distance
        spread = preset.spread
        reverbLevel = preset.reverb
    }
}
