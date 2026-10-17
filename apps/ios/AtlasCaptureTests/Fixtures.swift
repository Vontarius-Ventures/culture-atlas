import Foundation
import XCTest

/// Reads fixtures/native-contract (copied into the test bundle as the
/// "native-contract" folder by project.yml).
enum Fixtures {
  static func url(_ name: String) throws -> URL {
    let bundle = Bundle(for: BundleToken.self)
    guard let folder = bundle.url(forResource: "native-contract", withExtension: nil) else {
      throw XCTSkip("native-contract fixtures are not in the test bundle")
    }
    return folder.appendingPathComponent(name)
  }

  static func data(_ name: String) throws -> Data { try Data(contentsOf: url(name)) }

  static func json(_ name: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data(name)) as? [String: Any])
  }

  /// One example body from messages.json as raw JSON data.
  static func message(_ key: String) throws -> Data {
    let messages = try XCTUnwrap(json("messages.json")["messages"] as? [String: Any])
    let entry = try XCTUnwrap(messages[key] as? [String: Any], "missing message \(key)")
    return try JSONSerialization.data(withJSONObject: XCTUnwrap(entry["body"]))
  }

  static func messageObject(_ key: String) throws -> NSDictionary {
    try XCTUnwrap(JSONSerialization.jsonObject(with: message(key)) as? NSDictionary)
  }

  static func date(_ value: Any?) -> Date? { (value as? String).flatMap { AtlasJSONDates.parse($0) } }

  private final class BundleToken {}
}

enum AtlasJSONDates {
  static func parse(_ raw: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    if let date = formatter.date(from: raw) { return date }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: raw)
  }
}

extension UUID {
  init(fixture value: Any?) throws {
    self = try XCTUnwrap(UUID(uuidString: XCTUnwrap(value as? String)))
  }
}
