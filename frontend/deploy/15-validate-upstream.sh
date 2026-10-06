#!/bin/sh
set -eu

# Values are interpolated into nginx syntax by the official image entrypoint.
# Accept only a DNS hostname and a decimal TCP port before that interpolation.
BACKEND_HOST=${BACKEND_HOST:-}
BACKEND_PORT=${BACKEND_PORT:-}
case "$BACKEND_HOST" in
    ''|*[!A-Za-z0-9.-]*) echo 'BACKEND_HOST contains invalid hostname characters.' >&2; exit 1 ;;
esac
if [ "${#BACKEND_HOST}" -gt 253 ] ||
   ! printf '%s\n' "$BACKEND_HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'; then
    echo 'BACKEND_HOST must be a DNS hostname without a scheme, path or port.' >&2
    exit 1
fi

case "$BACKEND_PORT" in
    ''|*[!0-9]*|0*) echo 'BACKEND_PORT must be a decimal port from 1 to 65535.' >&2; exit 1 ;;
esac
if [ "${#BACKEND_PORT}" -gt 5 ] || [ "$BACKEND_PORT" -gt 65535 ]; then
    echo 'BACKEND_PORT must be a decimal port from 1 to 65535.' >&2
    exit 1
fi
