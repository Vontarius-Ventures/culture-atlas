#!/bin/sh
# Copies the resolved Meta Wearables Device Access Toolkit license/notice files
# into the Experimental app bundle (THIRD_PARTY_NOTICES.md). Runs as an Xcode
# post-build script for CultureAtlasExperimental only. Fails the build when the
# SDK checkout has no license file, so a build can never ship without it.
set -eu

checkouts="${BUILD_DIR%/Build/*}/SourcePackages/checkouts/meta-wearables-dat-ios"
destination="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/ThirdPartyNotices"

if [ ! -d "$checkouts" ]; then
  echo "error: Meta SDK checkout not found at $checkouts" >&2
  exit 1
fi

mkdir -p "$destination"
copied=0
for name in LICENSE LICENSE.md LICENSE.txt NOTICE NOTICE.md; do
  if [ -f "$checkouts/$name" ]; then
    cp "$checkouts/$name" "$destination/meta-wearables-dat-ios-$name"
    copied=1
  fi
done

if [ "$copied" -ne 1 ]; then
  echo "error: no license file in $checkouts; review the SDK terms before shipping" >&2
  exit 1
fi
