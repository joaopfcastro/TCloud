#!/bin/bash
# logs.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Logs em tempo real do TCloud (Ctrl+C para sair):"
docker compose logs -f
