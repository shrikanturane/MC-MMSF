#!/usr/bin/env bash
# Grant MCMF's GCP service account the permissions needed to provision networks.
# Run in GCP Cloud Shell signed in as a project Owner/IAM Admin.
#   bash grant-mcmf-gcp.sh
set -euo pipefail

# ── EDIT THESE ─────────────────────────────────────────────────────────────
PROJECT_ID="<your-project-id>"                                  # the project from your SA key (project_id)
SA_EMAIL="<sa-name>@${PROJECT_ID}.iam.gserviceaccount.com"      # the MCMF service account email
# ───────────────────────────────────────────────────────────────────────────

gcloud config set project "$PROJECT_ID"

# 1. Make sure the Compute Engine API is on (required to create networks).
gcloud services enable compute.googleapis.com

# 2. Grant network admin (covers VPC + subnetwork create) to the service account.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/compute.networkAdmin"

echo "✓ Granted roles/compute.networkAdmin to ${SA_EMAIL} on ${PROJECT_ID}"
echo "Now: MCMF → Topology → + Provision Resource → GCP → Network → Request, then approve."
echo
echo "── For VM / disk later ──"
echo "  VM:   roles/compute.instanceAdmin.v1  (+ roles/iam.serviceAccountUser if the VM runs as a SA)"
echo "  Disk: roles/compute.storageAdmin"
echo "Tip: find the SA email with —  gcloud iam service-accounts list --project ${PROJECT_ID}"
