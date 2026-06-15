#!/bin/bash

set -euo pipefail

REPO="SuTang-vain/BabeL-O"
LATEST_RELEASE_API="https://api.github.com/repos/$REPO/releases/latest"
INSTALL_DIR="${BBL_INSTALL_DIR:-/usr/local/bin}"
TMP_PATH=""
GO_TUI_TMP_PATH=""
PORTABLE_TMP_PATH=""
PORTABLE_EXTRACT_DIR=""
SELF_CHECK_TMP_PATH=""
INSTALLED_GO_TUI_PATH=""
SEA_PAYLOAD_PATH=""
PORTABLE_INSTALL_DIR=""
PORTABLE_INSTALLED=0

supports_pretty_output() {
  [ -t 1 ] && [ "${TERM:-}" != "dumb" ] && [ "${BBL_INSTALL_PLAIN:-0}" != "1" ]
}

if supports_pretty_output; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RESET="$(printf '\033[0m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  CYAN="$(printf '\033[36m')"
  CLEAR_LINE="$(printf '\033[2K')"
else
  BOLD=""
  DIM=""
  RESET=""
  GREEN=""
  YELLOW=""
  RED=""
  CYAN=""
  CLEAR_LINE=""
fi

print_header() {
  printf '\n'
  printf '%sBabeL-O%s %sinstaller%s\n' "$BOLD" "$RESET" "$CYAN" "$RESET"
  printf '%sStandalone CLI + Go TUI%s\n\n' "$DIM" "$RESET"
}

log_kv() {
  printf '  %s%s:%s %s\n' "$DIM" "$1" "$RESET" "$2"
}

log_info() {
  printf '  %s%s%s\n' "$DIM" "$*" "$RESET"
}

log_ok() {
  printf '  %s[ok]%s %s\n' "$GREEN" "$RESET" "$*"
}

log_warn() {
  printf '  %s[warn]%s %s\n' "$YELLOW" "$RESET" "$*"
}

log_error() {
  printf '  %s[error]%s %s\n' "$RED" "$RESET" "$*" >&2
}

run_with_spinner() {
  label="$1"
  shift

  if ! supports_pretty_output; then
    log_info "$label"
    "$@"
    return $?
  fi

  log_path="$(mktemp "${TMPDIR:-/tmp}/babel-o-install.XXXXXX")"
  "$@" >"$log_path" 2>&1 &
  pid="$!"
  frames=("-" "\\" "|" "/")
  i=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    frame="${frames[$((i % 4))]}"
    printf '\r%s  %s%s%s %s' "$CLEAR_LINE" "$CYAN" "$frame" "$RESET" "$label"
    sleep 0.1
    i=$((i + 1))
  done

  if wait "$pid"; then
    printf '\r%s  %s[ok]%s %s\n' "$CLEAR_LINE" "$GREEN" "$RESET" "$label"
    rm -f "$log_path"
    return 0
  fi

  status="$?"
  printf '\r%s  %s[fail]%s %s\n' "$CLEAR_LINE" "$RED" "$RESET" "$label"
  cat "$log_path" >&2
  rm -f "$log_path"
  return "$status"
}

fail() {
  log_error "$*"
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
  if [ -n "$PORTABLE_TMP_PATH" ] && [ -f "$PORTABLE_TMP_PATH" ]; then
    rm -f "$PORTABLE_TMP_PATH"
  fi
  if [ -n "$PORTABLE_EXTRACT_DIR" ] && [ -d "$PORTABLE_EXTRACT_DIR" ]; then
    rm -rf "$PORTABLE_EXTRACT_DIR"
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
    curl -fL --silent --show-error --retry 3 --connect-timeout 15 --output "$output" "$url"
  elif have wget; then
    wget -q --tries=3 --timeout=30 --output-document="$output" "$url"
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

validate_archive() {
  path="$1"
  expected_size="$2"
  actual_size="$(file_size "$path")"

  if [ "$actual_size" -le 0 ]; then
    fail "Downloaded archive is empty."
  fi

  if [ -n "$expected_size" ] && printf '%s' "$expected_size" | grep -Eq '^[0-9]+$' && [ "$expected_size" -gt 0 ]; then
    if [ "$actual_size" -ne "$expected_size" ]; then
      fail "Downloaded archive is incomplete: expected $expected_size bytes, got $actual_size bytes."
    fi
  fi

  if ! have tar; then
    fail "tar is required to install the lightweight portable package."
  fi
  if ! tar -tzf "$path" >/dev/null 2>&1; then
    fail "Downloaded file is not a valid tar.gz archive."
  fi
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

ensure_node_for_portable() {
  if ! have node; then
    fail "BabeL-O $VERSION lightweight packages require Node.js >= 22 on PATH. Install Node.js, then rerun this installer."
  fi
  major="$(node_major)"
  if ! printf '%s' "$major" | grep -Eq '^[0-9]+$' || [ "$major" -lt 22 ]; then
    fail "BabeL-O $VERSION lightweight packages require Node.js >= 22; found Node.js $(node --version 2>/dev/null || echo unknown)."
  fi
}

write_portable_launcher() {
  app_dir="$1"
  cat > "$TARGET_PATH" <<EOF
#!/bin/sh
set -eu
APP_DIR="$app_dir"
exec "\$APP_DIR/bin/bbl" "\$@"
EOF
  chmod +x "$TARGET_PATH"
}

install_portable_bundle() {
  ensure_node_for_portable

  PORTABLE_TMP_PATH="$(mktemp "$INSTALL_DIR/bbl.portable.XXXXXX")"
  PORTABLE_EXTRACT_DIR="$(mktemp -d "$INSTALL_DIR/bbl.portable.extract.XXXXXX")"
  PORTABLE_EXPECTED_SIZE="$(content_length "$PORTABLE_DOWNLOAD_URL" || true)"

  log_kv "Package asset" "$PORTABLE_NAME"
  run_with_spinner "Downloading lightweight BabeL-O package" download_to "$PORTABLE_DOWNLOAD_URL" "$PORTABLE_TMP_PATH" || fail "Failed to download BabeL-O package from $PORTABLE_DOWNLOAD_URL."
  run_with_spinner "Validating lightweight package" validate_archive "$PORTABLE_TMP_PATH" "$PORTABLE_EXPECTED_SIZE" || fail "Downloaded BabeL-O package failed validation."

  tar -xzf "$PORTABLE_TMP_PATH" -C "$PORTABLE_EXTRACT_DIR"
  PORTABLE_TOP_PATH=""
  for candidate in "$PORTABLE_EXTRACT_DIR"/*; do
    [ -e "$candidate" ] || continue
    if [ -n "$PORTABLE_TOP_PATH" ]; then
      fail "Portable package must contain exactly one top-level application directory."
    fi
    PORTABLE_TOP_PATH="$candidate"
  done
  if [ -z "$PORTABLE_TOP_PATH" ] || [ ! -d "$PORTABLE_TOP_PATH" ]; then
    fail "Portable package did not contain an application directory."
  fi

  APP_INSTALL_ROOT="${BBL_APP_INSTALL_ROOT:-$HOME/.local/share/babel-o/app}"
  PORTABLE_INSTALL_DIR="$APP_INSTALL_ROOT/$VERSION-$GO_TUI_PLATFORM_SUFFIX"
  mkdir -p "$APP_INSTALL_ROOT"
  if [ ! -w "$APP_INSTALL_ROOT" ]; then
    fail "Portable app install directory is not writable: $APP_INSTALL_ROOT"
  fi
  rm -rf "$PORTABLE_INSTALL_DIR"
  mv "$PORTABLE_TOP_PATH" "$PORTABLE_INSTALL_DIR"
  rm -rf "$PORTABLE_EXTRACT_DIR"
  PORTABLE_EXTRACT_DIR=""
  rm -f "$PORTABLE_TMP_PATH"
  PORTABLE_TMP_PATH=""

  INSTALLED_GO_TUI_PATH="$PORTABLE_INSTALL_DIR/bin/go-tui-$GO_TUI_PLATFORM_SUFFIX"
  case "$GO_TUI_BINARY_NAME" in
    *windows*) INSTALLED_GO_TUI_PATH="$INSTALLED_GO_TUI_PATH.exe" ;;
  esac
  if [ ! -x "$INSTALLED_GO_TUI_PATH" ]; then
    fail "Portable package is missing executable Go TUI binary: $INSTALLED_GO_TUI_PATH"
  fi

  write_portable_launcher "$PORTABLE_INSTALL_DIR"
  PORTABLE_INSTALLED=1
  log_ok "BabeL-O lightweight package installed: $PORTABLE_INSTALL_DIR"
  log_ok "BabeL-O launcher installed: $TARGET_PATH"
}

install_shell_launcher() {
  if [ "$PORTABLE_INSTALLED" = "1" ]; then
    return 0
  fi
  if [ -z "$INSTALLED_GO_TUI_PATH" ]; then
    return 0
  fi
  if [ "$OS" != "darwin" ]; then
    return 0
  fi

  SEA_PAYLOAD_PATH="$TARGET_PATH.sea"
  mv "$TARGET_PATH" "$SEA_PAYLOAD_PATH"
  cat > "$TARGET_PATH" <<EOF
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
SEA_PAYLOAD="\$SCRIPT_DIR/bbl.sea"
GO_TUI_FALLBACK="$INSTALLED_GO_TUI_PATH"
GO_TUI_PLATFORM_BINARY="go-tui-$GO_TUI_PLATFORM_SUFFIX"

have() {
  command -v "\$1" >/dev/null 2>&1
}

is_local_url() {
  case "\$1" in
    http://127.0.0.1:*|http://localhost:*|http://[::1]:*) return 0 ;;
    ws://127.0.0.1:*|ws://localhost:*|ws://[::1]:*) return 0 ;;
    *) return 1 ;;
  esac
}

url_port() {
  printf '%s' "\$1" | sed -E 's#^[a-z]+://(\\[[^]]+\\]|[^:/]+):([0-9]+).*\$#\\2#'
}

health_url() {
  printf '%s' "\$1" | sed -E 's#^ws:#http:#; s#^wss:#https:#; s#/*\$#/health#'
}

resolve_go_tui_binary() {
  if [ -n "\${BABEL_O_GO_TUI_BINARY:-}" ]; then
    printf '%s\n' "\$BABEL_O_GO_TUI_BINARY"
    return 0
  fi
  local user_local
  user_local="\${HOME:-}/.local/share/babel-o/bin/\$GO_TUI_PLATFORM_BINARY"
  if [ -x "\$user_local" ]; then
    printf '%s\n' "\$user_local"
    return 0
  fi
  printf '%s\n' "\$GO_TUI_FALLBACK"
}

nexus_healthy() {
  local probe_url
  probe_url="\$(health_url "\$1")"
  if have curl; then
    curl -fsS --max-time 1 "\$probe_url" >/dev/null 2>&1
  elif have wget; then
    wget -q --timeout=1 --spider "\$probe_url" >/dev/null 2>&1
  else
    return 1
  fi
}

wait_for_nexus() {
  local wait_url
  local i
  wait_url="\$1"
  i=0
  while [ "\$i" -lt 80 ]; do
    if nexus_healthy "\$wait_url"; then
      return 0
    fi
    sleep 0.1
    i=\$((i + 1))
  done
  return 1
}

run_go_tui() {
  local url
  local cwd
  local start_nexus
  local allowed_tools
  local go_args
  local go_tui_binary
  url="http://127.0.0.1:3000"
  cwd="\${BABEL_O_LAUNCH_CWD:-\$(pwd)}"
  start_nexus=1
  allowed_tools="\${NEXUS_ALLOWED_TOOLS:-*}"
  go_args=()
  go_tui_binary="\$(resolve_go_tui_binary)"

  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --url)
        url="\${2:-}"
        shift 2
        ;;
      --url=*)
        url="\${1#--url=}"
        shift
        ;;
      --cwd)
        cwd="\${2:-}"
        shift 2
        ;;
      --cwd=*)
        cwd="\${1#--cwd=}"
        shift
        ;;
      --no-start-nexus)
        start_nexus=0
        shift
        ;;
      --start-nexus)
        start_nexus=1
        shift
        ;;
      --allowed-tools)
        allowed_tools="\${2:-}"
        shift 2
        ;;
      --allowed-tools=*)
        allowed_tools="\${1#--allowed-tools=}"
        shift
        ;;
      --binary)
        go_tui_binary="\${2:-}"
        shift 2
        ;;
      --binary=*)
        go_tui_binary="\${1#--binary=}"
        shift
        ;;
      --source-dir=*)
        shift
        ;;
      --source-dir)
        shift 2
        ;;
      --check)
        BABEL_O_GO_TUI_BINARY="\$go_tui_binary" NODE_NO_WARNINGS=1 exec "\$SEA_PAYLOAD" go --check --no-start-nexus --url "\$url" --cwd "\$cwd"
        ;;
      *)
        go_args+=("\$1")
        shift
        ;;
    esac
  done

  if ! nexus_healthy "\$url"; then
    if [ "\$start_nexus" = "1" ] && is_local_url "\$url"; then
      local port
      port="\$(url_port "\$url")"
      if ! printf '%s' "\$port" | grep -Eq '^[0-9]+\$'; then
        port="3000"
      fi
      NEXUS_HOST="127.0.0.1" NEXUS_PORT="\$port" BABEL_O_WORKSPACE="\$cwd" NEXUS_ALLOWED_TOOLS="\$allowed_tools" NODE_NO_WARNINGS=1 "\$SEA_PAYLOAD" __server >/tmp/babel-o-nexus.\$\$.log 2>&1 &
      local nexus_pid
      nexus_pid="\$!"
      cleanup() {
        kill "\$nexus_pid" >/dev/null 2>&1 || true
      }
      trap cleanup EXIT INT TERM
      if ! wait_for_nexus "\$url"; then
        cat /tmp/babel-o-nexus.\$\$.log >&2 2>/dev/null || true
        echo "Error: timed out waiting for Nexus health at \$url" >&2
        exit 1
      fi
    else
      echo "Error: Nexus is not healthy at \$url. Start Nexus first or use a localhost URL with --start-nexus." >&2
      exit 1
    fi
  fi

  if [ ! -x "\$go_tui_binary" ]; then
    echo "Error: Go TUI binary is not executable: \$go_tui_binary" >&2
    exit 1
  fi

  exec "\$go_tui_binary" --url "\$url" --cwd "\$cwd" \${go_args[@]+"\${go_args[@]}"}
}

if [ "\${1:-}" = "go" ]; then
  shift
  run_go_tui "\$@"
fi

exec "\$SEA_PAYLOAD" "\$@"
EOF
  chmod +x "$TARGET_PATH"
  log_ok "Shell launcher installed for macOS bbl go startup."
}

run_self_check() {
  if [ "${BBL_INSTALL_SMOKE:-1}" = "0" ]; then
    log_warn "Skipping install self-check because BBL_INSTALL_SMOKE=0."
    return 0
  fi

  echo "Running install self-check..."

  if [ -n "$INSTALLED_GO_TUI_PATH" ]; then
    SELF_CHECK_TMP_PATH="$(mktemp "$INSTALL_DIR/bbl.self-check.XXXXXX")"
    if "$INSTALLED_GO_TUI_PATH" --version >"$SELF_CHECK_TMP_PATH" 2>&1; then
      log_ok "Go TUI executable starts: $(head -n 1 "$SELF_CHECK_TMP_PATH")"
    else
      cat "$SELF_CHECK_TMP_PATH" >&2
      fail "Install self-check failed: installed Go TUI binary cannot start."
    fi

    if NODE_NO_WARNINGS=1 BABEL_O_GO_TUI_BINARY="$INSTALLED_GO_TUI_PATH" "$TARGET_PATH" go --check --no-start-nexus >"$SELF_CHECK_TMP_PATH" 2>&1; then
      cat "$SELF_CHECK_TMP_PATH"
      rm -f "$SELF_CHECK_TMP_PATH"
      SELF_CHECK_TMP_PATH=""
      log_ok "BabeL-O is ready. Run 'bbl go' to start the Go TUI."
      return 0
    fi

    cat "$SELF_CHECK_TMP_PATH" >&2
    fail "Install self-check failed: bbl go readiness check did not pass. Try BBL_INSTALL_SMOKE=0 to skip the check, or install from source."
  fi

  if "$TARGET_PATH" --version >/dev/null 2>&1; then
    log_ok "BabeL-O CLI is installed. Go TUI self-check was skipped because BBL_INSTALL_GO_TUI=0."
    return 0
  fi

  fail "Install self-check failed: installed bbl binary cannot start."
}

print_header

if [ -n "${BBL_VERSION:-}" ]; then
  VERSION="$BBL_VERSION"
else
  VERSION="$(latest_version || true)"
fi

if [ -z "$VERSION" ]; then
  fail "Failed to determine latest release version. Set BBL_VERSION=v0.3.8 to install a specific release."
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
        fail "Unsupported Linux architecture: $ARCH. Only x64 is supported for the release installer. Install from npm/source on Linux arm64."
        ;;
    esac
    ;;
  *)
    fail "Unsupported operating system: $OS. Only macOS and Linux are supported by this installer."
    ;;
esac

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY_NAME"
GO_TUI_DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$GO_TUI_BINARY_NAME"
PORTABLE_NAME="$BINARY_NAME.tar.gz"
PORTABLE_DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$PORTABLE_NAME"
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

log_kv "Version" "$VERSION"
log_kv "System" "$OS ($ARCH)"
log_kv "Install path" "$TARGET_PATH"

if [ -z "$BINARY_NAME" ]; then
  fail "No standalone bbl binary is published for $OS ($ARCH). Install from npm/source, or use a supported release platform."
fi

if asset_exists "$PORTABLE_DOWNLOAD_URL"; then
  install_portable_bundle
else
  TMP_PATH="$(mktemp "$INSTALL_DIR/bbl.download.XXXXXX")"
  EXPECTED_SIZE="$(content_length "$DOWNLOAD_URL" || true)"

  log_kv "CLI asset" "$BINARY_NAME"

  if ! asset_exists "$DOWNLOAD_URL"; then
    fail "Release asset not found: $DOWNLOAD_URL. The $VERSION release may not have finished publishing binaries yet."
  fi

  run_with_spinner "Downloading BabeL-O CLI" download_to "$DOWNLOAD_URL" "$TMP_PATH" || fail "Failed to download BabeL-O CLI from $DOWNLOAD_URL."
  run_with_spinner "Validating BabeL-O CLI" validate_binary "$TMP_PATH" "$EXPECTED_SIZE" || fail "Downloaded BabeL-O CLI failed validation."
  chmod +x "$TMP_PATH"
  mv "$TMP_PATH" "$TARGET_PATH"
  TMP_PATH=""

  log_ok "BabeL-O CLI installed: $TARGET_PATH"

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
      log_kv "Go TUI asset" "$GO_TUI_BINARY_NAME"
      log_kv "Go TUI path" "$GO_TUI_TARGET_PATH"
      run_with_spinner "Downloading Go TUI" download_to "$GO_TUI_DOWNLOAD_URL" "$GO_TUI_TMP_PATH" || fail "Failed to download Go TUI from $GO_TUI_DOWNLOAD_URL."
      run_with_spinner "Validating Go TUI" validate_binary "$GO_TUI_TMP_PATH" "$GO_TUI_EXPECTED_SIZE" || fail "Downloaded Go TUI failed validation."
      chmod +x "$GO_TUI_TMP_PATH"
      mv "$GO_TUI_TMP_PATH" "$GO_TUI_TARGET_PATH"
      GO_TUI_TMP_PATH=""
      INSTALLED_GO_TUI_PATH="$GO_TUI_TARGET_PATH"
      log_ok "Go TUI installed: $GO_TUI_TARGET_PATH"
    else
      fail "Go TUI release asset not found: $GO_TUI_DOWNLOAD_URL. The $VERSION release may not have finished publishing Go TUI binaries yet. Set BBL_INSTALL_GO_TUI=0 to install only the bbl CLI."
    fi
  fi
fi

install_shell_launcher
run_self_check

if [ "$PATH_SUGGESTION" = true ]; then
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    log_warn "$INSTALL_DIR is not in your system PATH."
    echo "Please add it to your shell configuration file, for example ~/.bashrc or ~/.zshrc:"
    echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
    echo "Then restart your terminal or run: source ~/.zshrc"
  fi
fi

printf '\n'
log_ok "Install complete."
echo "To start chatting, run: bbl go"
