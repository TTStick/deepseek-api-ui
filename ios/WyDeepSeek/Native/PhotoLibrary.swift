import Photos
import UIKit
import UniformTypeIdentifiers

/// Recent-photo grid + thumbnails for the composer attachment panel.
/// Android serves MediaStore rows over `/recent/<id>` and `/thumbnail/<id>`; iOS serves
/// PHAsset equivalents through the same local routes, converting HEIC to JPEG.
final class PhotoLibrary {
    private let manager = PHCachingImageManager()
    private var assets: [String: PHAsset] = [:]
    private var names: [String: String] = [:]
    private let lock = NSLock()

    // MARK: - Authorization

    func authorizationStatus() -> PHAuthorizationStatus {
        PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }

    func isAuthorized() -> Bool {
        let status = authorizationStatus()
        return status == .authorized || status == .limited
    }

    /// Prompts only when the user has not decided yet, mirroring Android's PHOTOS request.
    func requestAuthorizationAndList(_ completion: @escaping (String) -> Void) {
        let status = authorizationStatus()
        if status == .authorized || status == .limited {
            completion(listJSON())
            return
        }
        if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] result in
                let allowed = result == .authorized || result == .limited
                DispatchQueue.main.async {
                    completion(allowed ? (self?.listJSON() ?? "[]") : "[]")
                }
            }
            return
        }
        completion("[]")
    }

    func listJSONIfAuthorized() -> String? {
        isAuthorized() ? listJSON() : nil
    }

    // MARK: - Listing

    func listJSON() -> String {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 20
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var freshAssets: [String: PHAsset] = [:]
        var freshNames: [String: String] = [:]
        var rows: [[String: Any]] = []
        var index = 0
        result.enumerateObjects { asset, _, stop in
            if index >= 20 {
                stop.pointee = true
                return
            }
            let key = String(index)
            index += 1
            let name = PHAssetResource.assetResources(for: asset).first?.originalFilename
                ?? "photo-\(key).jpg"
            freshAssets[key] = asset
            freshNames[key] = name
            rows.append([
                "id": key,
                "name": name,
                "type": "image/jpeg",
            ])
        }
        lock.lock()
        assets = freshAssets
        names = freshNames
        lock.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: rows),
              let json = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return json
    }

    private func asset(id: String) -> PHAsset? {
        lock.lock()
        defer { lock.unlock() }
        return assets[id]
    }

    // MARK: - Bytes

    func thumbnailData(id: String) -> Data? {
        guard let asset = asset(id: id) else { return nil }
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let scale = UIScreen.main.scale
        var image: UIImage?
        manager.requestImage(
            for: asset,
            targetSize: CGSize(width: 224 * scale, height: 224 * scale),
            contentMode: .aspectFill,
            options: options
        ) { result, _ in
            image = result
        }
        return image?.jpegData(compressionQuality: 0.88)
    }

    func photoData(id: String) -> (data: Data, mime: String)? {
        guard let asset = asset(id: id) else { return nil }
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true

        var original: Data?
        var identifier: String?
        manager.requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, _ in
            original = data
            identifier = uti
        }
        if let original, let identifier, !Self.isHEIF(identifier) {
            let mime = UTType(identifier)?.preferredMIMEType ?? "image/jpeg"
            return (original, mime)
        }

        // Android decodes HEIF into a PNG before handing it to the page. iOS decodes the
        // asset and re-encodes as JPEG to keep uploads a reasonable size.
        var image: UIImage?
        manager.requestImage(
            for: asset,
            targetSize: PHImageManagerMaximumSize,
            contentMode: .default,
            options: options
        ) { result, _ in
            image = result
        }
        guard var decoded = image else { return nil }
        let largest = max(decoded.size.width, decoded.size.height) * decoded.scale
        if largest > 8_192 {
            let ratio = 8_192 / largest
            let size = CGSize(width: decoded.size.width * ratio, height: decoded.size.height * ratio)
            let renderer = UIGraphicsImageRenderer(size: size)
            decoded = renderer.image { _ in
                decoded.draw(in: CGRect(origin: .zero, size: size))
            }
        }
        guard let jpeg = decoded.jpegData(compressionQuality: 0.92) else { return nil }
        return (jpeg, "image/jpeg")
    }

    private static func isHEIF(_ identifier: String) -> Bool {
        let lower = identifier.lowercased()
        if lower.contains("heic") || lower.contains("heif") { return true }
        if let type = UTType(identifier) {
            if type.conforms(to: .heic) { return true }
            if let heif = UTType("public.heif"), type.conforms(to: heif) { return true }
        }
        return false
    }
}
