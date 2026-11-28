import AVFoundation
import UIKit

/// Composition root for the native services used by the web bridge.
final class AppServices {
    static let shared = AppServices()

    let apiKeys = ApiKeyStore()
    let recorder = NativeRecorder()
    let photos = PhotoLibrary()
    let chatStorage = ChatStorage()
    let transport = ChatTransport()
    let imageSave = ImageSave()
    let export = FileExport()
    let tunnel = TsTunnel()

    weak var host: WebViewController?

    private init() {
        // TTS uses Web Audio; playback also keeps the read-aloud voice audible when the
        // ring/silent switch is on, matching Android's media stream behaviour.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        recorder.onInterrupted = { [weak self] in
            self?.emit("android-recording-interrupted", "null")
        }
        transport.onEvent = { [weak self] payload in
            self?.emit("android-custom-chat", payload)
        }
    }

    func emit(_ name: String, _ detailJSON: String) {
        if Thread.isMainThread {
            host?.emit(name, detailJSON: detailJSON)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.host?.emit(name, detailJSON: detailJSON)
            }
        }
    }
}
