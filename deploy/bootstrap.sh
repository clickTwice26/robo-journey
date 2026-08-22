#!/usr/bin/env bash
#
# Put robo-journey on a machine that has nothing on it yet.
#
#   curl -fsSL https://raw.githubusercontent.com/clickTwice26/robo-journey/master/deploy/bootstrap.sh \
#     | sudo bash -s -- --domain sim.example.com --email you@example.com
#
# Or, if you would rather read it first -- and you should, this runs as root:
#
#   curl -fsSL https://raw.githubusercontent.com/clickTwice26/robo-journey/master/deploy/bootstrap.sh -o bootstrap.sh
#   less bootstrap.sh
#   sudo bash bootstrap.sh --domain sim.example.com --email you@example.com
#
# This script does three things and then gets out of the way: makes sure git and docker are here,
# clones the repository, and hands over to `deploy/install.sh`, which is where all the real
# decisions live -- what is already listening on 80 and 443, whether the domain resolves here,
# whether to start Caddy or write a site file for the proxy you already have.
#
# It is deliberately standalone. It cannot source anything from the repository, because when it
# starts there is no repository; that is the whole point of it. The small amount of duplication
# with install.sh is the price of being runnable from a URL.
#
# Running it again updates an existing install: it pulls, then re-runs the installer, which keeps
# every secret already in .env. It will not touch a checkout with uncommitted changes in it.

set -euo pipefail

REPO_URL="https://github.com/clickTwice26/robo-journey.git"
BRANCH="master"
TARGET="/opt/robo-journey"
ASSUME_YES="no"
DRY_RUN="no"
INSTALL_ARGS=()

# --- Saying things ------------------------------------------------------------------------------

if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; R=$'\033[0m'
else
  B=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; R=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$R" "$B" "$1" "$R"; }
info() { printf '    %s\n' "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$R"; }
good() { printf '    %s✓%s %s\n' "$GREEN" "$R" "$1"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$R" "$1"; }
die()  { printf '\n%serror:%s %s\n\n' "$RED" "$R" "$1" >&2; exit 1; }

# Read from the terminal, not from stdin: under `curl | bash` stdin is the script itself, and a
# prompt that reads it would swallow the rest of this file.
confirm() { # confirm "question" -> 0 for yes
  [[ "$ASSUME_YES" == "yes" ]] && return 0
  [[ ! -e /dev/tty ]] && return 1
  local answer
  read -r -p "    $1 [y/N]: " answer </dev/tty || true
  [[ "$answer" =~ ^[Yy] ]]
}

usage() {
  cat <<USAGE
robo-journey bootstrap -- clone and install on a fresh machine

  --domain <host>     the name people will use, e.g. sim.example.com
  --email <address>   where Let's Encrypt sends expiry warnings
  --dir <path>        where to put the checkout (default $TARGET)
  --repo <url>        clone from somewhere else, e.g. your own fork
  --branch <ref>      branch or tag to check out (default $BRANCH)
  --dry-run           work everything out in a temporary clone and change nothing
  --yes               take every default and install docker if it is missing, without asking
  --help

Anything else is passed straight through to deploy/install.sh:

  --app-port <port>   where the app listens on loopback (default 28610)
  --behind-proxy      always configure for a proxy that is already running

USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) TARGET="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="yes"; INSTALL_ARGS+=(--dry-run); shift ;;
    --yes|-y) ASSUME_YES="yes"; INSTALL_ARGS+=(--yes); shift ;;
    --help|-h) usage; exit 0 ;;
    # Not ours: the installer's problem. Kept in order, with their values.
    *) INSTALL_ARGS+=("$1"); shift ;;
  esac
done

# --- What this machine has ----------------------------------------------------------------------

step "Checking this machine"

# Linux servers only, and worth saying before this starts installing packages on something it was
# never meant to touch.
[[ "$(uname -s)" == "Linux" ]] || die \
  "this installer supports Linux servers only (this is $(uname -s))."

# The package manager, if we recognise it. Used only to offer to install git.
PKG=""
for candidate in apt-get dnf yum pacman apk; do
  if command -v "$candidate" >/dev/null 2>&1; then PKG="$candidate"; break; fi
done

install_package() { # install_package <name>
  local name="$1"
  case "$PKG" in
    apt-get) apt-get update -qq && apt-get install -y -qq "$name" ;;
    dnf)     dnf install -y -q "$name" ;;
    yum)     yum install -y -q "$name" ;;
    pacman)  pacman -Sy --noconfirm "$name" ;;
    apk)     apk add --no-cache "$name" ;;
    *) return 1 ;;
  esac
}

if command -v git >/dev/null 2>&1; then
  good "git $(git --version | awk '{print $3}')"
else
  warn "git is not installed, and this script needs it to fetch the source."
  if [[ -z "$PKG" ]]; then
    die "no package manager I recognise. Install git and run this again."
  fi
  confirm "Install git with $PKG?" || die "Install git and run this again."
  install_package git || die "installing git failed. Install it by hand and run this again."
  good "installed git"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  good "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present)"
else
  warn "docker with the compose plugin is not installed."
  info ""
  info "The official installer at https://get.docker.com adds Docker's package repository to"
  info "this machine and installs the engine, the CLI and the compose plugin. That is a change"
  info "to your system's package sources, so it is worth a moment's thought rather than a yes."
  info ""
  if confirm "Fetch and run get.docker.com?"; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh ||
      die "could not download the Docker installer."
    sh /tmp/get-docker.sh || die "the Docker installer failed. See its output above."
    rm -f /tmp/get-docker.sh
    good "installed docker"
  else
    die "Install Docker and the compose plugin, then run this again:
       https://docs.docker.com/engine/install/"
  fi
fi

if ! docker info >/dev/null 2>&1; then
  die "cannot talk to the docker daemon. Start it, or run this with sudo."
fi

# --- Where the source goes -----------------------------------------------------------------------

# A dry run over an existing install has to be *that* install, or it answers the wrong question.
# Only when there is nothing there yet does it need somewhere to put a clone.
if [[ "$DRY_RUN" == "yes" ]]; then
  step "Dry run"
  if [[ -d "$TARGET/.git" ]]; then
    info "Reading the install already at $TARGET. Nothing will be changed."
  else
    TARGET="$(mktemp -d)"
    trap 'rm -rf "$TARGET"' EXIT
    info "Nothing is installed yet, so this clones somewhere temporary and changes nothing."
    note "$TARGET, removed when this finishes"
  fi
fi

step "Source"

if [[ -d "$TARGET/.git" ]]; then
  # An existing install. Update it rather than starting over, and never at the cost of work that
  # is sitting there uncommitted -- someone editing a Caddyfile on the server is a person, not a
  # merge conflict.
  info "$TARGET is already a checkout."
  if [[ -n "$(git -C "$TARGET" status --porcelain 2>/dev/null)" ]]; then
    warn "it has uncommitted changes:"
    git -C "$TARGET" status --short | sed 's/^/      /'
    info ""
    die "Not touching them. Commit or stash them, then run this again."
  fi
  git -C "$TARGET" fetch --quiet origin "$BRANCH" || die "could not fetch from origin."

  BEHIND="$(git -C "$TARGET" rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)"
  if [[ "$DRY_RUN" == "yes" ]]; then
    # `fetch` moved a remote-tracking ref and nothing else; the checkout is untouched.
    if [[ "$BEHIND" == "0" ]]; then
      good "already at origin/$BRANCH ($(git -C "$TARGET" rev-parse --short HEAD))"
    else
      info "would fast-forward $BEHIND commit(s) to $(git -C "$TARGET" rev-parse --short "origin/$BRANCH")"
    fi
  else
    # Fast-forward only: a merge commit made by a deploy script is nobody's idea of history.
    git -C "$TARGET" merge --ff-only "origin/$BRANCH" ||
      die "$TARGET has diverged from origin/$BRANCH. Sort it out by hand, then run this again."
    good "updated to $(git -C "$TARGET" rev-parse --short HEAD)"
  fi
elif [[ -e "$TARGET" && -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
  die "$TARGET exists and has something in it that is not a git checkout.
       Move it, or choose somewhere else with --dir."
else
  info "git clone $REPO_URL"
  mkdir -p "$(dirname "$TARGET")" 2>/dev/null || true
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET" ||
    die "could not clone $REPO_URL (branch $BRANCH).
       If it is private, set up a deploy key first, or use --repo with an SSH URL."
  good "cloned to $TARGET at $(git -C "$TARGET" rev-parse --short HEAD)"
fi

[[ -f "$TARGET/deploy/install.sh" ]] ||
  die "$TARGET does not look like robo-journey -- deploy/install.sh is not in it."

# --- Over to the installer ------------------------------------------------------------------------

step "Installing"
info "Everything from here is deploy/install.sh, which decides what to do about ports,"
info "certificates and whatever else is already running on this machine."

# `exec` on a real run so the installer owns the terminal and its exit status is ours. Not on a dry
# run, where the EXIT trap still has a temporary directory to remove.
if [[ "$DRY_RUN" == "yes" ]]; then
  bash "$TARGET/deploy/install.sh" "${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}"
else
  cd "$TARGET"
  exec bash "$TARGET/deploy/install.sh" "${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}"
fi
