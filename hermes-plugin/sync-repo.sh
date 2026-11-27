#!/bin/sh
# Copy this file and sync-repo.ts together into HERMESQ_SCRIPTS_DIR.
exec node "$(dirname "$0")/sync-repo.ts"
