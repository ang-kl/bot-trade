#!/bin/sh
# cpp-exec/entrypoint-signal-test.sh — GW-1 (V3-SEQUENCE item 38): the
# entrypoint delivers SIGTERM to the process and does NOT SIGKILL it.
#
# runuser, the old privilege drop, forwarded SIGTERM and SIGKILLed its child
# 2 s later (measured), so a seal slower than 2 s was cut off. This runs the
# real entrypoint.sh with a stub in place of cpp-exec: the stub takes 3 s to
# "seal" after SIGTERM, then writes a marker and exits 143. Under runuser the
# marker never appears; under `exec setpriv` the stub is the process that
# received the signal and finishes. Must run as root (setpriv changes ids).
# CI: .github/workflows/cpp-exec.yml.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
chmod 777 "$work"
user=${TEST_USER:-nobody}
stub="$work/stub.sh"
cat > "$stub" <<EOF
#!/bin/sh
trap 'sleep 3; echo sealed > "$work/sealed"; exit 143' TERM
echo \$\$ > "$work/ready"
while :; do sleep 0.1; done
EOF
chmod 755 "$stub"

CPP_EXEC_BIN="$stub" CPP_EXEC_USER="$user" sh "$here/entrypoint.sh" &
pid=$!
i=0
while [ ! -s "$work/ready" ]; do i=$((i + 1)); [ "$i" -lt 100 ] || { echo "FAIL: the stub never started"; kill -9 "$pid" 2>/dev/null; exit 1; }; sleep 0.1; done
# exec, not a child: the process the entrypoint started IS the stub
if [ "$(cat "$work/ready")" != "$pid" ]; then echo "FAIL: the stub is pid $(cat "$work/ready"), not the entrypoint's $pid — something stayed in between"; kill -9 "$pid" 2>/dev/null; exit 1; fi
owner=$(stat -c %U "/proc/$pid")
[ "$owner" = "$user" ] || { echo "FAIL: the stub runs as $owner, not $user"; kill -9 "$pid"; exit 1; }
kill -TERM "$pid"
set +e
wait "$pid"
rc=$?
set -e
[ "$rc" -eq 143 ] || { echo "FAIL: exit status $rc, expected 143 (a SIGKILL reads 137)"; exit 1; }
[ -s "$work/sealed" ] || { echo "FAIL: the stub was killed before its 3 s seal finished"; exit 1; }
rm -rf "$work"
echo "entrypoint: SIGTERM reached the process, the 3 s seal finished, exit 143 — ok"
