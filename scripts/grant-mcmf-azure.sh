#!/usr/bin/env bash
# Grant MCMF's Azure app registration the permissions needed to provision networks.
# Run in Azure Cloud Shell (bash) signed in as an Owner/User-Access-Administrator.
#   bash grant-mcmf-azure.sh
set -euo pipefail

# ── EDIT THESE with your Azure connection's IDs ─────────────────────────────
SUBSCRIPTION_ID="<your-subscription-id>"   # MCMF Azure connection subscription
APP_CLIENT_ID="<your-app-client-id>"       # the app registration (client) id
RG="mcmf-provisioned"             # resource group MCMF deploys networks into (its default)
LOCATION="eastasia"               # region for the resource group
# ───────────────────────────────────────────────────────────────────────────

az account set --subscription "$SUBSCRIPTION_ID"

# 1. Pre-create the resource group MCMF uses, so the app only needs network rights inside it.
az group create -n "$RG" -l "$LOCATION" -o none
echo "✓ Resource group ${RG} ready (${LOCATION})"

# 2. Resolve the service principal object id from the client id.
SP_ID=$(az ad sp show --id "$APP_CLIENT_ID" --query id -o tsv)

# 3. Least-privilege: Network Contributor scoped to that resource group (covers VNet + subnet create).
az role assignment create \
  --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
  --role "Network Contributor" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RG}" -o none
echo "✓ Granted 'Network Contributor' on ${RG} to app ${APP_CLIENT_ID}"
echo "Now: MCMF → Topology → + Provision Resource → Azure → Network → Request, then approve."
echo
echo "── Alternatives ──"
echo "• To let MCMF create networks in ANY/new resource group, grant at subscription scope instead:"
echo "    az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \\"
echo "      --role Contributor --scope /subscriptions/${SUBSCRIPTION_ID}"
echo "• For VM later add --role 'Virtual Machine Contributor'; for disks add --role 'Disk Contributor'."
