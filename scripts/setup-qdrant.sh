#!/bin/bash
exec "$(dirname "$0")/migrate-qdrant.sh" setup "$@"
