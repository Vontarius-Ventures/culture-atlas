import Foundation
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// Library imports: keep JPEG/PNG/WebP as-is. Convert HEIC/HEIF to JPEG so
/// iPhone Camera Roll photos can enter the private library. The server does
/// not decode HEIC.
public enum PhotoImport {
  public static func payload(data: Data, type: UTType?) -> (data: Data, contentType: String)? {
    if type?.conforms(to: .jpeg) == true { return (data, "image/jpeg") }
    if type?.conforms(to: .png) == true { return (data, "image/png") }
    if type?.conforms(to: .webP) == true { return (data, "image/webp") }
    if isHeif(type: type, data: data) {
      #if os(iOS)
      guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.92) else {
        return nil
      }
      return (jpeg, "image/jpeg")
      #else
      return nil
      #endif
    }
    return nil
  }

  private static func isHeif(type: UTType?, data: Data) -> Bool {
    if let type, type.conforms(to: .heic) || type.conforms(to: .heif) { return true }
    guard data.count >= 12 else { return false }
    let box = String(data: data.subdata(in: 4..<8), encoding: .ascii)
    let brand = String(data: data.subdata(in: 8..<12), encoding: .ascii)?.lowercased()
    let heif = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]
    return box == "ftyp" && brand.map { heif.contains($0) } == true
  }
}
