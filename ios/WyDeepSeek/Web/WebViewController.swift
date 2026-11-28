import AVFoundation
import UIKit
import WebKit

/// WKWebView container that hosts the bundled React app and reproduces the Android
/// container contract: loopback asset origin, synchronous JS bridge, safe-area and
/// keyboard insets, status-bar appearance, external-link isolation.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let services = AppServices.shared
    private var webView: WKWebView!
    private var bridge: Bridge!
    private var server: HTTPServer!
    private var observers: [NSObjectProtocol] = []
    private var darkBars = false
    private var imageFullscreen = false
    private var keyboardVisible = false
    private var keyboardOverlap: CGFloat = 0
    private var lastStatusInset: Double = -1
    private var lastNavigationInset: Double = -1
    private var lastKeyboard: Bool = false
    private var didLoadPage = false

    var statusInsetValue: Double {
        Double(currentSafeInsets().top)
    }

    var buttonNavigationInsetValue: Double {
        keyboardVisible ? 0 : Double(currentSafeInsets().bottom)
    }

    // MARK: - Lifecycle

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(hex: 0xFFFFFF)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        services.host = self
        bridge = Bridge(services: services)
        bridge.host = self

        configureWebView()
        startServer()
        observeKeyboard()
        observeApplication()

        #if DEBUG
        seedDebugConfiguration()
        #endif

        installCookieAndLoad()
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutWebView()
        updateJavaScriptInsets(force: false)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        darkBars ? .lightContent : .darkContent
    }

    override var prefersStatusBarHidden: Bool {
        imageFullscreen
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        imageFullscreen
    }

    // MARK: - Configuration

    private func configureWebView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isTextInteractionEnabled = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.dataDetectorTypes = []
        configuration.suppressesIncrementalRendering = false

        if let url = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        if let url = Bundle.main.url(forResource: "longpress", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
        }
        #if DEBUG
        if let url = Bundle.main.url(forResource: "errorlog", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
            configuration.userContentController.add(LogSink.shared, name: "dsLog")
        }
        addServerSeed(to: configuration)
        addPresentationSeed(to: configuration)
        #endif
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = true
        webView.backgroundColor = UIColor(hex: 0xFFFFFF)
        webView.scrollView.backgroundColor = UIColor(hex: 0xFFFFFF)
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.inputAssistantItem.leadingBarButtonGroups = []
        webView.inputAssistantItem.trailingBarButtonGroups = []
        webView.translatesAutoresizingMaskIntoConstraints = true
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif
        view.addSubview(webView)
    }

    private func startServer() {
        server = HTTPServer(services: services)
        do {
            try server.start()
        } catch {
            NSLog("HTTP server failed: %@", String(describing: error))
        }
    }

    private func installCookieAndLoad() {
        let cookie = HTTPCookie(properties: [
            .domain: "127.0.0.1",
            .path: "/",
            .name: HTTPServer.cookieName,
            .value: HTTPServer.token,
            .secure: "FALSE",
            .expires: Date().addingTimeInterval(60 * 60 * 24 * 365),
        ])
        let load = { [weak self] in
            DispatchQueue.main.async { self?.loadApp() }
        }
        if let cookie {
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                load()
            }
        } else {
            load()
        }
    }

    private func loadApp() {
        guard let url = URL(string: "http://127.0.0.1:\(HTTPServer.port)/index.html") else { return }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30
        webView.load(request)
    }

    // MARK: - Layout and insets

    private func currentSafeInsets() -> UIEdgeInsets {
        if let window = view.window {
            return window.safeAreaInsets
        }
        return view.safeAreaInsets
    }

    private func layoutWebView() {
        let safe = currentSafeInsets()
        var frame = view.bounds
        frame.origin.x = safe.left
        frame.size.width = max(0, view.bounds.width - safe.left - safe.right)
        if keyboardVisible {
            frame.size.height = max(0, frame.size.height - keyboardOverlap)
        }
        webView.frame = frame
    }

    private func updateJavaScriptInsets(force: Bool) {
        guard webView != nil, didLoadPage else { return }
        let status = Double(currentSafeInsets().top)
        let navigation = keyboardVisible ? 0 : Double(currentSafeInsets().bottom)
        let keyboard = keyboardVisible
        if !force, status == lastStatusInset, navigation == lastNavigationInset, keyboard == lastKeyboard {
            return
        }
        lastStatusInset = status
        lastNavigationInset = navigation
        lastKeyboard = keyboard
        let keyboardScript = keyboard
            ? "root.setAttribute('data-keyboard','');"
            : "root.removeAttribute('data-keyboard');"
        let script = """
        if (document.documentElement) {
          const root = document.documentElement;
          root.style.setProperty('--android-status-inset', '\(status)px');
          root.style.setProperty('--android-button-nav-inset', '\(navigation)px');
          \(keyboardScript)
        }
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func observeKeyboard() {
        let center = NotificationCenter.default
        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardWillChangeFrameNotification,
                object: nil,
                queue: .main
            ) { [weak self] note in
                self?.keyboardChanged(note, hiding: false)
            }
        )
        observers.append(
            center.addObserver(
                forName: UIResponder.keyboardWillHideNotification,
                object: nil,
                queue: .main
            ) { [weak self] note in
                self?.keyboardChanged(note, hiding: true)
            }
        )
    }

    private func keyboardChanged(_ note: Notification, hiding: Bool) {
        var overlap: CGFloat = 0
        if !hiding,
           let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            let converted = view.convert(frame, from: nil)
            overlap = max(0, view.bounds.maxY - converted.minY)
            if overlap < 1 { overlap = 0 }
        }
        let visible = overlap > 0
        if visible == keyboardVisible && abs(overlap - keyboardOverlap) < 0.5 {
            return
        }
        keyboardVisible = visible
        keyboardOverlap = overlap
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curve = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt) ?? 7
        view.setNeedsLayout()
        UIView.animate(
            withDuration: duration,
            delay: 0,
            options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]
        ) {
            self.view.layoutIfNeeded()
        }
        updateJavaScriptInsets(force: true)
    }

    private func observeApplication() {
        let center = NotificationCenter.default
        observers.append(
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.services.recorder.finish(keep: false)
                self.services.emit("android-recording-interrupted", "null")
            }
        )
        observers.append(
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.updateJavaScriptInsets(force: true)
            }
        )
    }

    // MARK: - Bridge → view

    func emit(_ name: String, detailJSON: String) {
        guard isViewLoaded, webView != nil else { return }
        let script = "window.dispatchEvent(new CustomEvent('\(name)', {detail: \(detailJSON)}))"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Text interaction is off by default so long-press keeps using the Android-style
    /// custom selection menu. Form fields need it temporarily to accept typed text.
    func setTextInteraction(_ enabled: Bool) {
        webView.configuration.preferences.isTextInteractionEnabled = enabled
    }

    func setDarkBars(_ dark: Bool) {
        darkBars = dark
        let background = UIColor(hex: dark ? 0x151517 : 0xFFFFFF)
        view.backgroundColor = background
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        setNeedsStatusBarAppearanceUpdate()
    }

    func setImageViewerFullscreen(_ fullscreen: Bool) {
        imageFullscreen = fullscreen
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    func openSourcePage(
        url: URL,
        dark: Bool,
        closeLabel: String,
        browserLabel: String,
        loadingLabel: String,
        errorLabel: String,
        retryLabel: String
    ) {
        let browser = SourceBrowserViewController(
            url: url,
            dark: dark,
            closeLabel: closeLabel,
            browserLabel: browserLabel,
            loadingLabel: loadingLabel,
            errorLabel: errorLabel,
            retryLabel: retryLabel
        )
        var presenter: UIViewController = self
        while let next = presenter.presentedViewController {
            presenter = next
        }
        presenter.present(browser, animated: true)
    }

    private func openExternal(_ url: URL) {
        let labels = Self.browserLabels()
        openSourcePage(
            url: url,
            dark: darkBars,
            closeLabel: labels.close,
            browserLabel: labels.browser,
            loadingLabel: labels.loading,
            errorLabel: labels.error,
            retryLabel: labels.retry
        )
    }

    // MARK: - WKNavigationDelegate

    private func isBundled(_ url: URL) -> Bool {
        url.scheme == "http"
            && url.host == "127.0.0.1"
            && url.port == Int(HTTPServer.port)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isBundled(url) {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" {
            if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true {
                openExternal(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if scheme == "tel" || scheme == "mailto" || scheme == "sms" {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didLoadPage = true
        updateJavaScriptInsets(force: true)
        #if DEBUG
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.webView.evaluateJavaScript(
                """
                JSON.stringify({
                  href: location.href,
                  ready: document.readyState,
                  text: (document.body.innerText || '').slice(0, 400),
                  rootLength: (document.getElementById('root') || {}).innerHTML
                    ? document.getElementById('root').innerHTML.length : 0,
                  android: !!window.DeepSeekAndroid,
                  androidAttr: document.documentElement.getAttribute('data-android'),
                  theme: document.documentElement.getAttribute('data-ds-dark-theme'),
                  bodyRect: (function () {
                    var r = document.body.getBoundingClientRect();
                    return [r.width, r.height];
                  })(),
                  frameRect: (function () {
                    var el = document.querySelector('[class*="frame"]');
                    if (!el) return null;
                    var r = el.getBoundingClientRect();
                    return [r.left, r.top, r.width, r.height];
                  })(),
                  storageKeys: Object.keys(localStorage).slice(0, 20)
                })
                """
            ) { value, error in
                NSLog("DOM: %@ / %@", String(describing: value), String(describing: error))
            }
        }
        #endif
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("WebView navigation failed: %@", error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        NSLog("WebView provisional navigation failed: %@", error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        if Bridge.isBridgePrompt(prompt) {
            completionHandler(bridge.handle(prompt))
        } else {
            completionHandler(defaultText)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            let scheme = url.scheme?.lowercased() ?? ""
            if scheme == "http" || scheme == "https" {
                openExternal(url)
            } else if scheme == "tel" || scheme == "mailto" || scheme == "sms" {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
        }
        return nil
    }

    // MARK: - Debug seeding

    #if DEBUG
    /// Locale/theme/reset seeds used by manual parity runs and UI tests.
    private func addPresentationSeed(to configuration: WKWebViewConfiguration) {
        let environment = ProcessInfo.processInfo.environment
        var script = ""
        if let locale = environment["DSW_SEED_LOCALE"], locale == "en-US" || locale == "zh-CN" {
            script += "try{localStorage.setItem('chat-demo:locale','\(locale)')}catch(e){}"
        }
        if let theme = environment["DSW_SEED_THEME"],
           theme == "dark" || theme == "light" || theme == "system" {
            script += "try{localStorage.setItem('chat-demo:theme-preference','\(theme)')}catch(e){}"
        }
        if environment["DSW_RESET_CONFIG"] == "1" {
            script += """
            try{
              ['myagent:server-config','replica:chat-config','chat-demo:api-key']
                .forEach(function(k){localStorage.removeItem(k)})
            }catch(e){}
            """
        }
        if let serverInput = environment["DSW_SEED_SERVER_INPUT"], !serverInput.isEmpty {
            let password = environment["DSW_SEED_SERVER_PASSWORD"] ?? ""
            script += """
            (function(){
              var url = \(Self.jsString(serverInput));
              var password = \(Self.jsString(password));
              var tries = 0;
              var timer = setInterval(function(){
                var input = document.querySelector('input[type="url"]');
                if (input) {
                  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                  setter.call(input, url);
                  input.dispatchEvent(new Event('input', {bubbles:true}));
                  input.dispatchEvent(new Event('change', {bubbles:true}));
                  var pw = document.querySelector('input[type="password"]');
                  if (pw && password) {
                    setter.call(pw, password);
                    pw.dispatchEvent(new Event('input', {bubbles:true}));
                    pw.dispatchEvent(new Event('change', {bubbles:true}));
                  }
                  clearInterval(timer);
                }
                if (++tries > 200) clearInterval(timer);
              }, 100);
            })();
            """
        }
        guard !script.isEmpty else { return }
        configuration.userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
    }

    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return json
    }
    #endif

    #if DEBUG
    private func addServerSeed(to configuration: WKWebViewConfiguration) {
        let environment = ProcessInfo.processInfo.environment
        guard let url = environment["DSW_SEED_SERVER_URL"],
              let token = environment["DSW_SEED_SERVER_TOKEN"],
              !url.isEmpty else {
            // Chat-only tests must not inherit a server config from a previous run.
            if environment["DSW_SEED_CHAT_ENDPOINT"] != nil {
                let source = "try{localStorage.removeItem('myagent:server-config')}catch(e){}"
                configuration.userContentController.addUserScript(
                    WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
                )
            }
            return
        }
        let config: [String: Any] = [
            "url": url,
            "directUrl": url,
            "tunnel": false,
            "token": token,
            "agent": true,
            "memory": true,
            "conversationIndex": false,
            "referenceIndex": false,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: config),
              let json = String(data: data, encoding: .utf8) else { return }
        let escaped = json
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let source = "try{localStorage.setItem('myagent:server-config', '\(escaped)')}catch(e){}"
        configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        NSLog("SEED server=%@", url)
    }
    #endif

    #if DEBUG
    private func seedDebugConfiguration() {
        let environment = ProcessInfo.processInfo.environment
        NSLog("SEED env: %@", environment.keys.filter { $0.hasPrefix("DSW_") }.sorted().joined(separator: ","))
        if environment["DSW_SEED_TUNNEL_TARGET"] == nil {
            // Keep debug launches deterministic; UI tests opt into the tunnel explicitly.
            services.tunnel.stop()
        }
        if environment["DSW_RESET_CONFIG"] == "1" {
            services.apiKeys.write(nil, account: "encrypted")
            services.apiKeys.write(nil, account: "custom-chat")
        }
        if let endpoint = environment["DSW_SEED_CHAT_ENDPOINT"], !endpoint.isEmpty {
            let key = environment["DSW_SEED_CHAT_KEY"] ?? "test"
            let model = environment["DSW_SEED_CHAT_MODEL"] ?? "deepseek-chat"
            let config: [String: Any] = [
                "model": model,
                "endpoint": endpoint,
                "format": "chat",
                "apiKey": key,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: config),
               let json = String(data: data, encoding: .utf8) {
                let keyWritten = services.apiKeys.write(key, account: "encrypted")
                let configWritten = services.apiKeys.write(json, account: "custom-chat")
                NSLog(
                    "SEED endpoint=%@ key=%d config=%d read=%@",
                    endpoint,
                    keyWritten ? 1 : 0,
                    configWritten ? 1 : 0,
                    services.apiKeys.read("custom-chat") ?? "nil"
                )
            }
        }
        if let target = environment["DSW_SEED_TUNNEL_TARGET"], !target.isEmpty {
            let status = services.tunnel.start(
                authKey: environment["DSW_SEED_TUNNEL_KEY"],
                target: target,
                hostname: "wydeepseek"
            )
            NSLog("SEED tunnel start=%@", status)
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                NSLog("TUNNEL status=%@", self?.services.tunnel.status() ?? "nil")
            }
            for index in 0..<24 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 5 + Double(index) * 5) { [weak self] in
                    NSLog("TUNNEL[%d] %@", index, self?.services.tunnel.status() ?? "nil")
                }
            }
        }
    }
    #endif

    // MARK: - Constants

    private static func browserLabels() -> (
        close: String,
        browser: String,
        loading: String,
        error: String,
        retry: String
    ) {
        if Locale.preferredLanguages.first?.hasPrefix("zh") == true {
            return ("关闭", "在浏览器中打开", "正在加载…", "无法加载此页面，请重试。", "重试")
        }
        return ("Close", "Open in browser", "Loading…", "Unable to load this page. Please try again.", "Retry")
    }
}

#if DEBUG
private final class LogSink: NSObject, WKScriptMessageHandler {
    static let shared = LogSink()

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        NSLog("JS: %@", String(describing: message.body))
    }
}
#endif
