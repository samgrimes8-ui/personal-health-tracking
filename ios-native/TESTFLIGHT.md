# TestFlight setup

After Apple approves your Developer Program enrollment (24–48 hours
typically), do these one-time steps. Going forward,
`./ios-native/testflight.sh` does the rest in one shot.

## 1. Create the app in App Store Connect

1. Sign in at https://appstoreconnect.apple.com
2. **My Apps** → **+** → **New App**
3. Fill in:
   - **Platforms**: iOS
   - **Name**: MacroLens
   - **Primary Language**: English (U.S.)
   - **Bundle ID**: `app.macrolens.native` (must match
     `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml`; if the dropdown is
     empty, register the bundle ID first at
     https://developer.apple.com/account/resources/identifiers/list)
   - **SKU**: anything unique — `macrolens-ios` works.
   - **User Access**: Full Access
4. Click **Create**.

Don't worry about screenshots / description / pricing yet — TestFlight
doesn't need any of that. Those are for the public App Store submission.

## 2. Generate an App Store Connect API key

This is what `testflight.sh` uses to upload non-interactively (no
password prompt).

1. App Store Connect → **Users and Access** → **Integrations** tab → **App Store Connect API**
2. **+** → name it (e.g., "MacroLens upload"), Access: **App Manager**, **Generate**
3. Apple shows the key **once**. Click **Download API Key** to save the
   `.p8` file. **You can't re-download it** — if you lose it, generate a
   new key.
4. Note the **Key ID** (10 chars, e.g. `ABC123DEF4`) and the **Issuer ID**
   (UUID at the top of the page, e.g. `12345678-abcd-1234-...`).

## 3. Place the key + credentials

```sh
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_ABC123DEF4.p8 ~/.appstoreconnect/private_keys/
```

(Replace `ABC123DEF4` with your actual Key ID. `xcrun altool` looks
in this exact path.)

Then create `ios-native/.testflight.env` (already gitignored):

```
APP_STORE_CONNECT_KEY_ID=ABC123DEF4
APP_STORE_CONNECT_ISSUER_ID=12345678-abcd-1234-5678-1234567890ab
```

## 4. Configure providers in Supabase

The native app supports email + Google + Apple sign-in. Each needs
the bundle ID whitelisted on its provider config:

### Google
- Supabase Dashboard → **Authentication** → **URL Configuration**
- **Redirect URLs** must include `app.macrolens.native://login-callback`
  (you've already done this).

### Apple
- Supabase Dashboard → **Authentication** → **Providers** → **Apple**
- Enable
- **Authorized Client IDs**: add `app.macrolens.native`
- Save. (No service ID / private key needed — those are for the
  web/redirect flow, not native iOS Apple Sign-In.)

## 5. First archive + upload

```sh
./ios-native/testflight.sh
```

Expected output:
```
→ Building build #N
→ Archiving...
→ Exporting IPA...
→ Uploading to App Store Connect (build #N)...
✓ Uploaded build #N.
```

You'll get an email "ITC.apps.beta.email.processing.complete" within
~5–30 min. The build then appears in TestFlight on your phone.

## 6. Install TestFlight on your phone

If you don't have it: search "TestFlight" in the App Store, install.

Sign in with the same Apple ID that's on your developer account. As
the account holder, you're automatically an internal tester — no
invite link needed. Open MacroLens in TestFlight → **Install** → done.

## Going forward

```sh
./ios-native/testflight.sh
```

Every successful upload bumps the build number (we use git commit
count), so Apple never rejects for "build number must be unique." 90
days per build before expiry, way better than the 7-day free dev cert.

If the upload fails:
- `Asset validation failed (90168) Invalid Provisioning Profile` — the
  app record bundle ID probably doesn't match `project.yml`. Check both.
- `Authentication failed` — check `.testflight.env` Key ID + Issuer ID,
  and the `.p8` file is in `~/.appstoreconnect/private_keys/`.
- `Build version must be greater` — usually a stale build. Bump the
  CURRENT_PROJECT_VERSION manually one notch and re-run.
