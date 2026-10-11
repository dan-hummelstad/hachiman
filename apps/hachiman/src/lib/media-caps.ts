/** The part of `navigator` that the media checks read. */
type MediaNavigator = { mediaDevices?: Partial<Pick<MediaDevices, 'getDisplayMedia'>> }

/**
 * Whether this host can share a screen: `getDisplayMedia` exists. Electron and desktop browsers
 * have it. WKWebView on iOS (and mobile Safari) does not, so the share button does not show
 * there (docs/ios-mobile-ui-spec.md A2).
 */
export function canShareScreen(
  nav: MediaNavigator | undefined = globalThis.navigator as MediaNavigator | undefined
): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function'
}
