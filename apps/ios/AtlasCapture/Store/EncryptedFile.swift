import CryptoKit
import Foundation

/// Chunked AES-256-GCM container for local drafts ("encrypt retained drafts",
/// SCREEN-CONTRACT). Layout:
///
///     magic "CAE1" | chunk size UInt32 BE | plaintext length UInt64 BE
///     then per chunk: nonce(12) | ciphertext(<= chunk size) | tag(16)
///
/// Each chunk authenticates its index and the total length, so chunks cannot
/// be reordered, dropped or truncated undetected. Parts are decrypted into a
/// short-lived plaintext file just before transfer, never the whole file.
public enum EncryptedFile {
  public static let magic = Data("CAE1".utf8)
  public static let defaultChunkSize = 1 << 20
  static let headerSize = 16
  static let overhead = 12 + 16

  public struct Sealed: Equatable, Sendable {
    public let byteSize: Int64
    public let sha256Hex: String
  }

  public enum Failure: Error, Equatable {
    case badHeader, truncated, authenticationFailed, rangeOutOfBounds
  }

  /// Encrypts `source` into `destination`, hashing the plaintext as it goes.
  public static func seal(source: URL, destination: URL, key: SymmetricKey, chunkSize: Int = defaultChunkSize) throws -> Sealed {
    let input = try FileHandle(forReadingFrom: source)
    defer { try? input.close() }
    let total = try input.seekToEnd()
    try input.seek(toOffset: 0)
    FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [
      .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
    ])
    let output = try FileHandle(forWritingTo: destination)
    defer { try? output.close() }
    var header = magic
    header.append(contentsOf: withUnsafeBytes(of: UInt32(chunkSize).bigEndian, Array.init))
    header.append(contentsOf: withUnsafeBytes(of: total.bigEndian, Array.init))
    try output.write(contentsOf: header)
    var hasher = SHA256()
    var index: UInt64 = 0
    while true {
      let chunk = try input.read(upToCount: chunkSize) ?? Data()
      if chunk.isEmpty, index > 0 || total > 0 { break }
      hasher.update(data: chunk)
      let sealed = try AES.GCM.seal(chunk, using: key, authenticating: aad(index: index, total: total))
      try output.write(contentsOf: sealed.nonce.withUnsafeBytes { Data($0) })
      try output.write(contentsOf: sealed.ciphertext)
      try output.write(contentsOf: sealed.tag)
      index += 1
      if chunk.isEmpty { break }
    }
    try output.synchronize()
    return Sealed(byteSize: Int64(total), sha256Hex: hasher.finalize().map { String(format: "%02x", $0) }.joined())
  }

  /// Writes plaintext bytes [offset, offset+length) of `source` to `destination`.
  public static func decryptRange(source: URL, offset: Int64, length: Int64, destination: URL, key: SymmetricKey) throws {
    let input = try FileHandle(forReadingFrom: source)
    defer { try? input.close() }
    let (chunkSize, total) = try readHeader(input)
    guard offset >= 0, length >= 0, offset + length <= Int64(total) else { throw Failure.rangeOutOfBounds }
    FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [
      .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
    ])
    let output = try FileHandle(forWritingTo: destination)
    defer { try? output.close() }
    guard length > 0 else { return }
    let first = UInt64(offset) / UInt64(chunkSize)
    let last = UInt64(offset + length - 1) / UInt64(chunkSize)
    for index in first...last {
      let plain = try decryptChunk(input, index: index, chunkSize: chunkSize, total: total, key: key)
      let chunkStart = Int64(index) * Int64(chunkSize)
      let from = max(offset, chunkStart) - chunkStart
      let to = min(offset + length, chunkStart + Int64(plain.count)) - chunkStart
      try output.write(contentsOf: plain.subdata(in: Int(from)..<Int(to)))
    }
    try output.synchronize()
  }

  /// Full decrypt (playback of a local draft).
  public static func open(source: URL, destination: URL, key: SymmetricKey) throws {
    let input = try FileHandle(forReadingFrom: source)
    let (_, total) = try readHeader(input)
    try input.close()
    try decryptRange(source: source, offset: 0, length: Int64(total), destination: destination, key: key)
  }

  static func readHeader(_ handle: FileHandle) throws -> (Int, UInt64) {
    try handle.seek(toOffset: 0)
    guard let header = try handle.read(upToCount: headerSize), header.count == headerSize,
      header.prefix(4) == magic
    else { throw Failure.badHeader }
    let chunkSize = header.subdata(in: 4..<8).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
    let total = header.subdata(in: 8..<16).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    guard chunkSize > 0 else { throw Failure.badHeader }
    return (Int(chunkSize), total)
  }

  static func decryptChunk(_ handle: FileHandle, index: UInt64, chunkSize: Int, total: UInt64, key: SymmetricKey) throws -> Data {
    let start = UInt64(headerSize) + index * UInt64(chunkSize + overhead)
    let plainLength = Int(min(UInt64(chunkSize), total - min(total, index * UInt64(chunkSize))))
    try handle.seek(toOffset: start)
    guard let blob = try handle.read(upToCount: plainLength + overhead), blob.count == plainLength + overhead else {
      throw Failure.truncated
    }
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: blob.prefix(12)),
        ciphertext: blob.subdata(in: 12..<(12 + plainLength)),
        tag: blob.suffix(16))
      return try AES.GCM.open(box, using: key, authenticating: aad(index: index, total: total))
    } catch {
      throw Failure.authenticationFailed
    }
  }

  static func aad(index: UInt64, total: UInt64) -> Data {
    var data = Data("culture-atlas-draft-v1".utf8)
    data.append(contentsOf: withUnsafeBytes(of: index.bigEndian, Array.init))
    data.append(contentsOf: withUnsafeBytes(of: total.bigEndian, Array.init))
    return data
  }
}
