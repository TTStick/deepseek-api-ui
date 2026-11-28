import UIKit

/// Chunked export of a history archive. Android uses SAF ACTION_CREATE_DOCUMENT, where the
/// destination is chosen before writing; iOS cannot do that, so bytes are streamed into a
/// temporary file and the document picker is shown when the archive is complete.
final class FileExport: NSObject, UIDocumentPickerDelegate {
    private let lock = NSLock()
    private var handle: FileHandle?
    private var temporaryURL: URL?
    private var exportDirectory: URL?
    private weak var picker: UIDocumentPickerViewController?
    private weak var presenter: UIViewController?

    private var root: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("history-export", isDirectory: true)
    }

    func begin(name: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard handle == nil, temporaryURL == nil else { return false }
        var safeName = name.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if safeName.isEmpty || safeName == "." || safeName == ".." { safeName = "history.zip" }
        do {
            // Keep the exported file's name clean: the picker shows the last path component,
            // so the uniqueness lives in the directory instead of a filename prefix.
            let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(safeName)
            guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                try? FileManager.default.removeItem(at: folder)
                return false
            }
            handle = try FileHandle(forWritingTo: url)
            temporaryURL = url
            exportDirectory = folder
            return true
        } catch {
            handle = nil
            temporaryURL = nil
            exportDirectory = nil
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

    func finish(presenter: UIViewController?) -> Bool {
        lock.lock()
        let handle = self.handle
        let url = self.temporaryURL
        self.handle = nil
        self.temporaryURL = nil
        lock.unlock()

        guard let url else { return false }
        try? handle?.close()
        guard let presenter else {
            removeDirectory()
            return false
        }
        guard picker == nil else {
            removeDirectory()
            return false
        }
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = self
        picker.modalPresentationStyle = .formSheet
        self.picker = picker
        self.presenter = presenter
        DispatchQueue.main.async {
            presenter.present(picker, animated: true)
        }
        return true
    }

    func cancel() {
        lock.lock()
        let handle = self.handle
        self.handle = nil
        self.temporaryURL = nil
        lock.unlock()
        try? handle?.close()
        removeDirectory()
    }

    private func removeDirectory() {
        if let directory = exportDirectory {
            try? FileManager.default.removeItem(at: directory)
        }
        exportDirectory = nil
    }

    private func cleanup() {
        removeDirectory()
        picker = nil
        presenter = nil
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        cleanup()
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        cleanup()
    }
}
