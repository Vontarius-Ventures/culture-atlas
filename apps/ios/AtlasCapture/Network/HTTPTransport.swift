import Foundation

/// JSON over HTTPS for the culture atlas API. No relay URLs, no development
/// transport exceptions: the base URL is the hosted API from the build
/// configuration and App Transport Security stays at its default.
public struct HTTPTransport: Sendable {
  public let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public struct Response: Sendable {
    public let status: Int
    public let data: Data
    public let headers: [String: String]
  }

  public func send(
    baseURL: URL, method: String, path: String, query: [URLQueryItem] = [], body: Data?,
    bearer: String?, idempotencyKey: UUID?, expectedAccount: UUID?, timeout: TimeInterval = 30
  ) async throws -> Response {
    var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { components.queryItems = query }
    var request = URLRequest(url: components.url!, timeoutInterval: timeout)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let idempotencyKey {
      request.setValue(idempotencyKey.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
    }
    if let expectedAccount {
      request.setValue(expectedAccount.uuidString.lowercased(), forHTTPHeaderField: "X-Atlas-Expected-Account")
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw AtlasClientError.transport((error as NSError).domain + ":\((error as NSError).code)")
    }
    guard let http = response as? HTTPURLResponse else { throw AtlasClientError.transport("no_http_response") }
    var headers: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      if let key = key as? String, let value = value as? String { headers[key.lowercased()] = value }
    }
    if !(200..<300).contains(http.statusCode) {
      let retryAfter = headers["retry-after"].flatMap(TimeInterval.init)
      if let body = try? AtlasJSON.decoder().decode(ServerErrorBody.self, from: data) {
        throw AtlasClientError.server(
          status: http.statusCode, code: body.error.code, message: body.error.message,
          retryable: body.error.retryable,
          retryAfter: retryAfter ?? body.error.retryAfterMS.map { $0 / 1000 })
      }
      throw AtlasClientError.server(
        status: http.statusCode, code: "http_\(http.statusCode)", message: "", retryable: http.statusCode >= 500,
        retryAfter: retryAfter)
    }
    return Response(status: http.statusCode, data: data, headers: headers)
  }

  public func json<Body: Encodable, Result: Decodable>(
    baseURL: URL, method: String, path: String, query: [URLQueryItem] = [], body: Body?,
    bearer: String?, idempotencyKey: UUID?, expectedAccount: UUID?, timeout: TimeInterval = 30
  ) async throws -> Result {
    let encoded = try body.map { try AtlasJSON.encoder().encode($0) }
    let response = try await send(
      baseURL: baseURL, method: method, path: path, query: query, body: encoded, bearer: bearer,
      idempotencyKey: idempotencyKey, expectedAccount: expectedAccount, timeout: timeout)
    do {
      return try AtlasJSON.decoder().decode(Result.self, from: response.data)
    } catch {
      throw AtlasClientError.decoding(String(describing: Result.self))
    }
  }
}

extension HTTPTransport {
  public func get<Result: Decodable>(
    baseURL: URL, path: String, query: [URLQueryItem] = [], bearer: String?, timeout: TimeInterval = 30
  ) async throws -> Result {
    try await json(
      baseURL: baseURL, method: "GET", path: path, query: query, body: EmptyBody?.none, bearer: bearer,
      idempotencyKey: nil, expectedAccount: nil, timeout: timeout)
  }
}

/// Placeholder body for requests without one.
public struct EmptyBody: Codable, Sendable, Equatable {
  public init() {}
}
