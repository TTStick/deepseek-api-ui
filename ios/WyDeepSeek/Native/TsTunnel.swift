import Foundation
import UIKit

#if canImport(Tsproxy)
import Tsproxy
#endif

/// Built-in Tailscale: a userspace tsnet node plus a loopback TCP proxy, exactly like the
/// Android implementation. iOS cannot keep it alive in the background (no foreground
/// service), so the tunnel is active while the app is running.
final class TsTunnel {
    private static let keyAuth = "myagent.tailscale.authKey"
    private static let keyTarget = "myagent.tailscale.target"
    private static let keyHostname = "myagent.tailscale.hostname"
    private static let keyEnabled = "myagent.tailscale.enabled"

    private let stateDir: String
    private let defaults = UserDefaults.standard
    private var startError = ""

    init() {
        stateDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tailscale", isDirectory: true)
            .path
        try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
        // Node keys should not be copied to iCloud; Android keeps them in filesDir with
        // allowBackup disabled.
        var directory = URL(fileURLWithPath: stateDir, isDirectory: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
    }

    // MARK: - Persistence

    func authKey() -> String {
        defaults.string(forKey: Self.keyAuth) ?? ""
    }

    @discardableResult
    func setAuthKey(_ value: String?) -> Bool {
        if let value, !value.isEmpty {
            defaults.set(value, forKey: Self.keyAuth)
        } else {
            defaults.removeObject(forKey: Self.keyAuth)
        }
        return true
    }

    private var savedTarget: String {
        defaults.string(forKey: Self.keyTarget) ?? ""
    }

    private var savedHostname: String {
        defaults.string(forKey: Self.keyHostname) ?? "wydeepseek"
    }

    private var isEnabled: Bool {
        defaults.bool(forKey: Self.keyEnabled)
    }

    // MARK: - Control

    @discardableResult
    func start(authKey: String?, target: String, hostname: String) -> String {
        if let authKey, !authKey.isEmpty {
            setAuthKey(authKey)
        }
        if !target.isEmpty {
            defaults.set(target, forKey: Self.keyTarget)
            defaults.set(hostname.isEmpty ? "wydeepseek" : hostname, forKey: Self.keyHostname)
        }
        defaults.set(true, forKey: Self.keyEnabled)
        startCore(authKey: authKey, target: target, hostname: hostname)
        return status()
    }

    private func startCore(authKey: String?, target: String, hostname: String) {
        startError = ""
        #if canImport(Tsproxy)
        var failure: NSError?
        let started = TsproxyStart(
            stateDir,
            hostname.isEmpty ? "wydeepseek" : hostname,
            authKey ?? "",
            target,
            &failure
        )
        if !started {
            startError = failure?.localizedDescription ?? "Tailscale 启动失败"
        }
        #else
        startError = "当前构建未包含内置 Tailscale"
        #endif
    }

    func stop() {
        #if canImport(Tsproxy)
        TsproxyStop()
        #endif
        defaults.set(false, forKey: Self.keyEnabled)
        startError = ""
    }

    /// Called when returning to the foreground. tsnet usually survives suspension; only
    /// start again if it never came up, and only when the user had enabled it.
    func resumeIfNeeded() {
        guard isEnabled, !savedTarget.isEmpty else { return }
        #if canImport(Tsproxy)
        let state = TsproxyState()
        if state == "stopped" || state == "error" {
            startCore(authKey: nil, target: savedTarget, hostname: savedHostname)
        }
        #endif
    }

    func status() -> String {
        var state = "stopped"
        var addr = ""
        var ip = ""
        var loginURL = ""
        var error = ""
        #if canImport(Tsproxy)
        state = TsproxyState()
        addr = TsproxyAddr()
        ip = TsproxySelfIP()
        loginURL = TsproxyLoginURL()
        error = TsproxyLastError()
        #endif
        if error.isEmpty && !startError.isEmpty {
            error = startError
            if state == "stopped" { state = "error" }
        }
        if state.isEmpty { state = "stopped" }
        let payload: [String: Any] = [
            "state": state,
            "addr": addr.isEmpty ? "" : addr,
            "ip": ip.isEmpty ? "" : ip,
            "loginUrl": loginURL.isEmpty ? "" : loginURL,
            "error": error.isEmpty ? "" : error,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"state\":\"error\",\"addr\":\"\",\"ip\":\"\",\"loginUrl\":\"\",\"error\":\"status failed\"}"
        }
        return json
    }

    func openLogin() -> Bool {
        var raw = ""
        #if canImport(Tsproxy)
        raw = TsproxyLoginURL()
        #endif
        guard let url = URL(string: raw), !raw.isEmpty else { return false }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return true
    }
}
