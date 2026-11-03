#!/bin/bash
# Recreate local test DB "rn" and apply stub + all migrations.
set -e
H=/var/lib/postgresql/rn; P="psql -h $H -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
cd "$(dirname "$0")"
$P -c 'drop database if exists rn' -c 'create database rn' 2>/dev/null
$P -d rn -f supabase_stub.sql
for f in ../../supabase/migrations/*.sql; do $P -d rn -f "$f"; done
echo "reset ok"
