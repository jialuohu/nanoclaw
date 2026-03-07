#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STORAGE_DIR="$PROJECT_DIR/qdrant_storage"
QDRANT_URL="http://localhost:6333"

# ── helpers ──────────────────────────────────────────────────────────────────

wait_for_healthy() {
  local max_wait=60
  local elapsed=0
  echo "Waiting for Qdrant to be healthy..."
  while [ $elapsed -lt $max_wait ]; do
    if curl -sf "$QDRANT_URL/healthz" > /dev/null 2>&1; then
      echo "Qdrant is healthy."
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "ERROR: Qdrant did not become healthy within ${max_wait}s"
  return 1
}

create_systemd_service() {
  mkdir -p "$STORAGE_DIR"
  mkdir -p ~/.config/systemd/user

  cat > ~/.config/systemd/user/qdrant.service << EOF
[Unit]
Description=Qdrant Vector Database
After=docker.service

[Service]
Type=simple
ExecStartPre=-docker rm -f qdrant
ExecStart=docker run --rm --name qdrant \
  -p 6333:6333 \
  -v ${STORAGE_DIR}:/qdrant/storage \
  qdrant/qdrant
ExecStop=docker stop qdrant
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable qdrant
  systemctl --user start qdrant
  echo "Qdrant systemd service started."
}

# ── subcommands ──────────────────────────────────────────────────────────────

cmd_setup() {
  local skip_backfill="${1:-}"

  create_systemd_service
  wait_for_healthy

  if [ "$skip_backfill" != "--skip-backfill" ]; then
    echo "Running embedding backfill..."
    cd "$PROJECT_DIR"
    npx tsx scripts/backfill-embeddings.ts
    echo "Backfill complete."
  fi

  echo "Qdrant setup complete."
}

cmd_export() {
  local output="${1:-qdrant-backup-$(date +%Y-%m-%d).tar.gz}"

  if [ ! -d "$STORAGE_DIR" ]; then
    echo "ERROR: Storage directory not found: $STORAGE_DIR"
    exit 1
  fi

  echo "Exporting Qdrant data..."
  tar czf "$output" -C "$PROJECT_DIR" qdrant_storage/

  local size
  size=$(du -h "$output" | cut -f1)
  echo "Export complete: $output ($size)"
}

cmd_import() {
  local backup="$1"

  if [ -z "$backup" ]; then
    echo "Usage: $0 import <backup.tar.gz>"
    exit 1
  fi

  if [ ! -f "$backup" ]; then
    echo "ERROR: Backup file not found: $backup"
    exit 1
  fi

  # Stop Qdrant if running
  echo "Stopping Qdrant..."
  systemctl --user stop qdrant 2>/dev/null || true
  sleep 1

  # Extract backup
  echo "Extracting backup..."
  tar xzf "$backup" -C "$PROJECT_DIR"

  # Start Qdrant (skip backfill since we're importing data)
  cmd_setup --skip-backfill

  # Verify collection exists
  echo "Verifying collection..."
  if curl -sf "$QDRANT_URL/collections/messages" > /dev/null 2>&1; then
    echo "Import complete: collection 'messages' verified."
  else
    echo "WARNING: Collection 'messages' not found after import."
    exit 1
  fi
}

cmd_status() {
  echo "=== Qdrant Status ==="

  # systemd service
  echo ""
  echo "Service:"
  systemctl --user is-active qdrant 2>/dev/null || echo "  not running"

  # health check
  echo ""
  echo "Health:"
  if curl -sf "$QDRANT_URL/healthz" > /dev/null 2>&1; then
    echo "  healthy"
  else
    echo "  unreachable"
    return
  fi

  # collection stats
  echo ""
  echo "Collection (messages):"
  local response
  response=$(curl -sf "$QDRANT_URL/collections/messages" 2>/dev/null) || {
    echo "  not found"
    return
  }
  local points
  points=$(echo "$response" | grep -o '"points_count":[0-9]*' | head -1 | cut -d: -f2)
  echo "  points: ${points:-unknown}"
}

# ── main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  setup)
    shift
    cmd_setup "$@"
    ;;
  export)
    shift
    cmd_export "$@"
    ;;
  import)
    shift
    cmd_import "$@"
    ;;
  status)
    cmd_status
    ;;
  *)
    echo "Usage: $0 {setup|export|import|status}"
    echo ""
    echo "  setup   - Install Qdrant systemd service and run backfill"
    echo "  export  - Export qdrant_storage/ to a tar.gz backup"
    echo "  import  - Import a backup and start Qdrant"
    echo "  status  - Show Qdrant service and collection status"
    exit 1
    ;;
esac
