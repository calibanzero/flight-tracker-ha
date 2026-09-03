#!/bin/sh
set -eu

DB_URL="https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz"
PLANES_URL="https://raw.githubusercontent.com/jpatokal/openflights/master/data/planes.dat"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DB_FILE="$SCRIPT_DIR/aircraftDatabase.csv"
PLANES_FILE="$SCRIPT_DIR/planes.dat"

warn() {
  echo "WARNING: $*" >&2
}

refresh_aircraft_db() {
  tmp_gz="$(mktemp)"
  tmp_csv="$(mktemp)"

  if curl -4 -fL --retry 3 --connect-timeout 20 --max-time 240 "$DB_URL" -o "$tmp_gz" \
    && gzip -dc "$tmp_gz" > "$tmp_csv"; then
    first_line="$(grep -m1 -v '^#' "$tmp_csv" || true)"
    row_count="$(grep -c ';' "$tmp_csv" || true)"

    if [ "${first_line#*;}" != "$first_line" ] && [ "$row_count" -ge 10000 ]; then
      mv "$tmp_csv" "$DB_FILE"
      rm -f "$tmp_gz"
      echo "Updated aircraftDatabase.csv: $row_count rows"
      return 0
    fi

    warn "Downloaded aircraft database failed validation."
  else
    warn "Could not download the latest aircraft database."
  fi

  rm -f "$tmp_gz" "$tmp_csv"

  if [ -s "$DB_FILE" ]; then
    warn "Keeping the existing aircraftDatabase.csv."
    return 0
  fi

  warn "No usable aircraftDatabase.csv is available."
  return 1
}

refresh_planes() {
  tmp_planes="$(mktemp)"

  if curl -4 -fL --retry 3 --connect-timeout 20 --max-time 60 "$PLANES_URL" -o "$tmp_planes"; then
    row_count="$(wc -l < "$tmp_planes" | tr -d ' ')"

    if [ "$row_count" -ge 100 ] && grep -q '"Boeing 737-800","738","B738"' "$tmp_planes"; then
      mv "$tmp_planes" "$PLANES_FILE"
      echo "Updated planes.dat: $row_count rows"
      return 0
    fi

    warn "Downloaded planes.dat failed validation."
  else
    warn "Could not download the latest planes.dat."
  fi

  rm -f "$tmp_planes"

  if [ -s "$PLANES_FILE" ]; then
    warn "Keeping the existing planes.dat."
    return 0
  fi

  warn "No usable planes.dat is available."
  return 1
}

refresh_aircraft_db
refresh_planes
