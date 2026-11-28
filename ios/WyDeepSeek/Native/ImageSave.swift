import Photos
import UIKit
import UniformTypeIdentifiers

/// Saves an image from the chat into the system photo library.
/// Mirrors Android's `ImageSave` (MediaStore IS_PENDING on 10+, temp file on 9): bytes are
/// written to a temporary file and only published after the full payload is received.
final class ImageSave {
    private let lock = NSLock()
    private var pendingURL: URL?
    private var pendingName = ""
    private var pendingMime = ""
    private var handle: FileHandle?

    private var directory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("image-save", isDirectory: true)
    }

    // MARK: - Permission

    func requestPermission(_ completion: @escaping (Bool) -> Void) {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .authorized || status == .limited {
            completion(true)
            return
        }
        if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { result in
                DispatchQueue.main.async {
                    completion(result == .authorized || result == .limited)
                }
            }
            return
        }
        completion(false)
    }

    // MARK: - Chunked write

    func begin(name: String, mime: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard pendingURL == nil, handle == nil else { return false }
        var safeName = name.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if safeName.isEmpty || safeName == "." || safeName == ".." { return false }
        var resolvedMime = mime
        if !resolvedMime.hasPrefix("image/") {
            let ext = (safeName as NSString).pathExtension
            guard let type = UTType(filenameExtension: ext), type.conforms(to: .image) else { return false }
            resolvedMime = type.preferredMIMEType ?? "image/jpeg"
            if safeName.isEmpty { safeName = "image.jpg" }
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(UUID().uuidString + "-" + safeName)
            guard FileManager.default.createFile(atPath: url.path, contents: nil) else { return false }
            handle = try FileHandle(forWritingTo: url)
            pendingURL = url
            pendingName = safeName
            pendingMime = resolvedMime
            return true
        } catch {
            pendingURL = nil
            pendingName = ""
            pendingMime = ""
            handle = nil
            return false
        }
    }

    func append(_ base64: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let handle, base64.count <= 65_536, let data = Data(base64Encoded: base64) else {
            return false
        }
        do {
            try handle.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    func finish(keep: Bool) -> Bool {
        lock.lock()
        let url = pendingURL
        let name = pendingName
        let mime = pendingMime
        let handle = self.handle
        pendingURL = nil
        pendingName = ""
        pendingMime = ""
        self.handle = nil
        lock.unlock()

        guard let url else { return false }
        try? handle?.close()
        guard keep else {
            try? FileManager.default.removeItem(at: url)
            return false
        }

        let options = PHAssetResourceCreationOptions()
        options.originalFilename = name
        if let type = UTType(mime) {
            options.uniformTypeIdentifier = type.identifier
        }
        var saved = false
        do {
            try PHPhotoLibrary.shared().performChangesAndWait {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, fileURL: url, options: options)
            }
            saved = true
        } catch {
            saved = false
        }
        try? FileManager.default.removeItem(at: url)
        return saved
    }
}
