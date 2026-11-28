import AVFoundation
import Foundation

/// Records 16 kHz / mono / 16-bit PCM WAV with AVAudioRecorder and hands the bytes to the
/// page over `/recording.wav`, mirroring Android's `NativeRecorder` (AudioRecord).
/// AVAudioRecorder is used instead of AVAudioEngine because the engine's input node can
/// abort inside AudioToolbox on simulators without a usable input device.
final class NativeRecorder {
    static let sampleRate = 16_000
    private static let maxDuration: TimeInterval = 120

    private let lock = NSLock()
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var levelTimer: Timer?
    private var capturing = false
    private var currentLevel: Double = 0
    private var result: Data?
    private var startedAt: Date?
    private var interruptionObserver: NSObjectProtocol?

    var onInterrupted: (() -> Void)?

    init() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self,
                  let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            let wasRecording = self.capturing
            self.finish(keep: false)
            if wasRecording {
                self.onInterrupted?()
            }
        }
    }

    deinit {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
    }

    // MARK: - Permission

    func permissionGranted() -> Bool {
        if #available(iOS 17.0, *) {
            return AVAudioApplication.shared.recordPermission == .granted
        }
        return AVAudioSession.sharedInstance().recordPermission == .granted
    }

    func requestPermission(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
    }

    // MARK: - Recording

    func start() -> Bool {
        finish(keep: false)
        #if targetEnvironment(simulator)
        // Simulator CoreAudio input is frequently unavailable and can block the main
        // thread inside AudioToolbox. Produce a synthetic WAV so the whole voice flow
        // (permission → recording UI → /recording.wav) remains testable. Real devices
        // use AVAudioRecorder below.
        lock.lock()
        capturing = true
        currentLevel = 0.35
        result = nil
        startedAt = Date()
        lock.unlock()
        startLevelTimer()
        return true
        #else
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .mixWithOthers])
            try session.setActive(true)
        } catch {
            return false
        }

        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let directory = caches.appendingPathComponent("recording", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            restorePlaybackSession()
            return false
        }
        let url = directory.appendingPathComponent("recording-\(UUID().uuidString).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: Double(Self.sampleRate),
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record(forDuration: Self.maxDuration) else {
                try? FileManager.default.removeItem(at: url)
                restorePlaybackSession()
                return false
            }
            lock.lock()
            self.recorder = recorder
            self.recordingURL = url
            self.capturing = true
            self.currentLevel = 0
            self.result = nil
            lock.unlock()
            startLevelTimer()
            return true
        } catch {
            try? FileManager.default.removeItem(at: url)
            restorePlaybackSession()
            return false
        }
        #endif
    }

    private func startLevelTimer() {
        levelTimer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            self.updateLevel()
        }
        RunLoop.main.add(timer, forMode: .common)
        levelTimer = timer
    }

    private func updateLevel() {
        #if targetEnvironment(simulator)
        lock.lock()
        if capturing {
            currentLevel = min(1, max(0, 0.4 + 0.18 * sin(Date().timeIntervalSince1970 * 5)))
        }
        lock.unlock()
        return
        #else
        lock.lock()
        let recorder = self.recorder
        let capturing = self.capturing
        lock.unlock()
        guard let recorder, capturing else { return }
        recorder.updateMeters()
        let decibels = Double(recorder.averagePower(forChannel: 0))
        // Map -50…0 dBFS to the 0…1 meter used by the voice overlay.
        let level = min(1, max(0, (decibels + 50) / 50))
        lock.lock()
        if self.capturing {
            currentLevel = level
        }
        lock.unlock()
        #endif
    }

    @discardableResult
    func finish(keep: Bool) -> Bool {
        levelTimer?.invalidate()
        levelTimer = nil
        lock.lock()
        let recorder = self.recorder
        let url = self.recordingURL
        let wasCapturing = capturing
        let startedAt = self.startedAt
        self.recorder = nil
        self.recordingURL = nil
        self.startedAt = nil
        self.capturing = false
        self.currentLevel = 0
        self.result = nil
        lock.unlock()

        #if targetEnvironment(simulator)
        let duration = min(120, max(0.6, Date().timeIntervalSince(startedAt ?? Date())))
        if keep && wasCapturing {
            let wav = Self.simulatedWav(duration: duration)
            lock.lock()
            result = wav
            lock.unlock()
        }
        return keep && wasCapturing
        #else
        // stop() flushes the WAV header and the final audio bytes; only then read it.
        recorder?.stop()
        var captured: Data?
        if keep && wasCapturing, let url {
            captured = try? Data(contentsOf: url)
        }
        if let url {
            try? FileManager.default.removeItem(at: url)
        }
        if wasCapturing || recorder != nil {
            restorePlaybackSession()
        }
        guard keep, wasCapturing, let captured, captured.count > 44 else { return false }
        lock.lock()
        result = captured
        lock.unlock()
        return true
        #endif
    }

    func level() -> Double {
        lock.lock()
        defer { lock.unlock() }
        return capturing ? currentLevel : 0
    }

    func takeWav() -> Data? {
        lock.lock()
        let wav = result
        result = nil
        lock.unlock()
        guard let wav, wav.count > 44 else { return nil }
        return wav
    }

    private func restorePlaybackSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
    }

    private static func simulatedWav(duration: TimeInterval) -> Data {
        let frames = max(1, Int(duration * Double(sampleRate)))
        let dataSize = frames * 2
        var wav = Data(capacity: 44 + dataSize)
        wav.append(contentsOf: Array("RIFF".utf8))
        wav.appendLittleEndian(UInt32(36 + dataSize))
        wav.append(contentsOf: Array("WAVEfmt ".utf8))
        wav.appendLittleEndian(UInt32(16))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt32(sampleRate))
        wav.appendLittleEndian(UInt32(sampleRate * 2))
        wav.appendLittleEndian(UInt16(2))
        wav.appendLittleEndian(UInt16(16))
        wav.append(contentsOf: Array("data".utf8))
        wav.appendLittleEndian(UInt32(dataSize))
        for index in 0..<frames {
            let time = Double(index) / Double(sampleRate)
            let fade = min(1, min(time / 0.04, (duration - time) / 0.04))
            let sample = Int16(3_000 * max(0, fade) * sin(2 * Double.pi * 440 * time))
            wav.appendLittleEndian(UInt16(bitPattern: sample))
        }
        return wav
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }
}
