#!/usr/bin/env bash
# Build the release images on YOUR machine (or CI), upload them with the host
# bundle to the stack's private bucket, and tell the instance to deploy.
# Nothing is built on the 1 GiB instance (a Next.js build does not fit).
#
#   AWS_REGION=us-east-1 STACK=culture-atlas-prod infra/aws/ship.sh
#
# Needs: docker with buildx, AWS CLI v2 with credentials that may write
# s3://<bucket>/deploy/* and call ssm:SendCommand on the instance.
# Transfer into AWS is free; the bundle expires from the bucket after 14 days.
set -euo pipefail

: "${AWS_REGION:?set AWS_REGION}"
STACK="${STACK:-culture-atlas-prod}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

output() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
bucket="$(output BucketName)"
instance="$(output InstanceId)"
[ -n "$bucket" ] && [ "$bucket" != None ] || { echo "stack $STACK has no BucketName output" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo 'Refusing to ship uncommitted changes; commit first so the release id names real code.' >&2
  exit 1
fi
release="$(git rev-parse --short=12 HEAD)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "building culture-atlas:$release (linux/amd64)"
docker buildx build --platform linux/amd64 --target runtime -t "culture-atlas:$release" --load .
docker buildx build --platform linux/amd64 --target ops -t "culture-atlas-ops:$release" --load .
docker save "culture-atlas:$release" "culture-atlas-ops:$release" | gzip -1 > "$work/image.tar.gz"

mkdir -p "$work/bundle"
cp -R infra/aws/bin infra/aws/systemd infra/aws/compose.yml infra/aws/Caddyfile "$work/bundle/"
chmod 0755 "$work"/bundle/bin/*
tar -czf "$work/bundle.tar.gz" -C "$work" bundle

echo "uploading release $release to s3://$bucket/deploy/$release/"
aws s3 cp --only-show-errors --region "$AWS_REGION" --sse AES256 "$work/image.tar.gz" "s3://$bucket/deploy/$release/image.tar.gz"
aws s3 cp --only-show-errors --region "$AWS_REGION" --sse AES256 "$work/bundle.tar.gz" "s3://$bucket/deploy/$release/bundle.tar.gz"
printf '%s\n' "$release" | aws s3 cp --only-show-errors --region "$AWS_REGION" --sse AES256 - "s3://$bucket/deploy/current.txt"

echo "deploying on $instance"
command_id="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$instance" \
  --document-name AWS-RunShellScript --comment "culture atlas $release" \
  --parameters "commands=[\"/usr/local/sbin/atlas-deploy $release\"]" \
  --timeout-seconds 1800 --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance" || true
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance" \
  --query '{status:Status,output:StandardOutputContent,errors:StandardErrorContent}' --output json
