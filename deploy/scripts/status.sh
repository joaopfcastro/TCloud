#!/bin/bash
# status.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Status dos containers do TCloud:"
docker compose ps
