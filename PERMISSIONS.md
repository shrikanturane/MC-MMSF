# MCMF — Cloud Permissions Guide

What to grant on each cloud to **Manage**, **Monitor** and **Secure** (plus Cost &
Control). Set these once and each pillar lights up as the feature ships. The same
in-app guide lives under **Help** in the UI.

**Status legend:** `live` = available now · `planned` = grant now, works when the feature ships.

---

## AWS

**Auth:** IAM user access key (AKIA… + secret) or STS creds. If the user has a
**permissions boundary**, the boundary must also allow these actions.

**Quick grant:** attach `ReadOnlyAccess` + `CloudWatchReadOnlyAccess` +
`AWSSecurityHubReadOnlyAccess` + `AmazonGuardDutyReadOnlyAccess`, then enable
**GuardDuty**, **Security Hub** and **Cost Explorer**.

| Pillar | Status | Grant (managed policy) | Enable (service) | Key actions |
|---|---|---|---|---|
| **Manage** | live | `AmazonEC2ReadOnlyAccess`, `AmazonRDSReadOnlyAccess`, `AmazonS3ReadOnlyAccess` (or `ReadOnlyAccess`) | — | `ec2:DescribeInstances`, `ec2:DescribeRegions`, `rds:DescribeDBInstances`, `s3:ListAllMyBuckets`, `sts:GetCallerIdentity` |
| **Monitor** | planned | `CloudWatchReadOnlyAccess` | — | `cloudwatch:GetMetricData`, `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics` |
| **Secure** | planned | `AWSSecurityHubReadOnlyAccess`, `AmazonGuardDutyReadOnlyAccess`, *(opt)* `AmazonInspector2ReadOnlyAccess` | Security Hub, GuardDuty, *(opt)* Inspector | `securityhub:GetFindings`, `guardduty:ListFindings/GetFindings`, `inspector2:ListFindings` |
| **Cost** | planned | Cost Explorer read (`ce:*` read) | Cost Explorer (one-time, admin) | `ce:GetCostAndUsage`, `ce:GetCostForecast` |
| **Control** *(write, optional)* | planned | custom policy | — | `ec2:StartInstances`, `ec2:StopInstances`, `ec2:RebootInstances` |

> Memory/disk-usage metrics need the **CloudWatch Agent** on the instance. Security Hub
> aggregates GuardDuty + Inspector + Config — the single richest findings source.

---

## Azure

**Auth:** Entra ID app registration (service principal) + client secret. Assign all
roles to the app at the **subscription** scope (Access control (IAM) → Add role assignment).

**Quick grant:** assign **Reader**, **Monitoring Reader**, **Security Reader**,
**Cost Management Reader**. Add **Virtual Machine Contributor** only for start/stop control.

| Pillar | Status | Grant (built-in role) | Enable | Notes |
|---|---|---|---|---|
| **Manage** | live | **Reader** | — | Covers all resource discovery via ARM |
| **Monitor** | live | **Monitoring Reader** (Reader also works) | — | VM CPU/network/disk = platform metrics, no agent. Memory %, guest disk and per-process need the **Azure Monitor Agent (VM Insights)** |
| **Secure** | planned | **Security Reader** | Microsoft Defender for Cloud | Reads assessments, alerts, secure score |
| **Cost** | planned | **Cost Management Reader** | — | — |
| **Control** *(write, optional)* | planned | **Virtual Machine Contributor** | — | start / deallocate / restart |

---

## GCP

**Auth:** Service Account JSON key. Grant roles to the SA on the project and enable
the APIs. Use a broad role (`roles/viewer`) or scoped roles per pillar.

**Quick grant:** grant `roles/viewer` + `roles/monitoring.viewer` +
`roles/securitycenter.findingsViewer` + `roles/billing.viewer`, and enable the
**Compute Engine**, **Cloud Monitoring**, **Security Command Center** and **Cloud Billing** APIs.

| Pillar | Status | Grant (role) | Enable (API) | Notes |
|---|---|---|---|---|
| **Manage** | live | `roles/viewer` (or `roles/compute.viewer` + `roles/storage.objectViewer`) | Compute Engine API *(Cloud Resource Manager optional)* | — |
| **Monitor** | planned | `roles/monitoring.viewer` | Cloud Monitoring API | — |
| **Secure** | planned | `roles/securitycenter.findingsViewer` | Security Command Center API | SCC is org-scoped; needs Standard/Premium tier |
| **Cost** | planned | `roles/billing.viewer` | Cloud Billing API | Detailed cost via BigQuery billing export |
| **Control** *(write, optional)* | planned | `roles/compute.instanceAdmin.v1` | — | start / stop / reset |

> Use the broad `cloud-platform` OAuth scope (MCMF does this automatically); the SA's
> IAM role still restricts actual access to read-only.

---

## Docker / Linux / Windows (no cloud IAM)

| Provider | Needs |
|---|---|
| **Docker** | Read access to the Docker socket (`/var/run/docker.sock`) or a reachable Engine TCP endpoint (2375/2376) |
| **Linux** | An SSH login that can run `hostname`, `uname`, `nproc`, `free`, read `/etc/os-release` |
| **Windows** | OpenSSH Server enabled + an account allowed to sign in over SSH |
