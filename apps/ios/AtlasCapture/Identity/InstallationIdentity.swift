import CryptoKit
import Foundation

/// The phone's installation identity for one account: a public installation
/// UUID and a non-exportable P-256 signing key (Secure Enclave when present).
///
/// Kept after sign-out so the SAME account can reactivate the SAME
/// installation (the server only unpauses uploads for the same key). A
/// different account never sees or uses another account's identity.
public struct InstallationIdentity: Codable, Equatable, Sendable {
  public var accountID: UUID
  public var installationPublicID: UUID
  /// Server installation id once enrolled.
  public var installationID: UUID?
  /// Secure Enclave key blob (only usable on this device) or a software key's
  /// raw representation when no Secure Enclave exists (Simulator).
  public var keyData: Data
  public var secureEnclave: Bool
  public var statusSequence: Int
}

public protocol InstallationSigner: Sendable {
  var publicKeyX963: Data { get }
  func sign(_ payload: Data) throws -> Data
}

struct SecureEnclaveSigner: InstallationSigner {
  let key: SecureEnclave.P256.Signing.PrivateKey
  var publicKeyX963: Data { key.publicKey.x963Representation }
  func sign(_ payload: Data) throws -> Data { try key.signature(for: payload).rawRepresentation }
}

struct SoftwareSigner: InstallationSigner {
  let key: P256.Signing.PrivateKey
  var publicKeyX963: Data { key.publicKey.x963Representation }
  func sign(_ payload: Data) throws -> Data { try key.signature(for: payload).rawRepresentation }
}

public final class InstallationIdentityStore: @unchecked Sendable {
  private let keychain: KeychainStore
  private let lock = NSLock()

  public init(keychain: KeychainStore = KeychainStore()) {
    self.keychain = keychain
  }

  private func key(_ accountID: UUID) -> String { "installation.\(accountID.uuidString.lowercased())" }

  public func identity(for accountID: UUID) -> InstallationIdentity? {
    lock.withLock { keychain.codable(InstallationIdentity.self, for: key(accountID)) }
  }

  /// The existing identity for this account, or a new one.
  public func identityOrCreate(for accountID: UUID) throws -> InstallationIdentity {
    try lock.withLock {
      if let existing = keychain.codable(InstallationIdentity.self, for: key(accountID)) { return existing }
      let created: InstallationIdentity
      if SecureEnclave.isAvailable {
        let privateKey = try SecureEnclave.P256.Signing.PrivateKey()
        created = InstallationIdentity(
          accountID: accountID, installationPublicID: UUID(), installationID: nil,
          keyData: privateKey.dataRepresentation, secureEnclave: true, statusSequence: 0)
      } else {
        let privateKey = P256.Signing.PrivateKey()
        created = InstallationIdentity(
          accountID: accountID, installationPublicID: UUID(), installationID: nil,
          keyData: privateKey.rawRepresentation, secureEnclave: false, statusSequence: 0)
      }
      try keychain.setCodable(created, for: key(accountID))
      return created
    }
  }

  /// Replaces a revoked installation ("This phone was removed") with a new public id and key.
  public func rotate(for accountID: UUID) throws -> InstallationIdentity {
    lock.withLock { keychain.delete(key(accountID)) }
    return try identityOrCreate(for: accountID)
  }

  public func save(_ identity: InstallationIdentity) throws {
    try lock.withLock { try keychain.setCodable(identity, for: key(identity.accountID)) }
  }

  /// Next device-status sequence; persisted before use so it never repeats.
  public func nextStatusSequence(for accountID: UUID) throws -> Int {
    try lock.withLock {
      guard var identity = keychain.codable(InstallationIdentity.self, for: key(accountID)) else {
        throw AtlasClientError.notSignedIn
      }
      identity.statusSequence += 1
      try keychain.setCodable(identity, for: key(accountID))
      return identity.statusSequence
    }
  }

  public func forget(accountID: UUID) {
    lock.withLock { keychain.delete(key(accountID)) }
  }

  public func signer(for identity: InstallationIdentity) throws -> InstallationSigner {
    if identity.secureEnclave {
      return SecureEnclaveSigner(key: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: identity.keyData))
    }
    return SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: identity.keyData))
  }
}
