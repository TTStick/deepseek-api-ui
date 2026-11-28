import UIKit
import WebKit

/// In-app browser for citations and external links. A separate WKWebView without the
/// JavaScript bridge keeps untrusted pages away from `DeepSeekAndroid`, matching
/// Android's `SourceBrowserActivity`.
final class SourceBrowserViewController: UIViewController, WKNavigationDelegate {
    private let initialURL: URL
    private let dark: Bool
    private let closeLabel: String
    private let browserLabel: String
    private let loadingLabel: String
    private let errorLabel: String
    private let retryLabel: String

    private let toolbar = UIView()
    private let titleLabel = UILabel()
    private let divider = UIView()
    private let content = UIView()
    private let webView: WKWebView
    private let loading = UIView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let loadingText = UILabel()
    private let failure = UIView()
    private let failureText = UILabel()
    private let retryButton = UIButton(type: .system)

    private var failed = false
    private var failedURL: URL?
    private var titleObservation: NSKeyValueObservation?

    private var background: UIColor { UIColor(hex: dark ? 0x0F0F0F : 0xFFFFFF) }
    private var foreground: UIColor { UIColor(hex: dark ? 0xF8F8F8 : 0x111111) }
    private var secondary: UIColor { UIColor(hex: dark ? 0xB8B8B8 : 0x666666) }

    init(
        url: URL,
        dark: Bool,
        closeLabel: String,
        browserLabel: String,
        loadingLabel: String,
        errorLabel: String,
        retryLabel: String
    ) {
        initialURL = url
        self.dark = dark
        self.closeLabel = closeLabel
        self.browserLabel = browserLabel
        self.loadingLabel = loadingLabel
        self.errorLabel = errorLabel
        self.retryLabel = retryLabel

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        dark ? .lightContent : .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background
        titleLabel.textColor = foreground
        titleLabel.font = .systemFont(ofSize: 16)
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.text = initialURL.host

        let close = ToolbarIconControl(external: false, color: foreground)
        close.accessibilityLabel = closeLabel
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        let external = ToolbarIconControl(external: true, color: foreground)
        external.accessibilityLabel = browserLabel
        external.addTarget(self, action: #selector(externalTapped), for: .touchUpInside)

        toolbar.backgroundColor = background
        divider.backgroundColor = UIColor(hex: dark ? 0x373737 : 0xE5E5E5)
        toolbar.addSubview(close)
        toolbar.addSubview(titleLabel)
        toolbar.addSubview(external)
        close.tag = 1
        external.tag = 2

        webView.backgroundColor = background
        webView.isOpaque = true
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.scrollView.backgroundColor = background
        content.addSubview(webView)

        loading.backgroundColor = background
        spinner.color = secondary
        loadingText.text = loadingLabel
        loadingText.textColor = secondary
        loadingText.font = .systemFont(ofSize: 14)
        loadingText.textAlignment = .center
        loading.addSubview(spinner)
        loading.addSubview(loadingText)
        content.addSubview(loading)

        failure.backgroundColor = background
        failure.isHidden = true
        failureText.text = errorLabel
        failureText.textColor = foreground
        failureText.font = .systemFont(ofSize: 15)
        failureText.textAlignment = .center
        failureText.numberOfLines = 0
        var configuration = UIButton.Configuration.plain()
        configuration.title = retryLabel
        configuration.baseForegroundColor = foreground
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18)
        retryButton.configuration = configuration
        retryButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        retryButton.layer.borderColor = (dark ? UIColor(hex: 0x555555) : UIColor(hex: 0xCCCCCC)).cgColor
        retryButton.layer.borderWidth = 1
        retryButton.layer.cornerRadius = 8
        retryButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        failure.addSubview(failureText)
        failure.addSubview(retryButton)
        content.addSubview(failure)

        view.addSubview(toolbar)
        view.addSubview(divider)
        view.addSubview(content)

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] webView, _ in
            guard let self, let title = webView.title, !title.isEmpty else { return }
            self.titleLabel.text = title
        }

        showLoading()
        webView.load(URLRequest(url: initialURL))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaInsets
        let width = view.bounds.width
        let toolbarHeight: CGFloat = 52
        toolbar.frame = CGRect(x: 0, y: safe.top, width: width, height: toolbarHeight)
        let iconWidth: CGFloat = 48
        if let close = toolbar.viewWithTag(1), let external = toolbar.viewWithTag(2) {
            close.frame = CGRect(x: 0, y: 0, width: iconWidth, height: toolbarHeight)
            external.frame = CGRect(
                x: toolbar.bounds.width - iconWidth,
                y: 0,
                width: iconWidth,
                height: toolbarHeight
            )
        }
        titleLabel.frame = CGRect(
            x: 56,
            y: 0,
            width: max(0, toolbar.bounds.width - 112),
            height: toolbarHeight
        )
        divider.frame = CGRect(x: safe.left, y: toolbar.frame.maxY, width: width - safe.left - safe.right, height: 1)
        content.frame = CGRect(
            x: safe.left,
            y: divider.frame.maxY,
            width: width - safe.left - safe.right,
            height: max(0, view.bounds.height - safe.bottom - divider.frame.maxY)
        )
        webView.frame = content.bounds
        loading.frame = content.bounds
        failure.frame = content.bounds
        let labelWidth = content.bounds.width - 64
        failureText.frame = CGRect(
            x: 32,
            y: content.bounds.midY - 80,
            width: labelWidth,
            height: 60
        )
        retryButton.sizeToFit()
        retryButton.frame = CGRect(
            x: (content.bounds.width - retryButton.bounds.width) / 2,
            y: failureText.frame.maxY + 20,
            width: retryButton.bounds.width,
            height: retryButton.bounds.height
        )
        spinner.center = CGPoint(x: content.bounds.midX, y: content.bounds.midY - 30)
        loadingText.frame = CGRect(
            x: 32,
            y: spinner.frame.maxY + 12,
            width: content.bounds.width - 64,
            height: 20
        )
    }

    deinit {
        titleObservation?.invalidate()
    }

    // MARK: - Actions

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    @objc private func externalTapped() {
        let url = webView.url ?? failedURL ?? initialURL
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    @objc private func retryTapped() {
        let target = failedURL ?? initialURL
        showLoading()
        webView.load(URLRequest(url: target))
    }

    // MARK: - Overlays

    private func showLoading() {
        failed = false
        webView.isHidden = false
        failure.isHidden = true
        loading.isHidden = false
        spinner.startAnimating()
    }

    private func hideLoading() {
        loading.isHidden = true
        spinner.stopAnimating()
    }

    private func showFailure(_ url: URL?) {
        failed = true
        failedURL = url
        failureText.text = errorLabel
        webView.isHidden = true
        loading.isHidden = true
        spinner.stopAnimating()
        failure.isHidden = false
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        showLoading()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if !failed { hideLoading() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let title = webView.title, !title.isEmpty {
            titleLabel.text = title
        }
        if !failed {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, !self.failed else { return }
                self.hideLoading()
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure(webView.url)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showFailure(webView.url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if let response = navigationResponse.response as? HTTPURLResponse,
           navigationResponse.isForMainFrame,
           response.statusCode >= 400 {
            showFailure(response.url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
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
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

// MARK: - Toolbar icons

private final class ToolbarIconControl: UIControl {
    private let external: Bool
    private let color: UIColor

    init(external: Bool, color: UIColor) {
        self.external = external
        self.color = color
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let pointScale = min(bounds.width, bounds.height) / 48
        context.saveGState()
        context.translateBy(
            x: bounds.midX + (external ? 2 : -2) * pointScale,
            y: bounds.midY
        )
        context.scaleBy(x: pointScale, y: pointScale)
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(1.8 / pointScale)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        if external {
            let outline = CGMutablePath()
            outline.move(to: CGPoint(x: -2, y: -7))
            outline.addLine(to: CGPoint(x: -5, y: -7))
            outline.addQuadCurve(to: CGPoint(x: -7, y: -5), control: CGPoint(x: -7, y: -7))
            outline.addLine(to: CGPoint(x: -7, y: 5))
            outline.addQuadCurve(to: CGPoint(x: -5, y: 7), control: CGPoint(x: -7, y: 7))
            outline.addLine(to: CGPoint(x: 5, y: 7))
            outline.addQuadCurve(to: CGPoint(x: 7, y: 5), control: CGPoint(x: 7, y: 7))
            outline.addLine(to: CGPoint(x: 7, y: 2))
            context.addPath(outline)
            context.strokePath()
            context.move(to: CGPoint(x: 0, y: 0))
            context.addLine(to: CGPoint(x: 8, y: -8))
            context.move(to: CGPoint(x: 2, y: -8))
            context.addLine(to: CGPoint(x: 8, y: -8))
            context.move(to: CGPoint(x: 8, y: -8))
            context.addLine(to: CGPoint(x: 8, y: -2))
            context.strokePath()
        } else {
            context.move(to: CGPoint(x: -6, y: -6))
            context.addLine(to: CGPoint(x: 6, y: 6))
            context.move(to: CGPoint(x: 6, y: -6))
            context.addLine(to: CGPoint(x: -6, y: 6))
            context.strokePath()
        }
        context.restoreGState()
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.45 : 1 }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
