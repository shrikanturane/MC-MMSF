import type { ProvisionIdentity } from '../../connectors/adapter';

export interface GrantScript {
  shell: string;
  script: string;
  ready: boolean;
  missing: string[];
  loginUrl: string | null; // deep link that opens the cloud's logged-in Cloud Shell
  loginLabel: string;
  autoRun: boolean; // true = the deep link runs the grant on open (GCP); false = open shell, then paste
}

/**
 * Build a permission-grant script for a cloud, pre-populated from the connection's
 * stored (non-secret) identity. Returns both a copy-paste script and a login deep
 * link to that cloud's own Cloud Shell (so the grant runs under the user's identity —
 * MCMF never handles admin credentials).
 */
export function buildGrantScript(provider: string, id: ProvisionIdentity): GrantScript {
  if (provider === 'aws') {
    const user = id.principal || '<your-iam-user>';
    const missing = id.principal ? [] : ['IAM user name'];
    return {
      shell: 'AWS CloudShell',
      ready: missing.length === 0,
      missing,
      loginUrl: `https://console.aws.amazon.com/cloudshell/home${id.region ? `?region=${id.region}` : ''}`,
      loginLabel: 'Open AWS CloudShell',
      autoRun: false,
      script: `# MCMF — grant AWS network + VM + disk provisioning${id.account ? `  (account ${id.account})` : ''}
USER_NAME="${user}"
POLICY_NAME="MCMF-Provisioning"
cat > /tmp/mcmf-prov.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [{
  "Sid": "MCMFProvisioning", "Effect": "Allow",
  "Action": ["ec2:CreateVpc","ec2:DeleteVpc","ec2:CreateSubnet","ec2:DeleteSubnet",
             "ec2:CreateTags","ec2:DeleteTags",
             "ec2:RunInstances","ec2:TerminateInstances",
             "ec2:CreateVolume","ec2:DeleteVolume","ec2:AttachVolume",
             "ec2:CreateVpnGateway","ec2:AttachVpnGateway","ec2:DetachVpnGateway","ec2:DeleteVpnGateway",
             "ec2:CreateCustomerGateway","ec2:DeleteCustomerGateway",
             "ec2:CreateVpnConnection","ec2:DeleteVpnConnection","ec2:CreateVpnConnectionRoute","ec2:DeleteVpnConnectionRoute",
             "ec2:DescribeVpnGateways","ec2:DescribeVpnConnections","ec2:DescribeCustomerGateways",
             "ce:GetCostAndUsage",
             "ec2:DescribeVpcs","ec2:DescribeSubnets","ec2:DescribeImages","ec2:DescribeInstances","ec2:DescribeRegions"],
  "Resource": "*" }]}
JSON
ACCT=$(aws sts get-caller-identity --query Account --output text)
ARN="arn:aws:iam::\${ACCT}:policy/\${POLICY_NAME}"
aws iam create-policy --policy-name "\$POLICY_NAME" --policy-document file:///tmp/mcmf-prov.json \\
  || aws iam create-policy-version --policy-arn "\$ARN" --policy-document file:///tmp/mcmf-prov.json --set-as-default
aws iam attach-user-policy --user-name "\$USER_NAME" --policy-arn "\$ARN"
echo "Done — attached \$ARN (network + VM + disk + VPN + ce:GetCostAndUsage) to \$USER_NAME"
echo
echo "COST: this policy includes ce:GetCostAndUsage, but Cost Explorer must be ENABLED once (per account):"
echo "  Billing console -> Cost Explorer -> Enable. Then FinOps -> Cost -> Refresh (CE data lags ~24h)."`,
    };
  }

  if (provider === 'azure') {
    const sub = id.subscriptionId || '<subscription-id>';
    const app = id.clientId || '<app-client-id>';
    const missing = [!id.subscriptionId && 'subscription id', !id.clientId && 'app client id'].filter(Boolean) as string[];
    return {
      shell: 'Azure Cloud Shell (bash)',
      ready: missing.length === 0,
      missing,
      loginUrl: 'https://shell.azure.com/bash',
      loginLabel: 'Open Azure Cloud Shell',
      autoRun: false,
      script: `# MCMF — grant Azure network + VM provisioning (least-privilege, scoped to one RG)
SUBSCRIPTION_ID="${sub}"
APP_CLIENT_ID="${app}"
RG="mcmf-provisioned"
LOCATION="eastasia"
az account set --subscription "\$SUBSCRIPTION_ID"
az group create -n "\$RG" -l "\$LOCATION" -o none
SP_ID=$(az ad sp show --id "\$APP_CLIENT_ID" --query id -o tsv)
SCOPE="/subscriptions/\${SUBSCRIPTION_ID}/resourceGroups/\${RG}"
for ROLE in "Network Contributor" "Virtual Machine Contributor" "Disk Contributor"; do
  az role assignment create --assignee-object-id "\$SP_ID" --assignee-principal-type ServicePrincipal --role "\$ROLE" --scope "\$SCOPE" -o none
done
echo "Done — Network + VM + Disk Contributor on \$RG granted to \$APP_CLIENT_ID"
# NOTE: deploy into the '\$RG' resource group (MCMF defaults to it). For ANY resource group,
# grant Contributor at subscription scope instead:
# az role assignment create --assignee-object-id "\$SP_ID" --assignee-principal-type ServicePrincipal --role Contributor --scope "/subscriptions/\${SUBSCRIPTION_ID}"`,
    };
  }

  if (provider === 'gcp') {
    const project = id.project || '<your-project-id>';
    const sa = id.serviceAccountEmail || `<sa-name>@${project}.iam.gserviceaccount.com`;
    const missing = [!id.project && 'project id', !id.serviceAccountEmail && 'service account email'].filter(Boolean) as string[];
    const ready = missing.length === 0;
    // Cloud Shell deep link that RUNS the grant on open (only when fully resolved).
    const roles = ['roles/compute.networkAdmin', 'roles/bigquery.dataViewer', 'roles/bigquery.jobUser'];
    const oneLiner = `gcloud config set project ${project} && gcloud services enable compute.googleapis.com bigquery.googleapis.com && ` +
      roles.map((r) => `gcloud projects add-iam-policy-binding ${project} --member="serviceAccount:${sa}" --role="${r}"`).join(' && ');
    return {
      shell: 'GCP Cloud Shell',
      ready,
      missing,
      loginUrl: ready ? `https://console.cloud.google.com/cloudshell/open?cloudshell_command=${encodeURIComponent(oneLiner)}` : null,
      loginLabel: 'Open Google Cloud Shell & run',
      autoRun: true,
      script: `# MCMF — grant GCP network provisioning + cost (BigQuery billing export)
PROJECT_ID="${project}"
SA_EMAIL="${sa}"
gcloud config set project "\$PROJECT_ID"
gcloud services enable compute.googleapis.com bigquery.googleapis.com
# network provisioning
gcloud projects add-iam-policy-binding "\$PROJECT_ID" --member="serviceAccount:\${SA_EMAIL}" --role="roles/compute.networkAdmin"
# cost — read the BigQuery billing export dataset + run queries
gcloud projects add-iam-policy-binding "\$PROJECT_ID" --member="serviceAccount:\${SA_EMAIL}" --role="roles/bigquery.dataViewer"
gcloud projects add-iam-policy-binding "\$PROJECT_ID" --member="serviceAccount:\${SA_EMAIL}" --role="roles/bigquery.jobUser"
echo "Done — compute.networkAdmin + bigquery.dataViewer + bigquery.jobUser granted to \$SA_EMAIL"
echo
echo "COST ALSO NEEDS a BigQuery billing export (GCP does not expose a live cost API):"
echo "  1) Console -> Billing -> Billing export -> BigQuery export -> enable 'Standard usage cost' to a dataset."
echo "  2) In MCMF -> Connections -> edit the GCP connection -> set 'BigQuery billing export table' = <project>.<dataset>.gcp_billing_export_v1_XXXXXX"
echo "  3) FinOps -> Cost -> Refresh (data appears a few hours after export is enabled)."`,
    };
  }

  return { shell: '', ready: false, missing: ['unsupported provider'], loginUrl: null, loginLabel: '', autoRun: false, script: `# No grant script for ${provider}` };
}
