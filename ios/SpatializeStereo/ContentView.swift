import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var player = SpatialPlayer()
    @StateObject private var tracker = HeadTracker()

    @State private var showPicker = false
    @State private var scrubbing = false
    @State private var scrubValue: Double = 0

    private let tick = Timer.publish(every: 0.2, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let error = player.lastError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    }

                    nowPlaying
                    radar
                    presets
                    headTracking
                    placement
                    room
                    footnote
                }
                .padding(16)
            }
            .navigationTitle("Spatialize")
            .background(Color.black.ignoresSafeArea())
        }
        .fileImporter(
            isPresented: $showPicker,
            allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav, .aiff],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                player.load(url: url)
            }
        }
        .onAppear { tracker.start() }
        .onDisappear { tracker.stop() }
        .onReceive(tick) { _ in
            player.refreshElapsed()
            // Feed the measured pose to the spatialiser. In Fixed and Off modes
            // the tracker holds its values, so this stays a no-op.
            player.setListenerPose(yaw: tracker.yaw, pitch: tracker.pitch, roll: tracker.roll)
        }
    }

    // MARK: Sections

    private var nowPlaying: some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                Text(player.trackName)
                    .font(.headline)
                    .lineLimit(1)

                HStack(spacing: 10) {
                    Text(time(scrubbing ? scrubValue : player.elapsed))
                        .monospacedDigit().font(.caption2).foregroundStyle(.secondary)
                    Slider(
                        value: Binding(
                            get: { scrubbing ? scrubValue : player.elapsed },
                            set: { scrubValue = $0 }
                        ),
                        in: 0...max(player.duration, 0.1),
                        onEditingChanged: { editing in
                            scrubbing = editing
                            if !editing { player.seek(to: scrubValue) }
                        }
                    )
                    Text(time(player.duration))
                        .monospacedDigit().font(.caption2).foregroundStyle(.secondary)
                }

                HStack {
                    Spacer()
                    Button {
                        player.isPlaying ? player.pause() : player.play()
                    } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title2)
                            .frame(width: 64, height: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(player.duration == 0)
                    Spacer()
                }

                Button {
                    showPicker = true
                } label: {
                    Label("Choose a track", systemImage: "music.note.list")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    /// Top-down map, drawn from the same geometry the audio graph uses.
    private var radar: some View {
        card {
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle("Where the speaker is")
                Canvas { ctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let maxM = max(6, Double(player.distance) * 1.35)
                    let scale = (size.width * 0.42) / maxM

                    for m in stride(from: 2.0, through: maxM, by: 2.0) {
                        let r = m * scale
                        ctx.stroke(
                            Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                            with: .color(.gray.opacity(0.22)), lineWidth: 1
                        )
                    }

                    // Listener, facing the measured heading.
                    let yaw = tracker.yaw * .pi / 180
                    var cone = Path()
                    cone.move(to: c)
                    cone.addArc(center: c, radius: size.width * 0.17,
                                startAngle: .radians(-.pi / 2 - 0.5 + yaw),
                                endAngle: .radians(-.pi / 2 + 0.5 + yaw),
                                clockwise: false)
                    cone.closeSubpath()
                    ctx.fill(cone, with: .color(.blue.opacity(0.22)))
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10)),
                             with: .color(.blue))

                    for spec in SpatialPlayer.bed {
                        let az = Double(player.azimuth + spec.azimuth * player.spread) * .pi / 180
                        let el = Double(player.elevation) * .pi / 180
                        let d = Double(player.distance)
                        let x = d * sin(az) * cos(el)
                        let z = -d * cos(az) * cos(el)
                        let p = CGPoint(x: c.x + x * scale, y: c.y + z * scale)
                        let behind = z > 0
                        ctx.fill(
                            Path(ellipseIn: CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10)),
                            with: .color(behind ? .orange : .green)
                        )
                        ctx.draw(Text(spec.id).font(.caption2).foregroundStyle(.secondary),
                                 at: CGPoint(x: p.x, y: p.y - 14))
                    }
                }
                .frame(height: 260)
                .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))

                Text("Green is in front of you, amber is behind. The cone is the way you are facing.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var presets: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                sectionTitle("Presets")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(SpatialPlayer.presets) { preset in
                            Button(preset.label) { player.apply(preset) }
                                .buttonStyle(.bordered)
                                .font(.footnote)
                        }
                    }
                }
            }
        }
    }

    private var headTracking: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                sectionTitle("Head tracking")

                Picker("Mode", selection: $tracker.mode) {
                    ForEach(HeadTracker.Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                HStack {
                    Circle()
                        .fill(tracker.isConnected ? .green : .gray)
                        .frame(width: 8, height: 8)
                    Text(tracker.status).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }

                Text(String(format: "yaw %.0f\u{b0}   pitch %.0f\u{b0}   roll %.0f\u{b0}",
                            tracker.yaw, tracker.pitch, tracker.roll))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)

                HStack(spacing: 10) {
                    Button("Re-centre") { tracker.recentre() }
                        .buttonStyle(.bordered)
                    Toggle("Flip rotation", isOn: $tracker.invertYaw)
                        .font(.footnote)
                }

                if !tracker.isAvailable {
                    Text("Connect AirPods (3rd gen or later), AirPods Pro, AirPods Max or Beats Fit Pro to get head tracking.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var placement: some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("Placement")
                labelled("Direction", String(format: "%.0f\u{b0}", player.azimuth)) {
                    Slider(value: $player.azimuth, in: -180...180)
                }
                labelled("Distance", String(format: "%.1f m", player.distance)) {
                    Slider(value: $player.distance, in: 0.5...20)
                }
                labelled("Height", String(format: "%.0f\u{b0}", player.elevation)) {
                    Slider(value: $player.elevation, in: -40...40)
                }
                labelled("Spread", String(format: "%.0f%%", player.spread * 100)) {
                    Slider(value: $player.spread, in: 0...1.6)
                }
            }
        }
    }

    private var room: some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("Room")
                labelled("Reverb", String(format: "%.0f dB", player.reverbLevel)) {
                    Slider(value: $player.reverbLevel, in: -40...0)
                }
            }
        }
    }

    private var footnote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Use headphones. The effect is binaural, so over a speaker the two ears mix in the air and it collapses back to stereo.")
            Text("Turn off Apple's own Spatial Audio for these headphones while using this, or the two renderers stack.")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Helpers

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
    }

    private func sectionTitle(_ s: String) -> some View {
        Text(s.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .kerning(0.8)
    }

    private func labelled<Content: View>(
        _ title: String, _ value: String, @ViewBuilder _ content: () -> Content
    ) -> some View {
        HStack(spacing: 10) {
            Text(title).font(.caption).foregroundStyle(.secondary).frame(width: 70, alignment: .leading)
            content()
            Text(value).font(.caption2.monospacedDigit()).frame(width: 54, alignment: .trailing)
        }
    }

    private func time(_ s: Double) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        return String(format: "%d:%02d", Int(s) / 60, Int(s) % 60)
    }
}

#Preview {
    ContentView()
}
