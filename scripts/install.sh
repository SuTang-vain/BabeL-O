#!/bin/bash
# BabeL-O Automatic Installer
# Detects OS/Arch, downloads the compiled SEA binary, and installs it to the system path.

set -e

REPO="SuTang-vain/BabeL-O"

echo "=== BabeL-O Standalone Binary Installer ==="

# Fetch latest release tag from GitHub API
VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
  echo "Error: Failed to determine latest release version."
  exit 1
fi
echo "Latest version: $VERSION"

# 1. Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin)
    if [ "$ARCH" = "arm64" ]; then
      BINARY_NAME="bbl-darwin-arm64"
    else
      BINARY_NAME="bbl-darwin-x64"
    fi
    ;;
  linux)
    if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
      BINARY_NAME="bbl-linux-x64"
    else
      echo "Error: Unsupported Linux architecture: $ARCH. Only x64 is supported for pre-compiled binaries."
      exit 1
    fi
    ;;
  *)
    echo "Error: Unsupported operating system: $OS. Only macOS and Linux are supported by this installer."
    exit 1
    ;;
esac

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY_NAME"
INSTALL_DIR="/usr/local/bin"
PATH_SUGGESTION=false

# If /usr/local/bin is not writable, fall back to ~/.local/bin to avoid sudo requirement
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  PATH_SUGGESTION=true
fi

TARGET_PATH="$INSTALL_DIR/bbl"

echo "Detected System: $OS ($ARCH)"
echo "Downloading binary from: $DOWNLOAD_URL"
echo "Target Installation Path: $TARGET_PATH"

# Perform download
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --output "$TARGET_PATH" "$DOWNLOAD_URL"
elif command -v wget >/dev/null 2>&1; then
  wget --output-document="$TARGET_PATH" "$DOWNLOAD_URL"
else
  echo "Error: curl or wget is required to run this installer."
  exit 1
fi

# Make binary executable
chmod +x "$TARGET_PATH"

echo "----------------------------------------"
echo "✔ BabeL-O installed successfully to: $TARGET_PATH"
echo "----------------------------------------"

# Provide PATH warnings if installed to custom directory
if [ "$PATH_SUGGESTION" = true ]; then
  # Check if INSTALL_DIR is in PATH
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo "⚠️ Warning: $INSTALL_DIR is not in your system PATH."
    echo "Please add it to your shell configuration file (e.g. ~/.bashrc or ~/.zshrc):"
    echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
    echo "Then restart your terminal or run: source ~/.zshrc"
  fi
fi

echo "To start chatting, run: bbl chat"
