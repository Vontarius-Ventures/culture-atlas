import CryptoKit
import Foundation

/// Enrollment proof rules (fixtures/native-contract/enrollment-signature.json).
public enum EnrollmentProof {
  public static let prefix = "culture-atlas-enroll-v1"

  /// prefix LF nonce LF installation_public_id LF platform LF sha256hex(grant or "")
  public static func payload(nonce: String, installationPublicID: UUID, platform: String, enrollmentGrant: String?) -> String {
    let grantHash = SHA256.hash(data: Data((enrollmentGrant ?? "").utf8)).hexString
    return [prefix, nonce, installationPublicID.uuidString.lowercased(), platform, grantHash].joined(separator: "\n")
  }

  /// JWK coordinates from an X9.63 uncompressed point (0x04 || X || Y).
  public static func jwk(x963 representation: Data) -> PublicKeyJWK? {
    guard representation.count == 65, representation.first == 0x04 else { return nil }
    let x = representation.subdata(in: 1..<33)
    let y = representation.subdata(in: 33..<65)
    return PublicKeyJWK(x: x.base64URLEncodedString(), y: y.base64URLEncodedString())
  }
}

extension Digest {
  var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

extension Data {
  public func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  public init?(base64URLEncoded value: String) {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    self.init(base64Encoded: base64)
  }

  public init?(hex: String) {
    guard hex.count % 2 == 0 else { return nil }
    var bytes = [UInt8]()
    bytes.reserveCapacity(hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}
