#!/usr/bin/env bash
# Capture the real UI with the isolated browser fixture, never a running user instance.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
command -v ffmpeg >/dev/null || { echo '需要 ffmpeg。Ubuntu / Debian：sudo apt-get install ffmpeg'; exit 1; }
RELAY_RECORD_MEDIA=1 node_modules/.bin/playwright test tests/e2e/readme-media.spec.ts
for device in desktop mobile; do
  ffmpeg -hide_banner -loglevel error -y -framerate 1/2 \
    -i ".runtime/readme-media/$device/%02d.png" \
    -filter_complex '[0:v]split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3' \
    -loop 0 "docs/images/$device.gif"
done
echo 'Updated docs/images desktop/mobile screenshots and GIFs.'
