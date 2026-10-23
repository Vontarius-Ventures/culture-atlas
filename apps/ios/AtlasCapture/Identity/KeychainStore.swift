import Foundation
import Security

/// Narrow Keychain wrapper for generic-password items, ported from World
/// Observer's `KeychainStore`. Differences: items are this-device-only and
/// readable after first unlock (background uploads and command polling run
/// while the phone is locked), and values are raw `Data`.
///
/// Native access/refresh tokens, installation private keys and draft
/// encryption keys live only here: never in UserDefaults, files or logs.
public struct KeychainStore: Sendable {
  public let service: String

  public init(service: String = "com.cultureatlas.app") {
    self.service = service
  }

  public func set(_ value: Data, for key: String) throws {
    let query = baseQuery(key)
    let attributes: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      guard update == errSecSuccess else { throw KeychainError.writeFailed(update) }
      return
    }
    guard status == errSecSuccess else { throw KeychainError.writeFailed(status) }
  }

  public func data(for key: String) -> Data? {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return item as? Data
  }

  public func delete(_ key: String) {
    SecItemDelete(baseQuery(key) as CFDictionary)
  }

  public func setCodable<T: Encodable>(_ value: T, for key: String) throws {
    try set(AtlasJSON.encoder().encode(value), for: key)
  }

  public func codable<T: Decodable>(_ type: T.Type, for key: String) -> T? {
    guard let data = data(for: key) else { return nil }
    return try? AtlasJSON.decoder().decode(type, from: data)
  }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  public enum KeychainError: LocalizedError, Equatable {
    case writeFailed(OSStatus)

    public var errorDescription: String? {
      switch self {
      case .writeFailed(let status): return "Keychain write failed (status \(status))"
      }
    }
  }
}
