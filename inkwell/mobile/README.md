# Inkwell mobile (iOS and Android)

A thin native shell built with [Capacitor](https://capacitorjs.com). It loads the deployed Inkwell
web app inside a native webview and adds what the web cannot do on its own: an App Store / Play
Store listing, native push notifications through Firebase, deep links, and the hardware back button.

Because the shell loads the live site, most releases ship by deploying the web app. You only
rebuild the native apps when the shell itself changes.

## What the server already provides

- Token authentication: the shell sends `X-Inkwell-Client: native` and receives a bearer token on
  login, which the web code stores and sends as `Authorization: Bearer …`.
- CORS for `capacitor://localhost` and `http(s)://localhost` (add more in `CORS_ORIGINS`).
- Device registration at `POST /api/push/subscribe` with `{ kind: "fcm", token }`, and delivery
  through Firebase Cloud Messaging when `FCM_SERVICE_ACCOUNT_JSON` is set. Firebase relays to
  APNs, so one setup covers both platforms.
- Deep-link association files at `/.well-known/assetlinks.json` and
  `/.well-known/apple-app-site-association` once `ANDROID_PACKAGE`, `ANDROID_CERT_SHA256`,
  `IOS_TEAM_ID` and `IOS_BUNDLE_ID` are set on the server.

## Build

Prerequisites: Node 20+, and Android Studio (Android) or Xcode 15+ on macOS (iOS).

```bash
cd inkwell/mobile
npm install
export INKWELL_APP_URL=https://your.deployed.domain   # https only
export INKWELL_APP_ID=com.yourcompany.inkwell
npm run add:android      # creates android/ and syncs
npm run add:ios          # creates ios/ and syncs (macOS)
npm run open:android     # opens Android Studio
npm run open:ios         # opens Xcode
```

`npm run configure` regenerates `capacitor.config.json` from the environment; `npm run sync`
re-syncs after changing it. The generated `android/` and `ios/` folders are not committed.

## Push notifications (Firebase)

1. Create a Firebase project and add an Android app (package id) and an iOS app (bundle id).
2. Android: put `google-services.json` in `android/app/`.
3. iOS: upload your APNs key in Firebase, put `GoogleService-Info.plist` in `ios/App/App/`, enable
   the Push Notifications and Background Modes (remote notifications) capabilities in Xcode, and
   add the Firebase SDK per the `@capacitor/push-notifications` docs.
4. Server: create a service account with the Firebase Cloud Messaging API role, download its JSON,
   and set `FCM_SERVICE_ACCOUNT_JSON` (inline JSON or a path).

The web app detects the native bridge, asks for permission after login, and posts the device
token to the server. Tapping a notification opens the linked page inside the app.

## Deep links

Set `ANDROID_PACKAGE`, `ANDROID_CERT_SHA256` (from your signing key), `IOS_TEAM_ID` and
`IOS_BUNDLE_ID` on the server. Then add the intent filter (Android) and associated domains
(`applinks:your.domain`, iOS) as described in the Capacitor App plugin docs. Links to artists,
artworks, requests, bookings, messages and password resets then open in the app.

## Store checklist

- App icons and splash screens (`npx @capacitor/assets generate` from a 1024px icon).
- Privacy policy URL: `https://your.domain/privacy`.
- Account deletion is available in-app under Settings, which both stores require.
- Payments for tattoo sessions are physical services, so Stripe Checkout in the webview is
  allowed by both stores' in-app purchase rules.
