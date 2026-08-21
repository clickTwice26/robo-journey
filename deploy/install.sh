#!/usr/bin/env bash
#
# Install robo-journey on this machine, with a domain and a certificate.
#
#   sudo ./deploy/install.sh --domain sim.example.com --email you@example.com
#
# The whole design of this script is one idea: find out what is already running here before
# changing anything. A deploy script that assumes it owns port 443 will take down whatever was
# serving on it, and the person running it finds out from their users.
#
# So it looks first, and picks one of two shapes:
#
#   Edge      -- 80 and 443 are free. Caddy runs in a container, gets a certificate, renews it
#                forever, and proxies to the app. Nothing else on the machine is touched.
#
#   Behind    -- something is already there. Caddy is NOT started. The app is bound to loopback and
#                the script writes a ready-to-paste site file for whatever proxy is already
#                running, then tells you the two commands to enable it. Your existing sites keep
#                serving throughout.
#
# `--dry-run` works all of it out and writes nothing, so it can be read before it is trusted.
#
# It is safe to run twice. Secrets that already exist are kept, never regenerated; values derived
# from the domain are rewritten so changing the domain works.

set -euo pipefail

readonly REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/.env"
GENERATED="$REPO/deploy/generated"

DOMAIN=""
ACME_EMAIL=""
APP_PORT="28610"
ASSUME_YES="no"
FORCE_BEHIND="no"
DRY_RUN="no"

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

ask() { # ask "prompt" "default" -> echoes the answer
  local prompt="$1" default="${2:-}" answer=""
  if [[ "$ASSUME_YES" == "yes" || ! -t 0 ]]; then
    printf '%s\n' "$default"
    return
  fi
  if [[ -n "$default" ]]; then
    read -r -p "    $prompt [$default]: " answer </dev/tty || true
  else
    read -r -p "    $prompt: " answer </dev/tty || true
  fi
  printf '%s\n' "${answer:-$default}"
}

confirm() { # confirm "question" -> 0 for yes
  [[ "$ASSUME_YES" == "yes" ]] && return 0
  [[ ! -t 0 ]] && return 0
  local answer
  read -r -p "    $1 [y/N]: " answer </dev/tty || true
  [[ "$answer" =~ ^[Yy] ]]
}

usage() {
  cat <<USAGE
robo-journey installer

  --domain <host>     the name people will use, e.g. sim.example.com
  --email <address>   for certificate expiry warnings (optional but wise)
  --app-port <port>   where the app listens on loopback (default 28610)
  --behind-proxy      skip the port check and always configure for an existing proxy
  --dry-run           work everything out and write nothing; shows what would happen
  --yes               take every default; no questions (for scripts)
  --help

USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --app-port) APP_PORT="${2:-}"; shift 2 ;;
    --behind-proxy) FORCE_BEHIND="yes"; shift ;;
    --dry-run) DRY_RUN="yes"; shift ;;
    --yes|-y) ASSUME_YES="yes"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# --- Looking before touching --------------------------------------------------------------------

# What is listening on a TCP port, as "name (pid)", or nothing.
#
# Two tools because neither is everywhere: ss on modern Linux, lsof on macOS and older boxes. The
# process name needs root on both; without it the port still reports as busy, which is the part
# that matters.
listener_on() {
  local port="$1" out=""
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -H -ltnp "sport = :$port" 2>/dev/null | head -n1 || true)"
    [[ -z "$out" ]] && return 0
    local who
    who="$(printf '%s' "$out" | grep -o 'users:((\"[^\"]*\",pid=[0-9]*' | head -n1 |
           sed 's/users:((\"//; s/\",pid=/ (/')"
    [[ -n "$who" ]] && printf '%s)\n' "$who" || printf 'something\n'
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" ("$2")"}')"
    [[ -n "$out" ]] && printf '%s\n' "$out"
    return 0
  fi
  # Neither tool. Report free rather than guessing busy: refusing to install because we cannot see
  # is worse than trying and having the bind fail loudly.
  return 0
}

port_busy() { [[ -n "$(listener_on "$1")" ]]; }

# First A record for a name, or nothing.
#
# Three tools because no single one is on every box: getent is Linux, dig and host are wherever
# someone installed them, and macOS has neither getent nor dig by default. Returning nothing is a
# legitimate answer -- it means "could not check", and the caller treats that as "carry on".
resolve_a() {
  local name="$1" out=""
  if command -v getent >/dev/null 2>&1; then
    out="$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    [[ -n "$out" ]] && { printf "%s\n" "$out"; return 0; }
  fi
  if command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=3 A "$name" 2>/dev/null | grep -Eo '^[0-9.]+$' | head -n1 || true)"
    [[ -n "$out" ]] && { printf "%s\n" "$out"; return 0; }
  fi
  if command -v host >/dev/null 2>&1; then
    out="$(host -t A "$name" 2>/dev/null | awk '/has address/ {print $NF; exit}' || true)"
    [[ -n "$out" ]] && { printf '%s\n' "$out"; return 0; }
  fi
  # Nothing found is a legitimate answer, not a failure. Falling out of here non-zero would take
  # the whole script down under `set -e` -- and a name that does not resolve yet is the ordinary
  # case on a first deploy, which is exactly when this script is most needed.
  return 0
}

# --- Preflight ----------------------------------------------------------------------------------

step "Checking this machine"

command -v docker >/dev/null 2>&1 || die \
  "docker is not installed. See https://docs.docker.com/engine/install/ and run this again."

if ! docker compose version >/dev/null 2>&1; then
  die "the docker compose plugin is missing. Install docker-compose-plugin and run this again."
fi

if ! docker info >/dev/null 2>&1; then
  die "cannot talk to the docker daemon. Start it, or run this with sudo."
fi
good "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present)"

[[ -f "$REPO/docker-compose.yml" ]] || die "run this from a robo-journey checkout."

# --- Which shape ---------------------------------------------------------------------------------

step "Looking at what is already running"

HTTP_OWNER="$(listener_on 80)"
HTTPS_OWNER="$(listener_on 443)"
MODE="edge"

if [[ "$FORCE_BEHIND" == "yes" ]]; then
  MODE="behind"
  info "--behind-proxy given; leaving ports 80 and 443 alone."
elif [[ -n "$HTTP_OWNER" || -n "$HTTPS_OWNER" ]]; then
  MODE="behind"
  if [[ -n "$HTTP_OWNER"  ]]; then warn "port 80 is held by $HTTP_OWNER"; fi
  if [[ -n "$HTTPS_OWNER" ]]; then warn "port 443 is held by $HTTPS_OWNER"; fi
  info ""
  info "Not touching them. Caddy will not be started, and nothing already serving on this"
  info "machine will be interrupted. The app will listen on loopback and this script will write"
  info "a site file for the proxy that is already there."
else
  good "ports 80 and 443 are free"
  info "Caddy will take them and handle certificates."
fi

# The app's own port. Loopback either way, but it still has to be free.
if port_busy "$APP_PORT"; then
  warn "port $APP_PORT is held by $(listener_on "$APP_PORT")"
  APP_PORT="$(ask "Use a different port for the app" "28710")"
  port_busy "$APP_PORT" && die "port $APP_PORT is busy too. Pick one that is free with --app-port."
fi
good "app port $APP_PORT is free"

for p in 28632 28633; do
  if port_busy "$p"; then
    warn "port $p (used by the database or cache on loopback) is held by $(listener_on "$p")"
    warn "compose will fail to bind it. Free it, or edit docker-compose.yml."
  fi
done

# --- What to call it ------------------------------------------------------------------------------

step "Domain"

if [[ -z "$DOMAIN" ]]; then
  DOMAIN="$(ask "Domain people will use (blank for localhost only)" "")"
fi

SCHEME="https"
if [[ -z "$DOMAIN" ]]; then
  DOMAIN="localhost"
  SCHEME="http"
  MODE="behind"
  warn "No domain given. Running on loopback only, without a certificate."
  PUBLIC_URL="http://localhost:$APP_PORT"
else
  PUBLIC_URL="https://$DOMAIN"
  good "$PUBLIC_URL"

  # A certificate cannot be issued for a name that does not point here. Checked rather than
  # discovered from a failed ACME challenge twenty minutes later.
  if [[ "$MODE" == "edge" ]]; then
    RESOLVED="$(resolve_a "$DOMAIN" || true)"
    PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
      warn "$DOMAIN resolves to $RESOLVED but this machine looks like $PUBLIC_IP."
      warn "The certificate will not be issued until DNS points here."
      confirm "Carry on anyway?" || die "Point the DNS record at this machine and run this again."
    elif [[ -n "$RESOLVED" ]]; then
      good "$DOMAIN resolves to $RESOLVED"
    fi
  fi
fi

if [[ "$MODE" == "edge" && -z "$ACME_EMAIL" ]]; then
  ACME_EMAIL="$(ask "Email for certificate expiry warnings (optional)" "")"
fi

# --- Configuration ---------------------------------------------------------------------------------

if [[ "$DRY_RUN" == "yes" ]]; then
  # Everything is worked out for real and written somewhere harmless, so the output can be read
  # before any of it lands on the machine.
  local_env="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then cp "$ENV_FILE" "$local_env"; fi
  ENV_FILE="$local_env"
  GENERATED="$(mktemp -d)"
  step "Dry run"
  info "Nothing on this machine will be changed."
  note "a copy of .env is being edited at $ENV_FILE"
  note "site files would go to $GENERATED"
fi

step "Configuration"

# Add a setting only if it is not already there. Used for anything the operator may have chosen or
# that must not change between runs -- passwords above all.
keep_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    note "$key — keeping what is already set"
    return
  fi
  printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
}

# Rewrite a setting. Used for values derived from the answers given this run, so that changing the
# domain actually changes the domain.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # A temporary file rather than sed -i, which is not portable between GNU and BSD.
    local tmp; tmp="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" >"$tmp" || true
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

if [[ -f "$ENV_FILE" ]]; then
  good ".env exists — secrets in it will be kept"
else
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  good "created .env"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

# Generated once and never again: regenerating this on a second run would leave the app unable to
# open the database it created on the first.
keep_env POSTGRES_PASSWORD "$(openssl rand -base64 33 | tr -d '\n/+=' | head -c 40)"
keep_env POSTGRES_USER robo
keep_env POSTGRES_DB robo_journey
keep_env RJ_SIGNUP_CREDITS 100
keep_env RJ_ACCESS_CAPACITY 10
keep_env GEMINI_API_KEY ""
keep_env SMTP_HOST ""
keep_env SMTP_PORT 587
keep_env SMTP_USER ""
keep_env SMTP_PASSWORD ""
keep_env SMTP_FROM "robo-journey <no-reply@$DOMAIN>"

set_env RJ_PUBLIC_URL "$PUBLIC_URL"
set_env RJ_PUBLISH_PORT "$APP_PORT"
set_env RJ_DOMAIN "$DOMAIN"
set_env RJ_ACME_EMAIL "$ACME_EMAIL"
# Anything in front is a proxy, so the app must read the forwarded headers rather than believe the
# connection it can see. Without this every session cookie is issued for the proxy's address.
set_env RJ_TRUST_PROXY "$([[ "$SCHEME" == "https" ]] && echo true || echo false)"
good "wrote settings to .env"

if ! grep -qE '^GEMINI_API_KEY=.+' "$ENV_FILE"; then
  note "GEMINI_API_KEY is empty — the assistant will report itself as unconfigured until it is set."
fi
if ! grep -qE '^SMTP_HOST=.+' "$ENV_FILE"; then
  note "SMTP_HOST is empty — confirmation mail will be logged instead of sent."
fi

# --- Bring it up -------------------------------------------------------------------------------------

step "Building and starting"

PROFILES=(--profile packaged)
if [[ "$MODE" == "edge" ]]; then PROFILES+=(--profile edge); fi

info "docker compose ${PROFILES[*]} up -d --build"
if [[ "$DRY_RUN" == "yes" ]]; then
  note "(dry run — not started)"
else
  ( cd "$REPO" && docker compose "${PROFILES[@]}" up -d --build )
fi

step "Waiting for it to come up"

READY=""
if [[ "$DRY_RUN" == "yes" ]]; then
  note "(dry run — nothing to wait for)"
  READY="yes"
fi
[[ "$DRY_RUN" == "yes" ]] || for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/ready" >/dev/null 2>&1; then
    READY="yes"; break
  fi
  sleep 2
done

if [[ -z "$READY" ]]; then
  warn "the app did not report ready within two minutes."
  warn "docker compose logs service   # will say why"
else
  if [[ "$DRY_RUN" != "yes" ]]; then good "the app is ready on 127.0.0.1:$APP_PORT"; fi
fi

# --- A site file for whatever is already out front -------------------------------------------------

if [[ "$MODE" == "behind" && "$DOMAIN" != "localhost" ]]; then
  mkdir -p "$GENERATED"
  NGINX_FILE="$GENERATED/nginx-$DOMAIN.conf"
  CADDY_FILE="$GENERATED/Caddyfile-$DOMAIN"

  cat >"$NGINX_FILE" <<NGINX
# robo-journey behind an existing nginx.
#
# This machine's ports 80 and 443 were already in use when the installer ran, so nothing was taken
# from you. Enable this the way you enable your other sites:
#
#   sudo cp $NGINX_FILE /etc/nginx/sites-available/$DOMAIN
#   sudo ln -s /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
#   sudo nginx -t && sudo systemctl reload nginx
#   sudo certbot --nginx -d $DOMAIN
#
# The certificate is certbot's job here rather than Caddy's, since Caddy is not running.

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;

        # The app builds the links it puts in email from these, and reads the client address from
        # them. RJ_TRUST_PROXY is already true in .env, which is what makes it believe them.
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;

        # A compile is short but not instant, and the scope holds a connection open.
        proxy_read_timeout  120s;
        proxy_send_timeout  120s;

        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

  cat >"$CADDY_FILE" <<CADDYSITE
# robo-journey behind a Caddy that is already running on this machine.
#
# Append this to your Caddyfile (usually /etc/caddy/Caddyfile) and reload:
#
#   sudo systemctl reload caddy
#
# The certificate is handled by the Caddy you already have. A second one was not started.

$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$APP_PORT {
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-Host {host}
	}
}
CADDYSITE

  step "Your proxy, not ours"
  info "Nothing on this machine was reconfigured. Two site files are ready:"
  info ""
  info "  nginx  $NGINX_FILE"
  info "  caddy  $CADDY_FILE"
  info ""
  info "Open the one that matches what you are running; the commands are in the header."
fi

# --- Where we got to -----------------------------------------------------------------------------

step "Done"

if [[ "$MODE" == "edge" ]]; then
  info "Caddy is on 80 and 443 and will get a certificate for $DOMAIN on the first request."
  info "Open $PUBLIC_URL — the first load may take a few seconds while the certificate is issued."
elif [[ "$DOMAIN" == "localhost" ]]; then
  info "Running on http://127.0.0.1:$APP_PORT with no certificate and no domain."
  info "Re-run with --domain when you have one."
else
  info "The app is on 127.0.0.1:$APP_PORT, waiting behind your proxy."
  info "Enable one of the site files above, then open $PUBLIC_URL."
fi

info ""
info "  docker compose ${PROFILES[*]} ps       # what is running"
info "  docker compose logs -f service         # what it is doing"
info "  docker compose ${PROFILES[*]} down     # stop it"
printf '\n'
