#!/bin/zsh -l
# Double-click in Finder to start the local Lingora backend (Firebase emulators).
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" && nvm use --silent default >/dev/null 2>&1
./scripts/dev.sh
echo
echo "Backend stopped. Press Enter to close."
read
