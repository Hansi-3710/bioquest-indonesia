#!/bin/sh
# Optional hardening: serve the map library from your own domain instead of unpkg.com.
# The app detects app/static/vendor/leaflet/ automatically and tightens its CSP accordingly.
set -e
D="$(dirname "$0")/../app/static/vendor/leaflet"
mkdir -p "$D/images"
B=https://unpkg.com/leaflet@1.9.4/dist
curl -fsSL "$B/leaflet.js" -o "$D/leaflet.js"
curl -fsSL "$B/leaflet.css" -o "$D/leaflet.css"
for f in layers.png layers-2x.png marker-icon.png marker-icon-2x.png marker-shadow.png; do
  curl -fsSL "$B/images/$f" -o "$D/images/$f"
done
echo "Leaflet vendored. Restart the app."
