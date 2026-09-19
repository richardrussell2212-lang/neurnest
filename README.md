# NeuroNest v1.17.0 — buildable project

Everything needed to produce an installable Android app (.apk).

## What is here

```
App.js                      the whole app
app.json                    name, icon, splash screen
eas.json                    build settings (produces .apk, not .aab)
package.json                the two required packages
assets/
  neuronest-logo.png        header logo
  icon.png                  app icon
  adaptive-icon.png         Android icon (padded for the system mask)
  splash.png                launch screen
```

## Building the APK

You need Node.js on your computer and a free Expo account.

**1. Install the tools** (once, ever)
```
npm install -g eas-cli
```

**2. In this folder**
```
npm install
eas login
eas build -p android --profile preview
```

**3. Wait.** It builds on Expo's servers, usually 10–20 minutes. When it finishes it gives you a link.

**4. Open that link on your Android phone** and install. You may have to allow installing from an unknown source — that is normal for an app not from the Play Store.

The free tier includes 30 builds a month, which is far more than you will need.

## Notes

- **`versionCode` must go up by one** for every build you submit to the Play Store. It is in `app.json` under `android`. It does not matter for test builds.
- **`online.neuronest.app`** is the package name. Once an app is published to a store this cannot be changed, so change it now if you want something different.
- **iOS is different.** Installing on an iPhone outside the App Store needs a paid Apple Developer account (~£79/year). Android has no such restriction, which is why the APK route is the sensible place to start.
- **Package versions are set to `"*"`** so npm picks versions that work together. If a build fails on a version conflict, that is the first place to look.

## What you get

A real app on your phone. It launches from your home screen with its own icon, works with no internet, and can be sent to another parent to install. This is what you would hand to someone for genuine testing.
