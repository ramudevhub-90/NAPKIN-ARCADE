#!/usr/bin/env bash
# Deploy Napkin Arcade to one small EC2 instance (see deploy/stack.yml).
# Usage:  AWS_PROFILE=default deploy/deploy.sh
#   Optional: SES_ROLE_ARN=arn:aws:iam::<acct>:role/napkin-arcade-ses-sender  (send mail via another account's SES)
# Re-running is safe: it updates the stack, ships the current code and restarts the app.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-us-east-1}
STACK=${STACK:-napkin-arcade}
DOMAIN=${DOMAIN:-napkinarcade.revenuerush.in}
PARENT=${PARENT_DOMAIN:-revenuerush.in}
aws() { command aws --region "$REGION" "$@"; }

echo "▶ Infrastructure (CloudFormation stack $STACK)…"
aws cloudformation deploy --stack-name "$STACK" --template-file deploy/stack.yml \
  --capabilities CAPABILITY_IAM --parameter-overrides DomainName="$DOMAIN" --no-fail-on-empty-changeset
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out Bucket); IID=$(out InstanceId); IP=$(out PublicIp); NS=$(out NameServers); ZONE=$(out ZoneId)

echo "▶ App settings → SSM Parameter Store (encrypted; never in git)…"
ENV_BODY=$({ grep -E '^(NEBIUS_API_KEY|NEBIUS_BASE_URL|MODEL_[A-Z]+|HARD_CAP_USD|CAMPAIGN_CAP_USD|LIVE_RUNS_PER_HOUR|DAILY_BUILDS_PER_USER|DEMO_LOGIN_EMAIL|DEMO_LOGIN_CODE|DEMO_DAILY_BUILDS)=' .env || true
  echo "MAIL_PROVIDER=ses"; echo "AWS_REGION=$REGION"
  if [ -n "${SES_ROLE_ARN:-}" ]; then echo "SES_ROLE_ARN=$SES_ROLE_ARN"; echo "MAIL_FROM=Napkin Arcade <${MAIL_FROM_ADDRESS:-no-reply@revenuerush.in}>"; echo "SES_REGION=${SES_REGION:-$REGION}";
  else echo "MAIL_FROM=Napkin Arcade <no-reply@$DOMAIN>"; fi; })
aws ssm put-parameter --name /napkin-arcade/env --type SecureString --overwrite --value "$ENV_BODY" >/dev/null

echo "▶ Bundling and uploading the app…"
VER=$(date +%Y%m%d%H%M%S)
TMP=$(mktemp -d)
COPYFILE_DISABLE=1 tar --no-mac-metadata --exclude ./node_modules --exclude ./data --exclude ./.env --exclude ./deploy --exclude ./.git \
  --exclude ./video --exclude ./docs --exclude ./test -czf "$TMP/app.tgz" .
echo "  bundle: $(du -h "$TMP/app.tgz" | cut -f1)"
aws s3 cp "$TMP/app.tgz" "s3://$BUCKET/releases/$VER.tgz" --only-show-errors

echo "▶ Installing on $IID via Systems Manager…"
TMP="$TMP" node -e '
const [bucket, ver, region] = process.argv.slice(1);
const cmds = [
  "set -euo pipefail",
  "cloud-init status --wait >/dev/null || true",
  "rm -f /tmp/app.tgz /tmp/g.tgz",
  `aws s3 cp s3://${bucket}/releases/${ver}.tgz /var/tmp/app.tgz --region ${region} --only-show-errors`,
  "mkdir -p /opt/napkin-arcade/data",
  "find /opt/napkin-arcade -mindepth 1 -maxdepth 1 ! -name data ! -name node_modules -exec rm -rf {} +",
  "tar -xzf /var/tmp/app.tgz -C /opt/napkin-arcade && rm -f /var/tmp/app.tgz",
  "cd /opt/napkin-arcade && PATH=/opt/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund --loglevel=error",
  `aws ssm get-parameter --name /napkin-arcade/env --with-decryption --region ${region} --query Parameter.Value --output text > /etc/napkin-arcade.env`,
  "chmod 600 /etc/napkin-arcade.env && chown -R napkin:napkin /opt/napkin-arcade",
  "systemctl daemon-reload && systemctl enable napkin-arcade >/dev/null 2>&1 && systemctl restart napkin-arcade",
  "for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8790/api/status && exit 0; sleep 1; done; journalctl -u napkin-arcade -n 40 --no-pager; exit 1",
];
require("fs").writeFileSync(process.env.TMP + "/params.json", JSON.stringify({ commands: cmds }));
' "$BUCKET" "$VER" "$REGION"
# The instance may still be registering with SSM right after creation.
for i in $(seq 1 30); do
  [ "$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$IID" --query 'length(InstanceInformationList)' --output text)" = "1" ] && break
  sleep 10
done
CMD=$(aws ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript --timeout-seconds 900 \
  --parameters "file://$TMP/params.json" --comment "napkin-arcade $VER" --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$IID" 2>/dev/null || true
for i in $(seq 1 90); do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -15
[ "$STATUS" = "Success" ] || { echo "✖ Install on the instance failed (status: $STATUS)"; exit 1; }

echo "▶ DNS…"
PARENT_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$PARENT" --query "HostedZones[?Name=='$PARENT.'].Id" --output text | head -1)
if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "None" ]; then
  RECS=$(node -e 'console.log(JSON.stringify(process.argv[1].split(",").map((v) => ({ Value: v }))))' "$NS")
  aws route53 change-resource-record-sets --hosted-zone-id "$PARENT_ID" --change-batch \
    "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"NS\",\"TTL\":300,\"ResourceRecords\":$RECS}}]}" >/dev/null
  echo "  Delegated $DOMAIN from $PARENT in this account."
else
  echo "  $PARENT is not in this account. Add this NS record in the account that hosts $PARENT:"
  echo "    Name: $DOMAIN   Type: NS   TTL: 300"
  echo "$NS" | tr ',' '\n' | sed 's/^/    /'
fi
rm -rf "$TMP"
echo "✔ Done: https://$DOMAIN  (IP $IP, zone $ZONE)"
