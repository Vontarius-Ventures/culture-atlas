#!/usr/bin/env bash
# Regenerates the v2 browser-test fixtures from the design package's generated
# reference images (specs/capture-platform-v2/design/mockups). Crops avoid the
# drawn checkbox/play overlays so the UI renders its own real controls on top.
# The video fixtures are short VP9/WebM and H.264/MP4 clips (Playwright's
# Chromium build plays WebM; MP4 is for upload tests only).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../../.." && pwd)"
m="$root/specs/capture-platform-v2/design/mockups"
crop() { ffmpeg -loglevel error -y -i "$m/$1" -vf "crop=$2:$3:$4:$5" -q:v 3 "$here/$6"; }

crop 01-library-desktop.png 330 200 64 362 quiet-corners.jpg
crop 01-library-desktop.png 330 200 414 362 slow-morning.jpg
crop 01-library-desktop.png 330 200 763 362 olive-layers.jpg
crop 01-library-desktop.png 330 150 1112 355 along-the-coast.jpg
crop 01-library-desktop.png 330 200 64 684 record-shop.jpg
crop 01-library-desktop.png 330 140 414 684 afternoon-walk.jpg
crop 01-library-desktop.png 330 200 763 684 made-by-hand.jpg
crop 01-library-desktop.png 330 200 1112 684 green-spaces.jpg
crop 07-video-detail-desktop.png 904 470 64 164 slower-afternoon.jpg
crop 07-video-detail-desktop.png 214 135 56 817 moment-1.jpg
crop 07-video-detail-desktop.png 214 135 292 817 moment-2.jpg
crop 07-video-detail-desktop.png 214 135 528 817 moment-3.jpg
crop 07-video-detail-desktop.png 214 135 763 817 moment-4.jpg
crop 02-source-mobile.png 746 584 54 582 pottery-table.jpg
crop 05-glasses-ready-mobile.png 762 592 46 515 living-room.jpg
crop 04-glasses-connect-mobile.png 762 530 46 467 glasses.jpg
crop 03-camera-mobile.png 770 740 42 310 cafe-terrace.jpg

# 42-second still clip of the video-detail frame (no audio track).
ffmpeg -loglevel error -y -loop 1 -i "$here/slower-afternoon.jpg" -t 42 -r 4 \
  -vf "scale=960:-2,format=yuv420p" -c:v libvpx-vp9 -b:v 120k -an "$here/slower-afternoon.webm"
ffmpeg -loglevel error -y -loop 1 -i "$here/along-the-coast.jpg" -t 3 -r 24 \
  -vf "scale=640:-2,format=yuv420p" -c:v libx264 -pix_fmt yuv420p -an "$here/coast.mp4"
