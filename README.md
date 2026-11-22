# Lingora backend

Firebase backend for the [Lingora iOS app](https://github.com/Konta1404/lingora-ios).

- **Cloud Functions** (TypeScript, Node.js 22, 2nd gen, `europe-west1`). Every ChatGPT feature in the app runs here, **on each user's own ChatGPT Plus/Pro plan** via [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source). Lingora has no OpenAI key and never pays for anyone's usage. Users without a connected plan get the app's built-in content.
- **Firestore**: user state and progress sync, plus a shared cache of vocabulary translations.
- **Firebase Auth**: ChatGPT, Apple, Google and email/password. ChatGPT sign-ins are minted as Firebase custom tokens. Every AI function requires a signed-in user with a connected plan.

```
firebase.json            Firebase config
firestore.rules          Database access rules
functions/src/index.ts   Callable functions
functions/src/chatgpt.ts Sign in with ChatGPT: OAuth + PKCE, encrypted token storage, refresh
functions/src/crypto.ts  AES-256-GCM for stored tokens
functions/src/openai.ts  Responses API client on the user's plan (strict JSON schema, streaming)
functions/src/vocab.ts   German word list + translation cache
functions/data/          vocab_de.json (Goethe A1–B1, same file as in the app)
```

## Functions

| Name | Used for |
|---|---|
| `weeklyPlan` | 7-day plan per language |
| `adaptToday` | Daily adjustment from recent results |
| `lesson` | Flashcard, gap fill and writing task |
| `checkWriting` | Feedback on a written answer |
| `tutorTurn` | Roleplay reply, correction and suggestions |
| `correctMessage` | Private correction in friend chats |
| `translateWords` | Translates vocab words into the user's language (cached in Firestore) |
| `checkTranslation` | Judges a vocab answer that didn't match the cached translations |
| `chatgptAuthStart` | Returns the OpenAI sign-in URL (with PKCE, state, nonce) |
| `chatgptCallback` | HTTPS redirect target: exchanges the code, stores encrypted tokens, returns to `lingora://chatgpt` |
| `chatgptAuthFinish` | Gives the app a Firebase custom token after a new ChatGPT sign-in |
| `chatgptStatus` / `chatgptDisconnect` | Connection state / remove the stored tokens |

Every function takes `uiLanguage` / `targetLanguage` (a BCP-47 tag from the phone), so answers come back in the user's own language. Each user is limited to `DAILY_AI_LIMIT` calls a day (300 by default).

## Firestore

| Path | Who can access | Contents |
|---|---|---|
| `users/{uid}` | Owner only | `state` (JSON), `name` |
| `users/{uid}/data/vocab` | Owner only | Vocab progress |
| `vocabTranslations/{lang}/words/{wordId}` | Read: signed-in users. Write: functions only | Cached translations |
| `users/{uid}/private/chatgpt` | Functions only | The user's ChatGPT tokens, **AES-256-GCM encrypted** with `TOKEN_ENC_KEY` |
| `chatgptPending/{state}` | Functions only | Short-lived sign-in state (PKCE verifier, nonce) |
| `usage/{uid}_{day}` | Functions only | Daily call counter |

## Setup

### 1. Get Sign in with ChatGPT access from OpenAI

Sign in with ChatGPT is a preview. Self-serve access only covers open-source and locally hosted tools; a hosted app like Lingora needs a client ID from OpenAI. Apply at <https://openai.com/form/sign-in-with-chatgpt-interest/> and ask for **plan usage**. Give them this redirect URI:

```
https://europe-west1-<your-project-id>.cloudfunctions.net/chatgptCallback
```

Until then, everything else works and the app uses its built-in content.

### 2. Firebase project

Create a Firebase project. Enable Firestore, and in Authentication enable Email/Password, Google and Apple. Upgrade to the **Blaze** plan, which Functions with secrets need. Give the Cloud Functions service account the **Service Account Token Creator** role, which ChatGPT sign-in needs to create Firebase custom tokens.

### 3. Deploy

```bash
npm install -g firebase-tools
firebase login
firebase use --add                                        # pick your project
firebase functions:secrets:set CHATGPT_CLIENT_SECRET      # from OpenAI
openssl rand -base64 32 | firebase functions:secrets:set TOKEN_ENC_KEY
echo "CHATGPT_CLIENT_ID=<from OpenAI>" > functions/.env.<project-id>
cd functions && npm install && cd ..
firebase deploy --only functions,firestore
```

Other settings, all optional, also go in `functions/.env.<project-id>`:

| Setting | Default | Notes |
|---|---|---|
| `CHATGPT_MODELS` | `gpt-5-mini,gpt-5,gpt-6.1-sol` | Preference order. The first one the user's plan offers is used. |
| `CHATGPT_DISCOVERY_URL` | `https://auth.openai.com/.well-known/openid-configuration` | |
| `CHATGPT_CALLBACK_URL` | Built from the project and region | Must match what OpenAI has registered. |
| `DAILY_AI_LIMIT` | `300` | Calls per user per day, to protect their plan. |

**Plan limits:** OpenAI applies a weekly cap per app, plus Plus's 5-hour limit. When a user hits it, the app says so and falls back to built-in content. Using a plan needs **ChatGPT Plus or Pro**.

## Local development (no Firebase project needed)

```bash
./scripts/dev.sh
```

This needs Node 20+ and Java 11+. It writes local secrets to `functions/.secret.local` (git-ignored), builds the functions and starts the emulators for the demo project `demo-lingora`. No OpenAI key is needed:

| Emulator | Address |
|---|---|
| Auth | 127.0.0.1:9099 |
| Firestore | 127.0.0.1:8080 |
| Functions | 127.0.0.1:5001 |
| Emulator UI | http://127.0.0.1:4000 |

Then run the app from Xcode on an **iPhone simulator**. The shared scheme sets `LINGORA_USE_EMULATORS=1`, so Debug builds connect to the emulators with no `GoogleService-Info.plist`. Use **email sign-up**: Apple and Google sign-in need a real Firebase project.

Without a client ID from OpenAI, AI calls answer "not configured" and the app uses its built-in content. Once you have one, put it in `functions/.env.local` and the secret in `functions/.secret.local`. You also need OpenAI to allow the emulator redirect URI, `http://127.0.0.1:5001/demo-lingora/europe-west1/chatgptCallback`.

To test on a physical iPhone, set `LINGORA_EMULATOR_HOST` in the scheme to your Mac's IP address, and change `host` in `firebase.json` to `0.0.0.0`.

## Keeping the word list in sync

`functions/data/vocab_de.json` must match `Lingora/Resources/vocab_de.json` in the app repo. Word ids are shared between the two, so copy the file over whenever you rebuild it.
