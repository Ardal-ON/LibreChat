#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STORE_DIR="${ROOT_DIR}/graphrag_data"
STORE_FILE="${STORE_DIR}/store.json"

mkdir -p "${STORE_DIR}"

if [ -f "${STORE_FILE}" ]; then
  TS="$(date +%Y%m%d_%H%M%S)"
  cp "${STORE_FILE}" "${STORE_FILE}.bak.${TS}"
  echo "Backup created: ${STORE_FILE}.bak.${TS}"
fi

cat > "${STORE_FILE}" <<'JSON'
{
  "files": {}
}
JSON

echo "GraphRAG store initialized: ${STORE_FILE}"
