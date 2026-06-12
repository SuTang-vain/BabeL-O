#!/bin/bash

set -euo pipefail

REPO="SuTang-vain/BabeL-O"
LATEST_RELEASE_API="https://api.github.com/repos/$REPO/releases/latest"
INSTALL_DIR="${BBL_INSTALL_DIR:-/usr/local/bin}"
TMP_PATH=""

fail() {
  echo "Error: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_PATH" ] && [ -f "$TMP_PATH" ]; then
    rm -f "$TMP_PATH"
  fi
}
trap cleanup EXIT

have() {
  command -v "$1" >/dev/null 2>&1
}

fetch_url() {
  url="$1"
  if have curl; then
    curl -fsSL "$url"
  elif have wget; then
    wget -qO- "$url"
  else
    fail "curl or wget is required to run this installer."
  fi
}

latest_version() {
  fetch_url "$LATEST_RELEASE_API" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | head -n 1
}

download_to() {
  url="$1"
  output="$2"
  if have curl; then
    curl -fL --retry 3 --connect-timeout 15 --output "$output" "$url"
  elif have wget; then
    wget --tries=3 --timeout=30 --output-document="$output" "$url"
  else
    fail "curl or wget is required to run this installer."
  fi
}

content_length() {
  url="$1"
  if have curl; then
    curl -fsIL "$url" | tr '[:upper:]' '[:lower:]' | awk -F': ' '/^content-length:/ { gsub(/\r/, "", $2); len=$2 } END { print len }'
  elif have wget; then
    wget --spider --server-response "$url" 2>&1 | tr '[:upper:]' '[:lower:]' | awk -F': ' '/^content-length:/ { gsub(/\r/, "", $2); len=$2 } END { print len }'
  fi
}

file_size() {
  wc -c < "$1" | tr -d ' '
}

validate_binary() {
  path="$1"
  expected_size="$2"
  actual_size="$(file_size "$path")"

  if [ "$actual_size" -le 0 ]; then
    fail "Downloaded file is empty."
  fi

  if [ -n "$expected_size" ] && printf '%s' "$expected_size" | grep -Eq '^[0-9]+$' && [ "$expected_size" -gt 0 ]; then
    if [ "$actual_size" -ne "$expected_size" ]; then
      fail "Downloaded file is incomplete: expected $expected_size bytes, got $actual_size bytes."
    fi
  fi

  magic4="$(od -An -tx1 -N4 "$path" | tr -d ' \n')"
  case "$magic4" in
    7f454c46|feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca)
      return 0
      ;;
  esac

  magic2="$(od -An -tx1 -N2 "$path" | tr -d ' \n')"
  if [ "$magic2" = "4d5a" ]; then
    return 0
  fi

  if have file; then
    file_output="$(file "$path")"
    case "$file_output" in
      *Mach-O*|*ELF*|*PE32*)
        return 0
        ;;
    esac
  fi

  fail "Downloaded file is not a recognized executable binary."
}

echo "=== BabeL-O Standalone Binary Installer ==="

if [ -n "${BBL_VERSION:-}" ]; then
  VERSION="$BBL_VERSION"
else
  VERSION="$(latest_version || true)"
fi

if [ -z "$VERSION" ]; then
  fail "Failed to determine latest release version. Set BBL_VERSION=v0.3.3 to install a specific release."
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin)
    case "$ARCH" in
      arm64|aarch64)
        BINARY_NAME="bbl-darwin-arm64"
        ;;
      x86_64|amd64)
        BINARY_NAME="bbl-darwin-x64"
        ;;
      *)
        fail "Unsupported macOS architecture: $ARCH. Only arm64 and x64 are supported for pre-compiled binaries."
        ;;
    esac
    ;;
  linux)
    case "$ARCH" in
      x86_64|amd64)
        BINARY_NAME="bbl-linux-x64"
        ;;
      *)
        fail "Unsupported Linux architecture: $ARCH. Only x64 is supported for pre-compiled binaries."
        ;;
    esac
    ;;
  *)
    fail "Unsupported operating system: $OS. Only macOS and Linux are supported by this installer."
    ;;
esac

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY_NAME"
PATH_SUGGESTION=false

if [ -n "${BBL_INSTALL_DIR:-}" ]; then
  mkdir -p "$INSTALL_DIR"
  if [ ! -w "$INSTALL_DIR" ]; then
    fail "BBL_INSTALL_DIR is not writable: $INSTALL_DIR"
  fi
  PATH_SUGGESTION=true
elif [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
  PATH_SUGGESTION=true
fi

TARGET_PATH="$INSTALL_DIR/bbl"
TMP_PATH="$(mktemp "$INSTALL_DIR/bbl.download.XXXXXX")"
EXPECTED_SIZE="$(content_length "$DOWNLOAD_URL" || true)"

echo "Version: $VERSION"
echo "Detected System: $OS ($ARCH)"
echo "Downloading binary from: $DOWNLOAD_URL"
echo "Target Installation Path: $TARGET_PATH"

download_to "$DOWNLOAD_URL" "$TMP_PATH"
validate_binary "$TMP_PATH" "$EXPECTED_SIZE"
chmod +x "$TMP_PATH"
mv "$TMP_PATH" "$TARGET_PATH"
TMP_PATH=""

echo "----------------------------------------"
echo "BabeL-O installed successfully to: $TARGET_PATH"
echo "----------------------------------------"

if [ "$PATH_SUGGESTION" = true ]; then
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo "Warning: $INSTALL_DIR is not in your system PATH."
    echo "Please add it to your shell configuration file, for example ~/.bashrc or ~/.zshrc:"
    echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
    echo "Then restart your terminal or run: source ~/.zshrc"
  fi
fi

echo "To start chatting, run: bbl go"
