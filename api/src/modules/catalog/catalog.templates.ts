// Service Catalog templates. Each is a small Terraform module with `variable` blocks matching its
// inputs; the service renders inputs as terraform.tfvars.json. Adding a provisionable service = adding
// an entry here (no new code). `estMonthly` gives a rough FinOps cost estimate shown at plan time.

export interface CatalogInput { key: string; label: string; type: 'text' | 'number'; default?: string | number; help?: string }
export interface CatalogTemplate {
  key: string;
  name: string;
  cloud: 'demo' | 'aws' | 'azure' | 'gcp';
  description: string;
  inputs: CatalogInput[];
  tf: string; // HCL — `variable` blocks must match the input keys
  estMonthly?: (inputs: Record<string, unknown>) => { usd: number; note: string };
}

// On-demand ~/mo (730h) for common instance sizes — rough, region-agnostic, for the plan estimate only.
const EC2_RATE: Record<string, number> = { 't3.micro': 7.6, 't3.small': 15.2, 't3.medium': 30.4, 't3.large': 60.8 };

export const CATALOG: CatalogTemplate[] = [
  {
    key: 'aws-s3',
    name: 'AWS — S3 bucket',
    cloud: 'aws',
    description: 'Creates an S3 bucket in the chosen region using the selected AWS connection.',
    inputs: [
      { key: 'region', label: 'Region', type: 'text', default: 'us-east-1' },
      { key: 'bucket_name', label: 'Bucket name (globally unique)', type: 'text' },
    ],
    estMonthly: () => ({ usd: 0, note: 'Usage-based: ~$0.023/GB-mo stored + requests. ~$0 when empty.' }),
    tf: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region"      { type = string }
variable "bucket_name" { type = string }

provider "aws" { region = var.region }

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
}

output "bucket_arn" { value = aws_s3_bucket.this.arn }
`,
  },
  {
    key: 'aws-ec2',
    name: 'AWS — EC2 instance',
    cloud: 'aws',
    description: 'Launches an EC2 instance (default VPC) from the given AMI. The cost estimate reflects the instance type.',
    inputs: [
      { key: 'region', label: 'Region', type: 'text', default: 'us-east-1' },
      { key: 'instance_type', label: 'Instance type', type: 'text', default: 't3.micro', help: 't3.micro / t3.small / t3.medium / t3.large' },
      { key: 'ami', label: 'AMI id (region-specific)', type: 'text', help: 'e.g. ami-0abcdef… — find it in the AWS console for your region' },
    ],
    estMonthly: (i) => { const r = EC2_RATE[String(i.instance_type)] ?? 10; return { usd: r, note: `${i.instance_type} on-demand ~$${r}/mo (730h) + EBS/egress extra.` }; },
    tf: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region"        { type = string }
variable "instance_type" { type = string }
variable "ami"           { type = string }

provider "aws" { region = var.region }

resource "aws_instance" "this" {
  ami           = var.ami
  instance_type = var.instance_type
}

output "instance_id" { value = aws_instance.this.id }
output "public_ip"   { value = aws_instance.this.public_ip }
`,
  },
  {
    key: 'azure-rg',
    name: 'Azure — resource group',
    cloud: 'azure',
    description: 'Creates an Azure resource group in the chosen location.',
    inputs: [
      { key: 'name', label: 'Resource group name', type: 'text' },
      { key: 'location', label: 'Location', type: 'text', default: 'eastus' },
    ],
    estMonthly: () => ({ usd: 0, note: 'A resource group itself is free.' }),
    tf: `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

variable "name"     { type = string }
variable "location" { type = string }

provider "azurerm" { features {} }

resource "azurerm_resource_group" "this" {
  name     = var.name
  location = var.location
}

output "rg_id" { value = azurerm_resource_group.this.id }
`,
  },
  {
    key: 'azure-storage',
    name: 'Azure — storage account',
    cloud: 'azure',
    description: 'Creates a Standard LRS storage account in an existing resource group.',
    inputs: [
      { key: 'resource_group', label: 'Existing resource group', type: 'text' },
      { key: 'location', label: 'Location', type: 'text', default: 'eastus' },
      { key: 'account_name', label: 'Account name (3-24 lowercase alphanumerics)', type: 'text' },
    ],
    estMonthly: () => ({ usd: 0, note: 'Usage-based: ~$0.018/GB-mo (Standard LRS hot). ~$0 when empty.' }),
    tf: `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

variable "resource_group" { type = string }
variable "location"       { type = string }
variable "account_name"   { type = string }

provider "azurerm" { features {} }

resource "azurerm_storage_account" "this" {
  name                     = var.account_name
  resource_group_name      = var.resource_group
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

output "primary_blob_endpoint" { value = azurerm_storage_account.this.primary_blob_endpoint }
`,
  },
  {
    key: 'gcp-bucket',
    name: 'GCP — Cloud Storage bucket',
    cloud: 'gcp',
    description: 'Creates a Google Cloud Storage bucket in the chosen location.',
    inputs: [
      { key: 'name', label: 'Bucket name (globally unique)', type: 'text' },
      { key: 'location', label: 'Location', type: 'text', default: 'US' },
    ],
    estMonthly: () => ({ usd: 0, note: 'Usage-based: ~$0.020/GB-mo (Standard). ~$0 when empty.' }),
    tf: `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "name"     { type = string }
variable "location" { type = string }

resource "google_storage_bucket" "this" {
  name     = var.name
  location = var.location
}

output "bucket_url" { value = google_storage_bucket.this.url }
`,
  },
  {
    key: 'gcp-network',
    name: 'GCP — VPC network',
    cloud: 'gcp',
    description: 'Creates a VPC network (auto subnets) in the selected GCP project.',
    inputs: [
      { key: 'name', label: 'Network name', type: 'text' },
    ],
    estMonthly: () => ({ usd: 0, note: 'A VPC network is free; egress / forwarding rules billed separately.' }),
    tf: `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "name" { type = string }

resource "google_compute_network" "this" {
  name                    = var.name
  auto_create_subnetworks = true
}

output "network_id" { value = google_compute_network.this.id }
`,
  },
];
