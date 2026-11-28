import AVFoundation
import UIKit

/// Executes the synchronous bridge protocol used by `bridge.js`.
///
/// WKWebView cannot call native code synchronously, so the page calls `window.prompt()`
/// and `WKUIDelegate` invokes `handle(_:)` on the main thread before returning. Every
/// method returns a JSON string of the form `{"value": ...}` or `{"error": "..."}`.
final class Bridge {
    private static let prefix = "__ds_bridge__"
    private let services: AppServices
    weak var host: WebViewController?

    init(services: AppServices) {
        self.services = services
    }

    static func isBridgePrompt(_ prompt: String) -> Bool {
        prompt.hasPrefix(prefix)
    }

    static func payload(from prompt: String) -> String {
        String(prompt.dropFirst(prefix.count))
    }

    func handle(_ prompt: String) -> String? {
        guard Self.isBridgePrompt(prompt) else { return nil }
        let raw = Self.payload(from: prompt)
        guard let data = raw.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let method = request["m"] as? String else {
            return Self.encodeError("Invalid native bridge request")
        }
        var arguments = request["a"] as? [Any] ?? []
        return invoke(method, arguments)
    }

    // MARK: - Dispatch

    private func invoke(_ method: String, _ args: [Any]) -> String {
        func string(_ index: Int) -> String? {
            guard index < args.count, !(args[index] is NSNull) else { return nil }
            return args[index] as? String
        }
        func bool(_ index: Int) -> Bool {
            guard index < args.count else { return false }
            return args[index] as? Bool ?? false
        }

        switch method {
        case "statusInset":
            return Self.encode(host?.statusInsetValue ?? 0)
        case "buttonNavigationInset":
            return Self.encode(host?.buttonNavigationInsetValue ?? 0)
        case "systemFontScale":
            return Self.encode(Self.systemFontScale())
        case "isTablet":
            return Self.encode(UIDevice.current.userInterfaceIdiom == .pad)
        case "getMusicVolume":
            let volume = AVAudioSession.sharedInstance().outputVolume
            return Self.encode(Int((volume * 15).rounded()))
        case "openAppPermissions":
            DispatchQueue.main.async {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
            }
            return Self.encode(nil)
        case "updateStatus":
            return Self.encode("{\"phase\":\"idle\"}")
        case "checkForUpdate", "installUpdate":
            return Self.encode(nil)
        case "openSourcePage":
            guard let raw = string(0),
                  let url = URL(string: raw),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  url.host != nil else {
                return Self.encode(nil)
            }
            let dark = bool(1)
            let close = string(2) ?? "关闭"
            let browser = string(3) ?? "在浏览器中打开"
            let loading = string(4) ?? "加载中…"
            let error = string(5) ?? "无法加载此页面，请重试。"
            let retry = string(6) ?? "重试"
            DispatchQueue.main.async { [weak self] in
                self?.host?.openSourcePage(
                    url: url,
                    dark: dark,
                    closeLabel: close,
                    browserLabel: browser,
                    loadingLabel: loading,
                    errorLabel: error,
                    retryLabel: retry
                )
            }
            return Self.encode(nil)

        case "readApiKey":
            return Self.encode(services.apiKeys.read("encrypted"))
        case "writeApiKey":
            return Self.encode(services.apiKeys.write(string(0), account: "encrypted"))
        case "readChatConfig":
            return Self.encode(services.apiKeys.read("custom-chat"))
        case "writeChatConfig":
            return Self.encode(services.apiKeys.write(string(0), account: "custom-chat"))
        case "readAccountProfile":
            return Self.encode(AccountProfile.read())
        case "writeAccountProfile":
            return Self.encode(AccountProfile.write(string(0)))

        case "beginChatRequest":
            let id = services.transport.begin(
                savedConfig: services.apiKeys.read("custom-chat"),
                endpoint: string(0) ?? "",
                format: string(1) ?? "",
                body: string(2) ?? ""
            )
            return Self.encode(id)
        case "cancelChatRequest":
            if let id = string(0) { services.transport.cancel(id) }
            return Self.encode(nil)

        case "setDarkBars":
            host?.setDarkBars(bool(0))
            return Self.encode(nil)
        case "setTextInteraction":
            host?.setTextInteraction(bool(0))
            return Self.encode(nil)
        case "setHandlesBack", "setBackPreviewEnabled", "setSelectionExclusion":
            return Self.encode(nil)
        case "setImageViewerFullscreen":
            host?.setImageViewerFullscreen(bool(0))
            return Self.encode(nil)

        case "requestRecentPhotos":
            services.photos.requestAuthorizationAndList { [weak self] json in
                self?.services.emit("android-photos", json)
            }
            return Self.encode(nil)
        case "prefetchRecentPhotos":
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self, let json = self.services.photos.listJSONIfAuthorized() else { return }
                self.services.emit("android-photos", json)
            }
            return Self.encode(nil)

        case "requestHistoryExport":
            let name = string(0) ?? "history.zip"
            let started = services.export.begin(name: name)
            DispatchQueue.main.async { [weak self] in
                self?.services.emit("android-export", started ? "'ready'" : "'error'")
            }
            return Self.encode(nil)
        case "writeHistoryExport":
            return Self.encode(services.export.append(string(0) ?? ""))
        case "finishHistoryExport":
            return Self.encode(services.export.finish(presenter: host))

        case "chatStorage":
            let reply = services.chatStorage.request(method: string(0) ?? "", payload: string(1) ?? "{}")
            return Self.encode(reply)
        case "shadowList":
            return Self.encode("[]")
        case "shadowReadChunk":
            return Self.encode(nil)
        case "shadowClearAll":
            return Self.encode(true)

        case "requestImageSavePermission":
            services.imageSave.requestPermission { [weak self] granted in
                self?.services.emit("android-image-save-permission", granted ? "'granted'" : "'denied'")
            }
            return Self.encode(nil)
        case "beginImageSave":
            return Self.encode(services.imageSave.begin(name: string(0) ?? "", mime: string(1) ?? ""))
        case "writeImageSave":
            return Self.encode(services.imageSave.append(string(0) ?? ""))
        case "finishImageSave":
            return Self.encode(services.imageSave.finish(keep: bool(0)))

        case "requestRecording":
            requestRecording()
            return Self.encode(nil)
        case "finishRecording":
            return Self.encode(services.recorder.finish(keep: bool(0)))
        case "recordingLevel":
            return Self.encode(services.recorder.level())

        case "tsStart":
            let status = services.tunnel.start(
                authKey: string(0),
                target: string(1) ?? "",
                hostname: string(2) ?? ""
            )
            return Self.encode(status)
        case "tsStatus":
            return Self.encode(services.tunnel.status())
        case "tsStop":
            services.tunnel.stop()
            return Self.encode(nil)
        case "tsOpenLogin":
            return Self.encode(services.tunnel.openLogin())
        case "tsAuthKey":
            return Self.encode(services.tunnel.authKey())
        case "tsSetAuthKey":
            return Self.encode(services.tunnel.setAuthKey(string(0)))

        default:
            return Self.encodeError("Unknown native bridge method: \(method)")
        }
    }

    // MARK: - Helpers

    private func requestRecording() {
        func begin() {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let started = self.services.recorder.start()
                self.services.emit("android-recording", started ? "'ready'" : "'error'")
            }
        }
        if services.recorder.permissionGranted() {
            begin()
            return
        }
        services.recorder.requestPermission { [weak self] granted in
            if granted {
                begin()
            } else {
                self?.services.emit("android-recording", "'denied'")
            }
        }
    }

    private static func systemFontScale() -> Double {
        switch UIApplication.shared.preferredContentSizeCategory {
        case .extraSmall: return 0.85
        case .small: return 0.92
        case .medium: return 0.97
        case .large: return 1.0
        case .extraLarge: return 1.12
        case .extraExtraLarge: return 1.24
        case .extraExtraExtraLarge: return 1.36
        case .accessibilityMedium: return 1.6
        case .accessibilityLarge: return 1.9
        case .accessibilityExtraLarge: return 2.2
        case .accessibilityExtraExtraLarge: return 2.5
        case .accessibilityExtraExtraExtraLarge: return 2.8
        default: return 1.0
        }
    }

    private static func encode(_ value: Any?) -> String {
        let payload: [String: Any] = ["value": value ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"value\":null}"
        }
        return json
    }

    private static func encodeError(_ message: String) -> String {
        let payload: [String: Any] = ["error": message]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"native bridge failure\"}"
        }
        return json
    }
}
