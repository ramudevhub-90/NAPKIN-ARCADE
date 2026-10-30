#!/usr/bin/env bash
# Copy a game built on a local studio to the live server, so its /play/<id> link works there.
# Usage:  AWS_PROFILE=default deploy/publish-game.sh <project-id>
set -euo pipefail
cd "$(dirname "$0")/.."
ID=${1:?project id}; REGION=${AWS_REGION:-us-east-1}; STACK=${STACK:-napkin-arcade}
[ -f "data/projects/$ID/game3d.json" ] || { echo "data/projects/$ID has no finished game"; exit 1; }
aws() { command aws --region "$REGION" "$@"; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out Bucket); IID=$(out InstanceId)
TMP=$(mktemp -d)
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$TMP/game.tgz" -C data/projects --exclude drawing.txt "$ID"
aws s3 cp "$TMP/game.tgz" "s3://$BUCKET/games/$ID.tgz" --only-show-errors
CMD=$(aws ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters "commands=[\"aws s3 cp s3://$BUCKET/games/$ID.tgz /var/tmp/g.tgz --region $REGION --only-show-errors\",\"mkdir -p /opt/napkin-arcade/data/projects\",\"tar -xzf /var/tmp/g.tgz -C /opt/napkin-arcade/data/projects\",\"chown -R napkin:napkin /opt/napkin-arcade/data\"]" \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$IID"
rm -rf "$TMP"
echo "✔ Published: https://napkinarcade.revenuerush.in/play/$ID"
