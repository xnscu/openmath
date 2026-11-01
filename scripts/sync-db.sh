#!/bin/bash
# Description: Syncs the remote D1 database to the local environment.

set -e

# Warning message
echo "⚠️  Note: Ensure your local dev server is not writing to the database during this process."



# 1. Export remote database
echo "⏳ Exporting remote database (openmath)..."
npx wrangler d1 export openmath --remote --output="/tmp/d1_export.sql"

# check if export was successful
if [ ! -f "/tmp/d1_export.sql" ]; then
    echo "❌ Export failed!"
    exit 1
fi

# 2. Reset local database
# Remove local SQLite files to ensure a clean slate.
# Based on project structure, local state is in .wrangler/state/v3/d1
echo "🗑️  Clearing local database..."
DB_DIR=".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
# Find the first sqlite file in the directory
DB_FILE=$(find "$DB_DIR" -name "*.sqlite" -print -quit)

if [ -z "$DB_FILE" ]; then
    echo "⚠️  No local database file found. Please run 'yarn dev' at least once to initialize it."
    exit 1
fi

echo "Found local database: $DB_FILE"
# Backup the filename before deleting
DB_NAME=$(basename "$DB_FILE")
DB_PATH="$DB_DIR/$DB_NAME"

# Delete existing DB and WAL/SHM files
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"

# 3. Import to local database using sqlite3
echo "📥 Importing data to local database using sqlite3..."
sqlite3 "$DB_PATH" < "/tmp/d1_export.sql"

# 4. Cleanup
echo "🧹 Cleaning up..."
rm "/tmp/d1_export.sql"

echo "✅ Database sync complete!"
