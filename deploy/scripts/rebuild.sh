#!/bin/bash
# rebuild.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Rebuildando a imagem do TCloud e recriando os containers..."
docker compose down
docker compose build --no-cache
docker compose up -d
echo "Rebuild concluido."
