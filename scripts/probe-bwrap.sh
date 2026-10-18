#!/usr/bin/env bash
set -u

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
WORKSPACE=${1:-"$ROOT_DIR"}
BWRAP=${BWRAP:-$(command -v bwrap || true)}

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS  %s\n' "$*"
}

if [[ -z "$BWRAP" || ! -x "$BWRAP" ]]; then
  fail "bubblewrap was not found; install it or set BWRAP=/path/to/bwrap"
fi

if [[ ! -d "$WORKSPACE" ]]; then
  fail "workspace is not a directory: $WORKSPACE"
fi
WORKSPACE=$(cd -- "$WORKSPACE" && pwd -P)

printf 'Probe workspace: %s\n' "$WORKSPACE"
printf 'Bubblewrap:      %s\n' "$("$BWRAP" --version)"

if [[ ! -r /usr/bin/bash ]]; then
  fail "/usr/bin/bash is required as the sandbox command runtime"
fi
if [[ ! -d /usr || ! -d /lib || ! -d /lib64 ]]; then
  fail "expected runtime roots /usr, /lib, and /lib64"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/brawl-bwrap-probe.XXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT

cat >"$tmp_dir/probe-inside.sh" <<'INNER'
#!/usr/bin/env bash
set -u

passed=0
failed=0

ok() {
  printf 'PASS  %s\n' "$*"
  passed=$((passed + 1))
}

no() {
  printf 'FAIL  %s\n' "$*" >&2
  failed=$((failed + 1))
}

expect_absent() {
  local label=$1
  local path=$2
  if [[ -e "$path" ]]; then
    no "$label is visible at $path"
  else
    ok "$label is hidden"
  fi
}

marker=".brawl-bwrap-probe-$$"
if printf 'workspace-write-ok\n' >"$marker" &&
  [[ "$(cat -- "$marker")" == "workspace-write-ok" ]]; then
  ok "workspace is writable"
else
  no "workspace is not writable"
fi
rm -f -- "$marker"

expect_absent "host /home" /home
expect_absent "host /root" /root
expect_absent "host /etc" /etc
expect_absent "host /var" /var

if [[ -n ${BRAWL_PROBE_SECRET+x} ]]; then
  no "provider-like environment variable was inherited"
else
  ok "environment is cleared"
fi

if touch /usr/.brawl-probe-write 2>/dev/null; then
  no "runtime mount is writable"
  rm -f /usr/.brawl-probe-write
else
  ok "runtime mount is read-only"
fi

if timeout 3 /usr/bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/dev/null; then
  no "network connection to 1.1.1.1:80 succeeded"
else
  ok "network is unavailable"
fi

if timeout 3 /usr/bin/sudo -n true >/dev/null 2>&1; then
  no "sudo succeeded"
else
  ok "privilege escalation is unavailable"
fi

if [[ "$(id -u)" == "0" ]] && grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status 2>/dev/null; then
  ok "sandbox uid is isolated and no_new_privs is enabled"
else
  no "expected isolated uid 0 with no_new_privs"
fi

pid_one=$(cat /proc/1/comm 2>/dev/null || true)
if [[ "$$" -lt 100 && "$pid_one" != "systemd" && "$pid_one" != "init" ]]; then
  ok "PID namespace is isolated"
else
  no "PID namespace does not appear isolated"
fi

printf 'INSIDE_RESULT passed=%d failed=%d\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
INNER
chmod 0555 "$tmp_dir/probe-inside.sh"

printf '\nRunning full Bubblewrap probe...\n'
BRAWL_PROBE_SECRET="must-not-leak" "$BWRAP" \
  --unshare-all \
  --die-with-parent \
  --new-session \
  --clearenv \
  --setenv HOME /tmp \
  --setenv TMPDIR /tmp \
  --setenv PATH /usr/bin:/bin \
  --uid 0 \
  --gid 0 \
  --cap-drop ALL \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --bind "$WORKSPACE" /workspace \
  --tmpfs /tmp \
  --proc /proc \
  --dev /dev \
  --ro-bind "$tmp_dir/probe-inside.sh" /probe-inside.sh \
  --chdir /workspace \
  /usr/bin/bash /probe-inside.sh
result=$?

if [[ "$result" -ne 0 ]]; then
  printf '\nThe full Bubblewrap shape failed or an isolation assertion failed.\n' >&2
  printf 'This host must allow unprivileged user, mount, PID, and network namespaces.\n' >&2
  exit "$result"
fi

pass "full Bubblewrap sandbox shape is supported"
