import AVFoundation

/// Audio category for voice channels.
///
/// ponytail: the category is set once at launch and WebKit activates the session on the first
/// `getUserMedia`. No CallKit and no background voice in the alpha: WKWebView pauses capture when
/// the app goes to the background. CallKit or native WebRTC is the upgrade path.
enum AudioSession {
    static func configure() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        } catch {
            NSLog("[hachiman] audio session category failed: %@", String(describing: error))
        }
    }
}
