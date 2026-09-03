import Foundation

enum T3SharedContainer {
    #if DEBUG
    private static let defaultAppGroupID = "group.com.t3tools.t3code.swiftui.dev"
    static let urlScheme = "t3code-swiftui-dev"
    #else
    private static let defaultAppGroupID = "group.com.t3tools.t3code.swiftui"
    static let urlScheme = "t3code-swiftui"
    #endif

    /// The App Group shared by the app, widgets, and share extension. Each
    /// bundle's Info.plist carries `T3CodeAppGroupIdentifier` from the
    /// `T3CODE_APP_GROUP_IDENTIFIER` build setting, so a local identity
    /// override (Config/Local.xcconfig) reaches the extensions as well.
    static let appGroupID: String = {
        if let value = Bundle.main.object(forInfoDictionaryKey: "T3CodeAppGroupIdentifier") as? String,
           !value.isEmpty {
            return value
        }
        return defaultAppGroupID
    }()

    static var rootURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        )
    }
}
