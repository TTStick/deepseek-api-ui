import XCTest
import UIKit
import Darwin

final class BridgeUITests: XCTestCase {
    private let endpoint = "http://127.0.0.1:8099/v1/chat/completions"

    private func launchSeeded() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["DSW_SEED_CHAT_ENDPOINT"] = endpoint
        app.launchEnvironment["DSW_SEED_CHAT_KEY"] = "test"
        app.launchEnvironment["DSW_SEED_CHAT_MODEL"] = "deepseek-chat"
        app.launchEnvironment["DSW_SEED_LOCALE"] = "zh-CN"
        app.launchEnvironment["DSW_SEED_THEME"] = "system"
        return app
    }

    private func launchServerSeeded() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["DSW_SEED_SERVER_URL"] = "http://127.0.0.1:8099"
        app.launchEnvironment["DSW_SEED_SERVER_TOKEN"] = "test"
        app.launchEnvironment["DSW_SEED_LOCALE"] = "zh-CN"
        app.launchEnvironment["DSW_SEED_THEME"] = "system"
        return app
    }

    private func attach(_ screenshot: XCUIScreenshot, _ name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func sendMessage(
        _ app: XCUIApplication,
        _ web: XCUIElement,
        _ text: String
    ) {
        let composer = web.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "Composer did not appear")
        composer.tap()
        composer.typeText(text)
        let sendCN = web.buttons["发送"].firstMatch
        let sendEN = web.buttons["Send"].firstMatch
        if sendCN.waitForExistence(timeout: 4) {
            sendCN.tap()
        } else {
            XCTAssertTrue(sendEN.waitForExistence(timeout: 6), "Send button did not appear")
            sendEN.tap()
        }
    }

    private func waitForReply(_ web: XCUIElement) -> XCUIElement {
        let reply = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "iOS 模拟服务")
        ).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 40), "Streaming reply did not render")
        return reply
    }

    func testServerModeAndTailscale() throws {
        let app = XCUIApplication()
        app.launchEnvironment["DSW_SEED_SERVER_URL"] = "http://127.0.0.1:8099"
        app.launchEnvironment["DSW_SEED_SERVER_TOKEN"] = "test"
        app.launchEnvironment["DSW_SEED_LOCALE"] = "zh-CN"
        app.launchEnvironment["DSW_SEED_THEME"] = "system"
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))
        sendMessage(app, web, "服务器模式测试")
        let reply = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "iOS 模拟服务")
        ).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 40), "Server-mode reply did not render")
        attach(app.screenshot(), "server-chat")

        let menu = web.buttons["打开侧边栏"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        let settings = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "设置")
        ).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        settings.tap()

        let account = web.buttons["账号管理"].firstMatch
        if account.waitForExistence(timeout: 8) {
            account.tap()
            sleep(1)
        }
        web.swipeUp()
        web.swipeUp()
        attach(app.screenshot(), "account-tailscale")

        let toggle = web.switches["内置 Tailscale"].firstMatch
        if toggle.waitForExistence(timeout: 6) {
            toggle.tap()
        } else {
            let fallback = web.buttons["内置 Tailscale"].firstMatch
            if fallback.waitForExistence(timeout: 4) {
                fallback.tap()
            }
        }
        sleep(6)
        attach(app.screenshot(), "tailscale-status")
    }

    func testAttachmentPanel() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let upload = web.buttons["上传文件"].firstMatch
        XCTAssertTrue(upload.waitForExistence(timeout: 15), "Upload button did not appear")
        upload.tap()
        sleep(3)
        attach(app.screenshot(), "attachments")
    }

    func testOpenInAppBrowser() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))
        sendMessage(app, web, "打开链接")
        _ = waitForReply(web)

        let link = web.links["示例链接"].firstMatch
        if link.waitForExistence(timeout: 8) {
            link.tap()
        } else {
            let text = web.staticTexts["示例链接"].firstMatch
            XCTAssertTrue(text.waitForExistence(timeout: 8), "Markdown link did not render")
            text.tap()
        }

        let close = app.buttons["关闭"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 20), "In-app browser did not open")
        sleep(2)
        attach(app.screenshot(), "in-app-browser")
        close.tap()
    }

    func testVoiceRecording() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let voiceSwitch = web.switches["切换至语音"].firstMatch
        let voiceButton = web.buttons["切换至语音"].firstMatch
        if voiceSwitch.waitForExistence(timeout: 15) {
            voiceSwitch.tap()
        } else if voiceButton.waitForExistence(timeout: 5) {
            voiceButton.tap()
        } else {
            XCTFail("Voice mode toggle did not appear")
        }
        let hold = web.buttons["按住说话"].firstMatch
        XCTAssertTrue(hold.waitForExistence(timeout: 10), "Hold-to-talk button did not appear")
        hold.press(forDuration: 2.0)
        sleep(4)
        attach(app.screenshot(), "voice")
    }

    func testHistoryExportPicker() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let menu = web.buttons["打开侧边栏"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        let settings = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "设置")
        ).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        settings.tap()

        let data = web.buttons["数据管理"].firstMatch
        XCTAssertTrue(data.waitForExistence(timeout: 8))
        data.tap()
        let export = web.buttons["导出所有历史对话"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 8))
        export.tap()
        let save = web.buttons["保存到设备"].firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 8))
        save.tap()

        // The native FileExport writes a temp archive and then presents the Files picker.
        let cancelCN = app.buttons["取消"].firstMatch
        let cancelEN = app.buttons["Cancel"].firstMatch
        if cancelCN.waitForExistence(timeout: 25) {
            attach(app.screenshot(), "history-export-picker")
            cancelCN.tap()
        } else {
            XCTAssertTrue(cancelEN.waitForExistence(timeout: 5), "Document picker did not appear")
            attach(app.screenshot(), "history-export-picker")
            cancelEN.tap()
        }
    }

    func testEnglishServerChatParity() throws {
        let app = XCUIApplication()
        app.launchEnvironment["DSW_SEED_SERVER_URL"] = "http://127.0.0.1:8099"
        app.launchEnvironment["DSW_SEED_SERVER_TOKEN"] = "test"
        app.launchEnvironment["DSW_SEED_LOCALE"] = "en-US"
        app.launchEnvironment["DSW_SEED_THEME"] = "system"
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))
        sendMessage(app, web, "Hello Androidp")
        _ = waitForReply(web)
        attach(app.screenshot(), "chat-english")
    }

    func testTailscaleLoginThroughTunnelToNAS() throws {
        let nasURL = ProcessInfo.processInfo.environment["NAS_TEST_URL"] ?? "http://100.104.209.43:8000"
        let nasPassword = ProcessInfo.processInfo.environment["NAS_TEST_PASSWORD"] ?? ""
        try XCTSkipIf(nasPassword.isEmpty, "Set NAS_TEST_PASSWORD to run the real NAS test")
        let app = XCUIApplication()
        app.launchEnvironment["DSW_RESET_CONFIG"] = "1"
        app.launchEnvironment["DSW_SEED_LOCALE"] = "zh-CN"
        app.launchEnvironment["DSW_SEED_THEME"] = "system"
        app.launchEnvironment["DSW_SEED_SERVER_INPUT"] = nasURL
        app.launchEnvironment["DSW_SEED_SERVER_PASSWORD"] = nasPassword
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let urlField = web.textFields["服务器地址"].firstMatch
        XCTAssertTrue(urlField.waitForExistence(timeout: 20), "Server URL field missing")
        sleep(2)
        XCTAssertEqual(urlField.value as? String, nasURL, "URL debug seed did not apply")

        let toggle = web.switches["通过内置 Tailscale 连接"].firstMatch
        let checkBox = web.checkBoxes["通过内置 Tailscale 连接"].firstMatch
        let label = web.staticTexts["通过内置 Tailscale 连接"].firstMatch
        if toggle.waitForExistence(timeout: 6) {
            toggle.tap()
        } else if checkBox.waitForExistence(timeout: 3) {
            checkBox.tap()
        } else if label.waitForExistence(timeout: 3) {
            label.tap()
        } else {
            XCTFail("Tailscale toggle missing")
        }
        attach(app.screenshot(), "tailscale-starting")

        // The test app container may be fresh, so the node can need a fresh browser
        // authorization. Poll for the login URL and wait long enough for a human click.
        let ready = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "隧道已就绪")
        ).firstMatch
        let loginLink = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "login.tailscale.com")
        ).firstMatch
        let deadline = Date().addingTimeInterval(240)
        var announced = false
        while Date() < deadline {
            if ready.exists { break }
            if !announced, loginLink.exists {
                print("TAILSCALE_LOGIN_URL=\(loginLink.label)")
                announced = true
            }
            sleep(2)
        }
        XCTAssertTrue(ready.exists, "Tunnel did not become ready (login URL: \(loginLink.label))")
        attach(app.screenshot(), "tailscale-ready")

        let connect = web.buttons["连接"].firstMatch
        if !connect.isHittable {
            web.swipeUp()
        }
        XCTAssertTrue(connect.waitForExistence(timeout: 10), "Connect button missing")
        connect.tap()

        let menu = web.buttons["打开侧边栏"].firstMatch
        if !menu.waitForExistence(timeout: 60) {
            let error = web.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "密码错误")
            ).firstMatch
            if error.exists {
                XCTFail("NAS login failed: \(error.label)")
            } else {
                XCTFail("Login through the tunnel did not enter the chat")
            }
        }
        attach(app.screenshot(), "tailscale-connected")

        sendMessage(app, web, "Tailscale 隧道验证")
        let regenerate = web.buttons["重新生成"].firstMatch
        XCTAssertTrue(regenerate.waitForExistence(timeout: 120), "No assistant reply through the tunnel")
        sleep(10)
        attach(app.screenshot(), "tailscale-reply")
    }

    func testPhotoMessageViewerAndSave() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let upload = web.buttons["上传文件"].firstMatch
        XCTAssertTrue(upload.waitForExistence(timeout: 15), "Upload button missing")
        upload.tap()
        sleep(2)
        // First recent photo in the attachment grid (the seeded app icon).
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.13, dy: 0.76)).tap()
        sleep(3)

        let composer = web.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "Composer missing after photo pick")
        composer.tap()
        composer.typeText("图片测试")
        let send = web.buttons["发送"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "Send button missing")
        send.tap()

        let reply = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "iOS 模拟服务")
        ).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 45), "Reply missing")

        let imageButton = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "AppIcon")
        ).firstMatch
        if !imageButton.exists {
            let labels = web.buttons.allElementsBoundByIndex.map { $0.label }.filter { !$0.isEmpty }
            XCTFail("Sent image button missing; buttons=\(labels)")
        }
        imageButton.tap()

        let save = web.buttons["保存到相册"].firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 15), "Image viewer save button missing")
        save.tap()
        let saved = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "已保存到相册")
        ).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 20), "Image save did not complete")
        attach(app.screenshot(), "image-saved")
    }

    func testIPadLandscapeLayout() throws {
        try XCTSkipUnless(
            UIDevice.current.userInterfaceIdiom == .pad,
            "iPad-only layout test"
        )
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }

        let app = launchServerSeeded()
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))
        let window = app.windows.firstMatch
        XCTAssertGreaterThan(window.frame.width, window.frame.height, "Simulator did not enter landscape")

        let search = web.buttons["搜索对话内容..."].firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 15), "Sidebar is not open on iPad landscape")
        XCTAssertTrue(
            web.staticTexts["暂无对话"].firstMatch.waitForExistence(timeout: 8),
            "Sidebar empty state is missing"
        )
        let emptyNewChat = web.buttons["开启新对话"].firstMatch
        XCTAssertTrue(emptyNewChat.waitForExistence(timeout: 8), "Empty state new-chat button is missing")
        attach(app.screenshot(), "ipad-landscape-sidebar")

        let composer = web.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "Composer is missing")
        let openWidth = composer.frame.width

        let collapse = web.buttons["收起边栏"].firstMatch
        XCTAssertTrue(collapse.waitForExistence(timeout: 8), "Collapse pill is missing")
        collapse.tap()
        let expand = web.buttons["打开侧边栏"].firstMatch
        XCTAssertTrue(expand.waitForExistence(timeout: 8), "Sidebar did not collapse")
        sleep(1)
        attach(app.screenshot(), "ipad-landscape-collapsed")
        let collapsedWidth = composer.frame.width
        XCTAssertGreaterThan(
            collapsedWidth,
            openWidth + 200,
            "Composer did not widen after collapsing the sidebar"
        )

        expand.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 8), "Sidebar did not reopen")

        let settings = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "设置")
        ).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8), "Settings entry is missing")
        settings.tap()

        let close = web.buttons["关闭"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "Settings close X is missing")
        XCTAssertTrue(
            web.staticTexts["设置"].firstMatch.waitForExistence(timeout: 8),
            "Settings title is missing"
        )
        attach(app.screenshot(), "ipad-settings-modal")
        close.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 8), "Sidebar disappeared after closing settings")
    }

    private func mark(_ name: String) {
        print("MARK: \(name)")
        fflush(stdout)
    }

    func testIPadDetailedUI() throws {
        try XCTSkipUnless(
            UIDevice.current.userInterfaceIdiom == .pad,
            "iPad-only detailed UI test"
        )
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }

        let app = launchServerSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))
        XCTAssertGreaterThan(app.windows.firstMatch.frame.width, app.windows.firstMatch.frame.height)

        func snap(_ name: String) {
            print("MARK: \(name)")
            fflush(stdout)
            attach(app.screenshot(), "detail-\(name)")
            sleep(2)
        }

        snap("welcome")

        sendMessage(app, web, "iPad 平板详细测试")
        let reply = waitForReply(web)
        sleep(2)
        snap("chat")

        let settings = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "设置")
        ).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 8), "Settings entry missing")
        settings.tap()
        XCTAssertTrue(web.buttons["关闭"].firstMatch.waitForExistence(timeout: 10), "Settings modal missing")
        snap("settings-root")

        let account = web.buttons["账号管理"].firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 8))
        account.tap()
        sleep(1)
        snap("settings-account")
        if web.buttons["返回"].firstMatch.exists {
            web.buttons["返回"].firstMatch.tap()
            sleep(1)
        }

        let data = web.buttons["数据管理"].firstMatch
        XCTAssertTrue(data.waitForExistence(timeout: 8))
        data.tap()
        sleep(1)
        snap("settings-data")
        if web.buttons["返回"].firstMatch.exists {
            web.buttons["返回"].firstMatch.tap()
            sleep(1)
        }

        let usage = web.buttons["消耗"].firstMatch
        if usage.waitForExistence(timeout: 5) {
            usage.tap()
            sleep(2)
            snap("settings-usage")
            if web.buttons["返回"].firstMatch.exists {
                web.buttons["返回"].firstMatch.tap()
                sleep(1)
            }
        }

        if web.buttons["关闭"].firstMatch.exists {
            web.buttons["关闭"].firstMatch.tap()
            sleep(1)
        }

        let upload = web.buttons["上传文件"].firstMatch
        XCTAssertTrue(upload.waitForExistence(timeout: 8), "Upload entry missing")
        upload.tap()
        sleep(2)
        snap("attachments")
        if web.buttons["关闭"].firstMatch.exists {
            web.buttons["关闭"].firstMatch.tap()
        } else {
            upload.tap()
        }
        sleep(1)

        web.swipeDown()
        sleep(1)
        reply.press(forDuration: 0.9)
        // The Android-style menu renders as menuitem buttons on iPad; match by label
        // regardless of the accessibility element type.
        let selectText = web.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "选择文本"))
            .firstMatch
        XCTAssertTrue(selectText.waitForExistence(timeout: 6), "Long-press menu missing")
        snap("longpress-menu")
        selectText.tap()
        sleep(1)
        snap("selection")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
        sleep(1)

        settings.tap()
        XCTAssertTrue(
            web.buttons["关闭"].firstMatch.waitForExistence(timeout: 10),
            "Settings did not reopen"
        )
        snap("settings-reopen")
        // Rows with a value expose a combined label such as "外观，系统".
        let appearance = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "外观")
        ).firstMatch
        XCTAssertTrue(appearance.waitForExistence(timeout: 8), "Appearance row missing")
        appearance.tap()
        sleep(1)
        snap("appearance")
        // Appearance opens a choice dialog (系统/浅色/深色 + 确认), not a subpage.
        let dark = web.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "深色"))
            .firstMatch
        XCTAssertTrue(dark.waitForExistence(timeout: 6), "Dark option missing")
        dark.tap()
        sleep(1)
        snap("appearance-dark-choice")
        let confirm = web.buttons["确认"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Appearance confirm missing")
        confirm.tap()
        sleep(1)
        snap("dark-settings")
        if web.buttons["关闭"].firstMatch.exists {
            web.buttons["关闭"].firstMatch.tap()
            sleep(1)
        }
        snap("dark-chat")

        // Make sure no modal is left before focusing the composer.
        if web.buttons["关闭"].firstMatch.exists {
            web.buttons["关闭"].firstMatch.tap()
            sleep(1)
        }
        let composer = web.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8), "Composer missing")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Keyboard did not appear")
        snap("keyboard")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.06)).tap()
        sleep(1)

        XCUIDevice.shared.orientation = .portrait
        sleep(3)
        snap("portrait")
    }

    func testStreamingReplyAndNativeStorage() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40), "WebView did not appear")

        sendMessage(app, web, "你好，iOS")
        let reply = waitForReply(web)
        XCTAssertTrue(reply.label.contains("流式回复"), "Reply text was incomplete: \(reply.label)")

        let code = web.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "console.log")
        ).firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 10), "Markdown code block did not render")
        attach(app.screenshot(), "chat-reply")
    }

    func testKeyboardDrawerSettingsAndSelection() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let composer = web.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        composer.tap()
        composer.typeText("测试键盘布局")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Keyboard did not appear")
        attach(app.screenshot(), "keyboard")

        let send = web.buttons["发送"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.tap()
        let reply = waitForReply(web)

        // Long-press the assistant reply: WKWebView has no contextmenu, so the injected
        // script synthesises one for the Android-style selection menu.
        reply.press(forDuration: 0.9)
        attach(app.screenshot(), "after-longpress")
        sleep(1)
        let selectText = web.staticTexts["选择文本"].firstMatch
        let selectButton = web.buttons["选择文本"].firstMatch
        if selectText.waitForExistence(timeout: 6) {
            selectText.tap()
        } else if selectButton.waitForExistence(timeout: 3) {
            selectButton.tap()
        }
        attach(app.screenshot(), "selection-menu")

        // Leave selection mode, then open the drawer and settings.
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
        let menu = web.buttons["打开侧边栏"].firstMatch
        if menu.waitForExistence(timeout: 6) {
            menu.tap()
        }
        attach(app.screenshot(), "drawer")

        let settings = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "设置")
        ).firstMatch
        if settings.waitForExistence(timeout: 8) {
            settings.tap()
            attach(app.screenshot(), "settings")
        }
    }

    func testSessionPersistsAcrossRelaunch() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))
        sendMessage(app, web, "重启后还在吗")
        _ = waitForReply(web)

        app.terminate()
        app.launch()

        let relaunchedWeb = app.webViews.firstMatch
        XCTAssertTrue(relaunchedWeb.waitForExistence(timeout: 40))
        let header = relaunchedWeb.staticTexts["重启后还在吗"].firstMatch
        if !header.waitForExistence(timeout: 15) {
            let menu = relaunchedWeb.buttons["打开侧边栏"].firstMatch
            if menu.waitForExistence(timeout: 8) {
                menu.tap()
            }
            XCTAssertTrue(
                relaunchedWeb.staticTexts["重启后还在吗"].firstMatch.waitForExistence(timeout: 15),
                "Session did not persist across relaunch"
            )
        }
        attach(app.screenshot(), "relaunch-persistence")
    }

    func testSearchTyping() throws {
        let app = launchSeeded()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let menu = web.buttons["打开侧边栏"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "Drawer button missing")
        menu.tap()
        let search = web.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "搜索对话内容")
        ).firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 8), "Search entry missing")
        search.tap()

        let field = web.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 8), "Search field missing")
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
        field.typeText("测试")
        sleep(1)
        attach(app.screenshot(), "search-typed")
        XCTAssertTrue((field.value as? String ?? "").contains("测试"), "Search text did not enter")
    }

    func testServerLoginTyping() throws {
        let app = XCUIApplication()
        app.launchEnvironment["DSW_RESET_CONFIG"] = "1"
        app.launchEnvironment["DSW_SEED_LOCALE"] = "zh-CN"
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 40))

        let url = web.textFields["服务器地址"].firstMatch
        XCTAssertTrue(url.waitForExistence(timeout: 15), "Server URL field missing")
        url.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Keyboard did not appear")
        url.typeText("http://127.0.0.1:8099")
        sleep(1)
        attach(app.screenshot(), "server-login-url")
        XCTAssertEqual(
            url.value as? String,
            "http://127.0.0.1:8099",
            "Server URL text did not enter the field"
        )

        let password = web.secureTextFields["访问密码"].firstMatch
        XCTAssertTrue(password.waitForExistence(timeout: 10), "Server password field missing")
        password.tap()
        password.typeText("test1234")
        sleep(1)
        attach(app.screenshot(), "server-login-password")
        let value = password.value as? String ?? ""
        XCTAssertFalse(
            value.isEmpty || value == "服务器设置里的访问密码（未设置可留空）",
            "Server password text did not enter the field"
        )
    }
}
