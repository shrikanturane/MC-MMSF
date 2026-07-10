#!/usr/bin/env bash
# Grant MCMF's AWS connection IAM user the permissions needed to provision networks.
# Run in AWS CloudShell (or anywhere `aws` is logged in as an admin).
#   bash grant-mcmf-aws.sh
set -euo pipefail

# ── EDIT THESE ─────────────────────────────────────────────────────────────
USER_NAME="mcmf"                 # the IAM user attached to the MCMF AWS connection
POLICY_NAME="MCMF-Provisioning"
# ───────────────────────────────────────────────────────────────────────────

cat > /tmp/mcmf-prov.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "MCMFNetworkProvisioning",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateVpc", "ec2:DeleteVpc",
        "ec2:CreateSubnet", "ec2:DeleteSubnet",
        "ec2:CreateTags", "ec2:DeleteTags",
        "ec2:RunInstances", "ec2:TerminateInstances",
        "ec2:CreateVolume", "ec2:DeleteVolume", "ec2:AttachVolume",
        "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeImages", "ec2:DescribeInstances", "ec2:DescribeRegions"
      ],
      "Resource": "*"
    }
  ]
}
JSON

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "Account: ${ACCOUNT_ID}  User: ${USER_NAME}"
# Create the managed policy, or push a new default version if it already exists.
if aws iam create-policy --policy-name "$POLICY_NAME" --policy-document file:///tmp/mcmf-prov.json >/dev/null 2>&1; then
  echo "Created policy ${ARN}"
else
  aws iam create-policy-version --policy-arn "$ARN" --policy-document file:///tmp/mcmf-prov.json --set-as-default >/dev/null
  echo "Updated policy ${ARN}"
fi

aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$ARN"
echo "✓ Attached ${ARN} to user ${USER_NAME}"
echo "Now: MCMF → Topology → + Provision Resource → AWS → Network → Request, then approve."
echo
echo "NOTE: if ${USER_NAME} has a permissions boundary, the boundary must ALSO allow these ec2:* actions."

# Network + VM + disk are all covered above. Add "iam:PassRole" ONLY if you launch
# instances with an instance profile (MCMF does not by default).
