import Foundation
import Security
import CryptoKit

func query(_ service: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: NSUserName()]
}
func read(_ service: String) throws -> Data {
    var q = query(service)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess,
          let data = result as? Data else { throw NSError(domain: "keychain_read", code: Int(status)) }
    return data
}
func fail() -> Never { print("keychain_write_failed"); exit(1) }
do {
    if CommandLine.arguments.dropFirst().first == "--check-access" {
        let data = try read("Claude Code-credentials")
        guard (try JSONSerialization.jsonObject(with: data)) is [String: Any] else { fail() }
        print("keychain_access_ok")
    } else if CommandLine.arguments.dropFirst().first == "--self-test" {
        let service = "Agent Monitor Keychain Test " + UUID().uuidString
        var q = query(service)
        let old = Data("fixture".utf8)
        q[kSecValueData as String] = old
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { fail() }
        defer { SecItemDelete(query(service) as CFDictionary) }
        let large = Data(String(repeating: "x", count: 16384).utf8)
        guard SecItemUpdate(query(service) as CFDictionary, [kSecValueData as String: large] as CFDictionary) == errSecSuccess,
              try read(service) == large else { fail() }
        print("keychain_large_write_verified")
    } else {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count <= 262144,
              let envelope = try JSONSerialization.jsonObject(with: input) as? [String: Any],
              let expected = envelope["expectedHash"] as? String,
              let value = envelope["value"] as? [String: Any],
              let oauth = value["claudeAiOauth"] as? [String: Any],
              let token = oauth["accessToken"] as? String, !token.isEmpty else { fail() }
        let service = "Claude Code-credentials"
        let current = try read(service)
        let digest = SHA256.hash(data: current).map { String(format: "%02x", $0) }.joined()
        guard digest == expected else { print("credentials_changed"); exit(2) }
        let replacement = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard SecItemUpdate(query(service) as CFDictionary, [kSecValueData as String: replacement] as CFDictionary) == errSecSuccess,
              try read(service) == replacement else { fail() }
        print("saved")
    }
} catch let error as NSError { print("keychain_error_\(error.code)"); exit(1) }
