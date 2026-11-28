import Foundation

/// Streams a user-configured OpenAI/Anthropic-compatible endpoint directly from native code.
/// Android uses `HttpURLConnection` here to bypass WebView CORS; iOS uses URLSession and
/// forwards base64 chunks through the same `android-custom-chat` events.
final class ChatTransport {
    var onEvent: ((String) -> Void)?

    private var exchanges: [String: Exchange] = [:]
    private let lock = NSLock()

    func begin(
        savedConfig: String?,
        endpoint: String,
        format: String,
        body: String
    ) -> String? {
        guard let savedConfig,
              let data = savedConfig.data(using: .utf8),
              let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let configuredEndpoint = config["endpoint"] as? String,
              let configuredFormat = config["format"] as? String,
              configuredEndpoint == endpoint,
              configuredFormat == format else {
            return nil
        }
        guard let url = URL(string: endpoint),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil,
              url.user == nil,
              url.fragment == nil else {
            return nil
        }
        guard format == "messages" || format == "chat" || format == "responses" else {
            return nil
        }
        let key = config["apiKey"] as? String ?? ""
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if format == "messages" {
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            if !key.isEmpty { request.setValue(key, forHTTPHeaderField: "x-api-key") }
        } else if !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body.data(using: .utf8)

        let id = UUID().uuidString
        let exchange = Exchange(
            id: id,
            request: request,
            emit: { [weak self] payload in
                self?.onEvent?(payload)
            },
            finish: { [weak self] in
                self?.remove(id)
            }
        )
        lock.lock()
        exchanges[id] = exchange
        lock.unlock()
        exchange.start()
        return id
    }

    func cancel(_ id: String) {
        lock.lock()
        let exchange = exchanges.removeValue(forKey: id)
        lock.unlock()
        exchange?.cancel()
    }

    func close() {
        lock.lock()
        let all = Array(exchanges.values)
        exchanges.removeAll()
        lock.unlock()
        all.forEach { $0.cancel() }
    }

    private func remove(_ id: String) {
        lock.lock()
        exchanges.removeValue(forKey: id)
        lock.unlock()
    }
}

private final class Exchange: NSObject, URLSessionDataDelegate {
    private let id: String
    private let request: URLRequest
    private let emit: (String) -> Void
    private let finish: () -> Void
    private let delegateQueue: OperationQueue
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var cancelled = false
    private var completed = false

    init(id: String, request: URLRequest, emit: @escaping (String) -> Void, finish: @escaping () -> Void) {
        self.id = id
        self.request = request
        self.emit = emit
        self.finish = finish
        let queue = OperationQueue()
        queue.name = "io.github.wydeepseek.chat-transport"
        queue.maxConcurrentOperationCount = 1
        delegateQueue = queue
    }

    func start() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 180
        configuration.timeoutIntervalForResource = 600
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        self.session = session
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
    }

    func cancel() {
        cancelled = true
        task?.cancel()
        session?.invalidateAndCancel()
        session = nil
        finish()
    }

    private func close() {
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func event(_ type: String, _ extra: [String: Any] = [:]) {
        var payload: [String: Any] = ["id": id, "type": type]
        for (key, value) in extra { payload[key] = value }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        emit(json)
    }

    private func complete(_ eventType: String?) {
        if completed { return }
        completed = true
        if let eventType { event(eventType) }
        close()
        finish()
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            event("error")
            completionHandler(.cancel)
            complete(nil)
            return
        }
        let status = http.statusCode
        if status < 200 || status > 599 || (300..<400).contains(status) {
            event("error")
            cancelled = true
            completionHandler(.cancel)
            complete(nil)
            return
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        let mime = contentType.contains("text/event-stream") ? "text/event-stream" : "text/plain"
        event("headers", ["status": status, "mime": mime])
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !cancelled else { return }
        event("data", ["bytes": data.base64EncodedString()])
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            let isCancellation = (error as NSError).code == NSURLErrorCancelled
            if !cancelled && !isCancellation {
                complete("error")
            } else {
                complete(nil)
            }
            return
        }
        complete(cancelled ? nil : "end")
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        // Android disables redirects; a redirect is not a valid streaming response.
        completionHandler(nil)
    }
}
