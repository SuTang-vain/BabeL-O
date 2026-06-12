#!/bin/bash

set -euo pipefail

REPO="SuTang-vain/BabeL-O"
LATEST_RELEASE_API="https://api.github.com/repos/$REPO/releases/latest"
INSTALL_DIR="${BBL_INSTALL_DIR:-/usr/local/bin}"
TMP_PATH=""
GO_TUI_TMP_PATH=""
SELF_CHECK_TMP_PATH=""
INSTALLED_GO_TUI_PATH=""

fail() {
  echo "Error: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_PATH" ] && [ -f "$TMP_PATH" ]; then
    rm -f "$TMP_PATH"
  fi
  if [ -n "$GO_TUI_TMP_PATH" ] && [ -f "$GO_TUI_TMP_PATH" ]; then
    rm -f "$GO_TUI_TMP_PATH"
  fi
  if [ -n "$SELF_CHECK_TMP_PATH" ] && [ -f "$SELF_CHECK_TMP_PATH" ]; then
    rm -f "$SELF_CHECK_TMP_PATH"
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

asset_exists() {
  url="$1"
  if have curl; then
    curl -fsIL "$url" >/dev/null 2>&1
  elif have wget; then
    wget --spider --server-response "$url" >/dev/null 2>&1
  else
    return 1
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
  if [ "$magic2" = "2321" ]; then
    return 0
  fi

  if have file; then
    file_output="$(file "$path")"
    case "$file_output" in
      *Mach-O*|*ELF*|*PE32*|*script*)
        return 0
        ;;
    esac
  fi

  fail "Downloaded file is not a recognized executable binary."
}

run_self_check() {
  if [ "${BBL_INSTALL_SMOKE:-1}" = "0" ]; then
    echo "Skipping install self-check because BBL_INSTALL_SMOKE=0."
    return 0
  fi

  echo "Running install self-check..."

  if [ -n "$INSTALLED_GO_TUI_PATH" ]; then
    SELF_CHECK_TMP_PATH="$(mktemp "$INSTALL_DIR/bbl.self-check.XXXXXX")"
    if BABEL_O_GO_TUI_BINARY="$INSTALLED_GO_TUI_PATH" "$TARGET_PATH" go --check --no-start-nexus >"$SELF_CHECK_TMP_PATH" 2>&1; then
      cat "$SELF_CHECK_TMP_PATH"
      rm -f "$SELF_CHECK_TMP_PATH"
      SELF_CHECK_TMP_PATH=""
      echo "BabeL-O is ready. Run 'bbl go' to start the Go TUI."
      return 0
    fi

    cat "$SELF_CHECK_TMP_PATH" >&2
    fail "Install self-check failed: bbl go readiness check did not pass. Try BBL_INSTALL_SMOKE=0 to skip the check, or install from npm/source."
  fi

  if "$TARGET_PATH" --version >/dev/null 2>&1; then
    echo "BabeL-O CLI is installed. Go TUI self-check was skipped because BBL_INSTALL_GO_TUI=0."
    return 0
  fi

  fail "Install self-check failed: installed bbl binary cannot start."
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
        GO_TUI_BINARY_NAME="go-tui-darwin-arm64"
        GO_TUI_PLATFORM_SUFFIX="darwin-arm64"
        ;;
      x86_64|amd64)
        BINARY_NAME="bbl-darwin-x64"
        GO_TUI_BINARY_NAME="go-tui-darwin-x64"
        GO_TUI_PLATFORM_SUFFIX="darwin-x64"
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
        GO_TUI_BINARY_NAME="go-tui-linux-x64"
        GO_TUI_PLATFORM_SUFFIX="linux-x64"
        ;;
      *)
        fail "Unsupported Linux architecture: $ARCH. Only x64 is supported for the standalone installer. Install from npm/source on Linux arm64."
        ;;
    esac
    ;;
  *)
    fail "Unsupported operating system: $OS. Only macOS and Linux are supported by this installer."
    ;;
esac

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY_NAME"
GO_TUI_DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$GO_TUI_BINARY_NAME"
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

if [ -z "$BINARY_NAME" ]; then
  fail "No standalone bbl binary is published for $OS ($ARCH). Install from npm/source, or use a supported release platform."
fi

if ! asset_exists "$DOWNLOAD_URL"; then
  fail "Release asset not found: $DOWNLOAD_URL. The $VERSION release may not have finished publishing binaries yet."
fi

download_to "$DOWNLOAD_URL" "$TMP_PATH"
validate_binary "$TMP_PATH" "$EXPECTED_SIZE"
chmod +x "$TMP_PATH"
mv "$TMP_PATH" "$TARGET_PATH"
TMP_PATH=""

echo "----------------------------------------"
echo "BabeL-O installed successfully to: $TARGET_PATH"
echo "----------------------------------------"

if [ "${BBL_INSTALL_GO_TUI:-1}" != "0" ]; then
  GO_TUI_INSTALL_DIR="${BBL_GO_TUI_INSTALL_DIR:-$HOME/.local/share/babel-o/bin}"
  GO_TUI_TARGET_PATH="$GO_TUI_INSTALL_DIR/go-tui-$GO_TUI_PLATFORM_SUFFIX"
  case "$GO_TUI_BINARY_NAME" in
    *windows*) GO_TUI_TARGET_PATH="$GO_TUI_TARGET_PATH.exe" ;;
  esac
  mkdir -p "$GO_TUI_INSTALL_DIR"
  if [ ! -w "$GO_TUI_INSTALL_DIR" ]; then
    fail "Go TUI install directory is not writable: $GO_TUI_INSTALL_DIR"
  fi

  if asset_exists "$GO_TUI_DOWNLOAD_URL"; then
    GO_TUI_TMP_PATH="$(mktemp "$GO_TUI_INSTALL_DIR/go-tui.download.XXXXXX")"
    GO_TUI_EXPECTED_SIZE="$(content_length "$GO_TUI_DOWNLOAD_URL" || true)"
    echo "Downloading Go TUI binary from: $GO_TUI_DOWNLOAD_URL"
    echo "Go TUI Installation Path: $GO_TUI_TARGET_PATH"
    download_to "$GO_TUI_DOWNLOAD_URL" "$GO_TUI_TMP_PATH"
    validate_binary "$GO_TUI_TMP_PATH" "$GO_TUI_EXPECTED_SIZE"
    chmod +x "$GO_TUI_TMP_PATH"
    mv "$GO_TUI_TMP_PATH" "$GO_TUI_TARGET_PATH"
    GO_TUI_TMP_PATH=""
    INSTALLED_GO_TUI_PATH="$GO_TUI_TARGET_PATH"
    echo "Go TUI installed successfully to: $GO_TUI_TARGET_PATH"
  else
    fail "Go TUI release asset not found: $GO_TUI_DOWNLOAD_URL. The $VERSION release may not have finished publishing Go TUI binaries yet. Set BBL_INSTALL_GO_TUI=0 to install only the bbl CLI."
  fi
fi

run_self_check

if [ "$PATH_SUGGESTION" = true ]; then
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo "Warning: $INSTALL_DIR is not in your system PATH."
    echo "Please add it to your shell configuration file, for example ~/.bashrc or ~/.zshrc:"
    echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
    echo "Then restart your terminal or run: source ~/.zshrc"
  fi
fi

echo "To start chatting, run: bbl go"
