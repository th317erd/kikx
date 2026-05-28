#!/usr/bin/env bash
#
# Quick-start script for running the Kikx Solr container standalone
# (without docker-compose). Same flags as docker-compose.yml.
#
# Usage: ./scripts/solr-start.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTAINER_NAME="kikx-solr"
SOLR_IMAGE="solr:9"
SOLR_PORT="8983"
DATA_DIR="$PROJECT_ROOT/data/solr"
CONFIGSET_DIR="$PROJECT_ROOT/solr/kikx"

# Create the data directory if it doesn't exist
mkdir -p "$DATA_DIR"

# Fix ownership for Solr container user (UID 8983).
# The Solr Docker image runs as uid 8983, and will refuse to start
# if it can't write to /var/solr.
docker run --rm --user root \
  -v "$DATA_DIR:/var/solr" \
  --entrypoint bash "$SOLR_IMAGE" \
  -c "chown -R 8983:8983 /var/solr" 2>/dev/null || true

# Stop and remove existing container if running
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping existing $CONTAINER_NAME container..."
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

echo "Starting $CONTAINER_NAME on port $SOLR_PORT..."

docker run -d \
  --name "$CONTAINER_NAME" \
  -p "${SOLR_PORT}:8983" \
  -v "$DATA_DIR:/var/solr" \
  -v "$CONFIGSET_DIR:/opt/solr/server/solr/configsets/kikx" \
  --restart unless-stopped \
  "$SOLR_IMAGE" \
  solr-precreate kikx /opt/solr/server/solr/configsets/kikx

echo ""
echo "Solr is starting at http://localhost:${SOLR_PORT}"
echo "Admin UI: http://localhost:${SOLR_PORT}/solr/"
echo "Core status: curl http://localhost:${SOLR_PORT}/solr/admin/cores?action=STATUS"
