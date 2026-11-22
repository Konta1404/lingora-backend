#!/usr/bin/env bash
# Runs the whole Lingora backend on your Mac with the Firebase emulators.
# No Firebase project or Google login needed: it uses the demo project "demo-lingora".
#
#   ./scripts/dev.sh
#
# Then run the iOS app from Xcode on a simulator — the shared scheme sets LINGORA_USE_EMULATORS=1.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ $1 is missing. $2"; exit 1; }; }
need node "Install Node.js 22 (e.g. 'nvm install 22')."

# The Firestore emulator needs Java. macOS ships a "java" stub that only says "no Java Runtime",
# so test it for real, and if it's missing download a private JRE into .tools/ (no admin rights needed).
if ! java -version >/dev/null 2>&1; then
  JRE_DIR="$PWD/.tools/jre"
  if [ ! -x "$JRE_DIR/Contents/Home/bin/java" ] && [ ! -x "$JRE_DIR/bin/java" ]; then
    ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && ARCH=aarch64
    OS=$(uname -s | tr '[:upper:]' '[:lower:]'); [ "$OS" = "darwin" ] && OS=mac
    echo "• Java not found — downloading a private Java 21 runtime into .tools/jre (one time, ~50 MB)…"
    mkdir -p "$JRE_DIR"
    curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/$OS/$ARCH/jre/hotspot/normal/eclipse" \
      | tar -xz -C "$JRE_DIR" --strip-components=1
  fi
  if [ -x "$JRE_DIR/Contents/Home/bin/java" ]; then export JAVA_HOME="$JRE_DIR/Contents/Home"; else export JAVA_HOME="$JRE_DIR"; fi
  export PATH="$JAVA_HOME/bin:$PATH"
  java -version >/dev/null 2>&1 || { echo "✗ Couldn't set up Java. Install it with 'brew install --cask temurin' and try again."; exit 1; }
  echo "✓ Using Java from .tools/jre"
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then echo "✗ Node $NODE_MAJOR found; use Node 20 or newer."; exit 1; fi

# Secrets for the emulator (functions/.secret.local, git-ignored). AI runs on each user's own ChatGPT plan,
# so there is no OpenAI key here. TOKEN_ENC_KEY encrypts their ChatGPT tokens; the client secret comes from OpenAI.
touch functions/.secret.local
sed -i.bak '/^OPENAI_API_KEY=/d' functions/.secret.local && rm -f functions/.secret.local.bak
grep -qs '^TOKEN_ENC_KEY=' functions/.secret.local || echo "TOKEN_ENC_KEY=$(openssl rand -base64 32)" >> functions/.secret.local
grep -qs '^CHATGPT_CLIENT_SECRET=' functions/.secret.local || echo "CHATGPT_CLIENT_SECRET=set-me-when-openai-approves" >> functions/.secret.local
chmod 600 functions/.secret.local

# Default function params so the emulator doesn't stop to ask for them (it prompts for any param not in .env).
touch functions/.env.local
sed -i.bak '/^OPENAI_MODEL=/d' functions/.env.local && rm -f functions/.env.local.bak
add_param() { grep -qs "^$1=" functions/.env.local || echo "$1=$2" >> functions/.env.local; }
add_param CHATGPT_CLIENT_ID not-set
add_param CHATGPT_DISCOVERY_URL https://auth.openai.com/.well-known/openid-configuration
add_param CHATGPT_CALLBACK_URL auto
add_param CHATGPT_MODELS gpt-5-mini,gpt-5,gpt-6.1-sol
add_param DAILY_AI_LIMIT 300

echo "• Installing and building functions…"
(cd functions && npm install --no-fund --no-audit --silent && npm run build --silent)

echo "• Starting emulators (Auth :9099, Firestore :8080, Functions :5001, UI :4000)…"
echo "  Open http://127.0.0.1:4000 to see users, Firestore data and function logs."
exec npx --yes firebase-tools@latest emulators:start --project demo-lingora
