import Foundation

/// Immutable attachment bytes, referenced by SQLite only after a durable write.
/// Direct port of Android's `ChatFiles.java`.
final class ChatFiles {
    private struct Upload {
        let handle: FileHandle
        var prepared: Bool
    }

    private static let tokenPattern = try! NSRegularExpression(pattern: "^[0-9a-fA-F-]{36}$")
    private let directory: URL
    private var uploads: [String: Upload] = [:]
    private let lock = NSRecursiveLock()

    init(root: URL) {
        directory = root.appendingPathComponent("chat-attachments", isDirectory: true)
    }

    private func fileURL(_ token: String) -> URL {
        directory.appendingPathComponent(token, isDirectory: false)
    }

    private static func isValidToken(_ token: String) -> Bool {
        let range = NSRange(token.startIndex..<token.endIndex, in: token)
        return tokenPattern.firstMatch(in: token, options: [], range: range) != nil
    }

    func begin() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        let token = UUID().uuidString.lowercased()
        let url = fileURL(token)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let handle = try FileHandle(forWritingTo: url)
        uploads[token] = Upload(handle: handle, prepared: false)
        return token
    }

    func append(token: String, base64: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard var upload = uploads[token], !upload.prepared, base64.count <= 350_000 else {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        guard let data = Data(base64Encoded: base64, options: []) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try upload.handle.write(contentsOf: data)
        // The struct is a value type; keep the handle and state in the dictionary.
        uploads[token] = upload
    }

    func prepare(token: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard var upload = uploads[token], !upload.prepared else {
            throw CocoaError(.fileNoSuchFile)
        }
        let descriptor = upload.handle.fileDescriptor
        if fcntl(descriptor, F_FULLFSYNC) != 0 {
            fsync(descriptor)
        }
        try upload.handle.close()
        upload.prepared = true
        uploads[token] = upload
    }

    func syncDirectory() {
        for path in [directory.path, directory.deletingLastPathComponent().path] {
            let descriptor = Darwin.open(path, O_RDONLY)
            if descriptor >= 0 {
                fsync(descriptor)
                close(descriptor)
            }
        }
    }

    func committed(_ token: String) {
        lock.lock()
        defer { lock.unlock() }
        uploads.removeValue(forKey: token)
    }

    func abandon(_ token: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let upload = uploads.removeValue(forKey: token) else { return }
        // A prepared file may be referenced if SQLite reported an ambiguous commit failure.
        guard !upload.prepared else { return }
        try? upload.handle.close()
        try? FileManager.default.removeItem(at: fileURL(token))
    }

    func abandonAll() {
        lock.lock()
        let tokens = Array(uploads.keys)
        lock.unlock()
        for token in tokens {
            abandon(token)
        }
    }

    func open(_ token: String) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        guard Self.isValidToken(token), uploads[token] == nil else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: fileURL(token), options: [.mappedIfSafe])
    }

    func candidates() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { Self.isValidToken($0) && uploads[$0] == nil }
    }

    @discardableResult
    func delete(_ token: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard Self.isValidToken(token), uploads[token] == nil else { return false }
        do {
            try FileManager.default.removeItem(at: fileURL(token))
            return true
        } catch {
            return !FileManager.default.fileExists(atPath: fileURL(token).path)
        }
    }
}
