import Foundation
import Network

/// Minimal HTTP/1.1 server bound to loopback. It serves the bundled React build and the
/// same dynamic routes Android intercepts in `MainActivity.shouldInterceptRequest`:
/// `/chat-attachment/<uuid>`, `/recording.wav`, `/recent/<id>` and `/thumbnail/<id>`.
final class HTTPServer {
    // 8100 is in the MyAgent server's default CORS allowlist together with the Android
    // origin. Keeping the iOS document origin at http://127.0.0.1:8100 lets server-mode
    // requests (direct or through the Tailscale proxy) pass CORS without server changes.
    static let port: UInt16 = 8100
    static let cookieName = "dsw_token"
    static let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")

    private enum ServerError: Error {
        case startTimeout
        case portUnavailable
    }

    private let queue = DispatchQueue(
        label: "io.github.wydeepseek.http",
        qos: .userInitiated,
        attributes: .concurrent
    )
    private let ready = DispatchSemaphore(value: 0)
    private let services: AppServices
    private let root: URL
    private var listener: NWListener?
    private(set) var isRunning = false

    init(services: AppServices) {
        self.services = services
        root = Bundle.main.bundleURL.appendingPathComponent("WebApp", isDirectory: true)
    }

    func start() throws {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredInterfaceType = .loopback
        guard let port = NWEndpoint.Port(rawValue: Self.port) else {
            throw ServerError.portUnavailable
        }
        let listener = try NWListener(using: parameters, on: port)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.isRunning = true
                self.ready.signal()
            case .failed, .cancelled:
                self.isRunning = false
                self.ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        if ready.wait(timeout: .now() + 5) == .timedOut {
            listener.cancel()
            self.listener = nil
            throw ServerError.startTimeout
        }
        if !isRunning {
            listener.cancel()
            self.listener = nil
            throw ServerError.portUnavailable
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        isRunning = false
    }

    // MARK: - Connection

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = buffer.subdata(in: 0..<range.lowerBound)
                self.handle(connection, head: head)
                return
            }
            if error != nil || isComplete || buffer.count > 128 * 1024 {
                connection.cancel()
                return
            }
            self.receive(connection, buffer: buffer)
        }
    }

    private func handle(_ connection: NWConnection, head: Data) {
        guard let text = String(data: head, encoding: .utf8) else {
            respond(connection, status: 400, reason: "Bad Request", body: Data())
            return
        }
        let lines = text.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            respond(connection, status: 400, reason: "Bad Request", body: Data())
            return
        }
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2 else {
            respond(connection, status: 400, reason: "Bad Request", body: Data())
            return
        }
        let method = String(parts[0]).uppercased()
        let target = String(parts[1])
        guard method == "GET" || method == "HEAD" else {
            respond(connection, status: 405, reason: "Method Not Allowed", body: Data())
            return
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        let rawPath = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard let decoded = rawPath.removingPercentEncoding, !decoded.contains("..") else {
            respond(connection, status: 400, reason: "Bad Request", body: Data())
            return
        }
        let path = decoded.isEmpty ? "/" : decoded
        #if DEBUG
        NSLog("HTTP %@ %@", method, path)
        #endif
        let includeBody = method == "GET"

        if path == "/" || path == "/index.html" {
            serveIndex(connection, includeBody: includeBody)
            return
        }
        if path.hasPrefix("/static/") {
            serveStatic(connection, path: path, includeBody: includeBody)
            return
        }
        if path.hasPrefix("/chat-attachment/") {
            serveAttachment(connection, path: path, headers: headers, includeBody: includeBody)
            return
        }
        if path == "/recording.wav" {
            serveRecording(connection, headers: headers, includeBody: includeBody)
            return
        }
        if path.hasPrefix("/recent/") || path.hasPrefix("/thumbnail/") {
            servePhoto(connection, path: path, headers: headers, includeBody: includeBody)
            return
        }
        respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
    }

    // MARK: - Routes

    private func serveIndex(_ connection: NWConnection, includeBody: Bool) {
        let url = root.appendingPathComponent("index.html")
        guard var html = try? String(contentsOf: url, encoding: .utf8) else {
            respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
            return
        }
        // Only the iOS runtime gets viewport-fit=cover; Android keeps its original meta.
        html = html.replacingOccurrences(
            of: "content=\"width=device-width,initial-scale=1\"",
            with: "content=\"width=device-width,initial-scale=1,viewport-fit=cover\""
        )
        respond(
            connection,
            status: 200,
            reason: "OK",
            headers: [
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": Self.contentSecurityPolicy,
            ],
            body: Data(html.utf8),
            includeBody: includeBody
        )
    }

    private func serveStatic(_ connection: NWConnection, path: String, includeBody: Bool) {
        let relative = String(path.dropFirst())
        let url = root.appendingPathComponent(relative)
        let standardized = url.standardizedFileURL.path
        guard standardized.hasPrefix(root.standardizedFileURL.path + "/"),
              FileManager.default.fileExists(atPath: standardized) else {
            respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
            return
        }
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
            return
        }
        let mime = Self.mimeType(for: (path as NSString).pathExtension)
        respond(
            connection,
            status: 200,
            reason: "OK",
            headers: [
                "Content-Type": mime,
                "Cache-Control": "public, max-age=31536000, immutable",
                "Content-Security-Policy": Self.contentSecurityPolicy,
            ],
            body: data,
            includeBody: includeBody
        )
    }

    private func serveAttachment(
        _ connection: NWConnection,
        path: String,
        headers: [String: String],
        includeBody: Bool
    ) {
        guard authorized(headers) else {
            respond(connection, status: 403, reason: "Forbidden", body: Data(), includeBody: includeBody)
            return
        }
        let token = String(path.dropFirst("/chat-attachment/".count))
        guard let data = try? services.chatStorage.attachmentData(token) else {
            respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
            return
        }
        respond(
            connection,
            status: 200,
            reason: "OK",
            headers: [
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            ],
            body: data,
            includeBody: includeBody
        )
    }

    private func serveRecording(
        _ connection: NWConnection,
        headers: [String: String],
        includeBody: Bool
    ) {
        guard authorized(headers) else {
            respond(connection, status: 403, reason: "Forbidden", body: Data(), includeBody: includeBody)
            return
        }
        guard let data = services.recorder.takeWav() else {
            respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
            return
        }
        #if DEBUG
        NSLog("RECORDING served %d bytes", data.count)
        #endif
        respond(
            connection,
            status: 200,
            reason: "OK",
            headers: [
                "Content-Type": "audio/wav",
                "Cache-Control": "no-store",
            ],
            body: data,
            includeBody: includeBody
        )
    }

    private func servePhoto(
        _ connection: NWConnection,
        path: String,
        headers: [String: String],
        includeBody: Bool
    ) {
        guard authorized(headers) else {
            respond(connection, status: 403, reason: "Forbidden", body: Data(), includeBody: includeBody)
            return
        }
        let thumbnail = path.hasPrefix("/thumbnail/")
        let prefix = thumbnail ? "/thumbnail/" : "/recent/"
        let id = String(path.dropFirst(prefix.count))
        let dynamicHeaders = [
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        ]
        if thumbnail {
            guard let data = services.photos.thumbnailData(id: id) else {
                respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
                return
            }
            var responseHeaders = dynamicHeaders
            responseHeaders["Content-Type"] = "image/jpeg"
            respond(
                connection,
                status: 200,
                reason: "OK",
                headers: responseHeaders,
                body: data,
                includeBody: includeBody
            )
            return
        }
        guard let photo = services.photos.photoData(id: id) else {
            respond(connection, status: 404, reason: "Not Found", body: Data(), includeBody: includeBody)
            return
        }
        var responseHeaders = dynamicHeaders
        responseHeaders["Content-Type"] = photo.mime
        respond(
            connection,
            status: 200,
            reason: "OK",
            headers: responseHeaders,
            body: photo.data,
            includeBody: includeBody
        )
    }

    // MARK: - Response

    private func authorized(_ headers: [String: String]) -> Bool {
        guard let cookie = headers["cookie"] else { return false }
        let expected = "\(Self.cookieName)=\(Self.token)"
        return cookie.split(separator: ";").contains { part in
            String(part).trimmingCharacters(in: .whitespaces) == expected
        }
    }

    private func respond(
        _ connection: NWConnection,
        status: Int,
        reason: String,
        headers: [String: String] = [:],
        body: Data,
        includeBody: Bool = true
    ) {
        var fields = headers
        fields["Content-Length"] = String(body.count)
        fields["Connection"] = "close"
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        for (name, value) in fields {
            head += "\(name): \(value)\r\n"
        }
        head += "\r\n"
        var payload = Data(head.utf8)
        if includeBody {
            payload.append(body)
        }
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    // MARK: - Metadata

    private static let contentSecurityPolicy =
        "default-src 'none'; script-src 'self'; worker-src 'self'; child-src 'self'; "
        + "style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' https: http: data: blob:; font-src 'self' data:; "
        + "media-src 'self' blob:; connect-src 'self' https: http: blob:; "
        + "frame-src 'none'; base-uri 'none'; form-action 'none';"

    private static func mimeType(for rawExtension: String) -> String {
        switch rawExtension.lowercased() {
        case "html": return "text/html"
        case "js": return "text/javascript"
        case "css": return "text/css"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }
}
