import UserNotifications

/// The Notification Service Extension (contract §12.22). APNs wakes it for a push with
/// `mutable-content` and a sealed preview `e`. It opens the preview with the push key of this
/// device and shows the sender and the text. When nothing opens, the alert of Takusen stays:
/// "Hachiman / New message".
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        if let sealed = request.content.userInfo["e"] as? String,
           let preview = PushPreview.open(sealed, keys: PushKeyStore.keys())
        {
            content.title = preview.t
            content.body = preview.b
        }
        contentHandler(content)
    }
}
