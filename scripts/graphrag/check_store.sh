#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STORE_FILE="${ROOT_DIR}/graphrag_data/store.json"

if [ ! -f "${STORE_FILE}" ]; then
  echo "store.json not found: ${STORE_FILE}"
  exit 1
fi

echo "Store file: ${STORE_FILE}"
wc -c "${STORE_FILE}"
echo "Preview:"
head -n 60 "${STORE_FILE}"
