# 8byte DevOps Assignment — Todo App Infrastructure & CI/CD

This repository contains the infrastructure-as-code, CI/CD pipeline, and deployment configuration for a containerized Todo application, built as part of the 8byte DevOps assignment (Octa Byte AI Pvt Ltd).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Architecture Decisions](#architecture-decisions)
3. [Prerequisites](#prerequisites)
4. [Setup & Run Instructions](#setup--run-instructions)
5. [CI/CD Pipeline](#cicd-pipeline)
6. [Secret Management](#secret-management)
7. [Security Considerations](#security-considerations)
8. [Cost Optimization Measures](#cost-optimization-measures)
9. [Monitoring & Logging](#monitoring--logging)
10. [Known Limitations / Challenges Faced](#known-limitations--challenges-faced)

---

## Architecture Overview

```
                         ┌─────────────────────────────────────────┐
                         │                  VPC                     │
                         │                                           │
                         │   Public Subnet(s)      Private Subnet(s) │
                         │   ┌────────────┐         ┌─────────────┐  │
  Internet ─────────────┼──▶│ EC2:Staging│         │  RDS        │  │
                         │   │ (Docker)   │◀───────▶│  PostgreSQL │  │
                         │   └────────────┘  5432   │             │  │
                         │   ┌────────────┐         └─────────────┘  │
  Internet ─────────────┼──▶│ EC2:Prod   │                          │
                         │   │ (Docker)   │◀────────────┘            │
                         │   └────────────┘                          │
                         └─────────────────────────────────────────┘

  GitHub ──▶ Jenkins (Multibranch Pipeline) ──▶ ECR ──▶ SSH Deploy ──▶ EC2 (Staging/Prod)
```

**Components provisioned via Terraform:**
- VPC with public and private subnets across multiple Availability Zones
- Two EC2 instances (staging and production application servers) running Docker containers
- RDS PostgreSQL instance (private subnet)
- Security groups scoping access between ALB/app/RDS tiers
- ECR repository for Docker image storage
- IAM roles/instance profiles for EC2 → ECR and EC2 → Secrets Manager access (no static credentials on instances)
- AWS Secrets Manager secrets for database credentials

**CI/CD:** Jenkins Multibranch Pipeline, triggered by GitHub webhooks, running tests on PRs and full build/deploy on merges to `main`.

---

## Architecture Decisions

### Why EC2 + Docker instead of EKS

The assignment permits either "EC2 instances **or** ECS/EKS." We initially provisioned an EKS cluster, but AWS Free Tier's `t3.micro` node type imposes a hard **4-pods-per-node** limit (governed by ENI/IP allocation, not CPU/memory). System pods alone (`aws-node`, `kube-proxy`, 2x `coredns`) consume all four slots, leaving no room to schedule the application pod, and Free Tier does not permit scaling to larger instance types without incurring cost. We pivoted to a **plain EC2 + Docker** deployment model, which:
- Fits entirely within Free Tier limits
- Is simpler to reason about and debug for a two-environment (staging/production) setup
- Still satisfies the assignment's infrastructure requirements

This trade-off and the reasoning behind it is documented further in [Known Limitations](#known-limitations--challenges-faced).

### Why two separate EC2 instances instead of one with multiple containers

Staging and production are isolated at the instance level (rather than sharing one instance with two containers on different ports) to more closely mirror a realistic production topology, and to avoid a staging deployment ever being able to disrupt production port bindings, resource limits, or process state.

### Why Jenkins over GitHub Actions/GitLab CI

Jenkins was selected for full control over pipeline logic (branch-based conditional stages, SSH-based deployment, and Secrets Manager integration at the shell level) and because it can run entirely within our own AWS account without depending on third-party CI minutes/quotas.

### Why SSH + Docker CLI for deployment instead of an orchestrator

Given the EC2-based approach, deployments are performed via Jenkins SSH-ing into each target instance and issuing `docker pull` / `docker run` commands directly. This is intentionally simple for the scope of this assignment. A production-grade evolution of this design would introduce either:
- A blue/green or rolling deploy script instead of stop-then-start (to eliminate the brief downtime window during redeploy), or
- Migration to ECS with a proper task-definition-based rolling deployment

---

## Prerequisites

- AWS account with Free Tier or higher
- Terraform >= 1.5
- AWS CLI v2, configured with credentials that have permissions to create VPC, EC2, RDS, IAM, ECR, and Secrets Manager resources
- Docker installed locally (for building/testing images before push)
- A Jenkins instance (self-hosted on EC2 in this setup) with the following plugins:
  - Pipeline
  - GitHub Branch Source
  - SSH Agent
  - Email Extension
- An EC2 Key Pair (`.pem`) for SSH access to provisioned instances
- A GitHub Personal Access Token (`repo` scope) for Jenkins ↔ GitHub integration

---

## Setup & Run Instructions

### 1. Clone the repository

```bash
git clone https://github.com/rachanack-rachhu/8byte-todo-app.git
cd 8byte-todo-app
```

### 2. Provision infrastructure with Terraform

```bash
cd terraform/environments/stg
terraform init
terraform plan
terraform apply
```

Repeat for the `prod` environment:
```bash
cd ../prod
terraform init
terraform plan
terraform apply
```

Terraform state is stored remotely in an S3 backend (see [State Management](#state-management-details) below). Key resource IDs (VPC ID, subnet IDs, EC2 public IPs, RDS endpoint) are exposed via `outputs.tf` in each environment.

### 3. Retrieve key outputs

```bash
terraform output
```

This returns the staging/production EC2 public IPs and the RDS endpoint needed for the next steps.

### 4. Configure secrets in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name 8byte/staging/rds \
  --region ap-south-1 \
  --secret-string '{
    "host": "<rds-endpoint>",
    "port": "5432",
    "dbname": "<db-name>",
    "username": "<db-username>",
    "password": "<db-password>"
  }'
```
Repeat with `8byte/production/rds` for the production environment.

### 5. Set up Jenkins

- Install required plugins (listed in Prerequisites)
- Add credentials:
  - `ec2-ssh-key` (SSH Username with private key) — for deployment access
  - `github-pat` (Username with password) — GitHub PAT for repo access
- Configure SMTP under **Manage Jenkins → System → Extended E-mail Notification** for build notifications
- Create a **Multibranch Pipeline** job pointing at this repository, with Script Path set to `app/Jenkinsfile`
- Add a GitHub webhook (`http://<jenkins-ip>:8080/github-webhook/`) for automatic build triggers on push/PR events

### 6. Trigger a build

Push a commit to `main`, or open a PR against `main`, to trigger the pipeline. See [CI/CD Pipeline](#cicd-pipeline) for exact stage behavior.

### 7. Verify the application

```bash
curl http://<staging-ip>:3000
curl http://<production-ip>:3000
```

---

## CI/CD Pipeline

The Jenkinsfile (`app/Jenkinsfile`) implements a **Multibranch Pipeline** with two distinct execution paths:

### On Pull Request (any branch → main)
1. Checkout
2. Install dependencies
3. Run unit & integration tests
4. Dependency vulnerability scan (`yarn audit`)

No build, push, or deployment stages execute for PR builds — this is enforced via Jenkins' `changeRequest()` condition combined with `branch 'main'` checks on all downstream stages.

### On Merge to `main`
1. Checkout
2. Install dependencies
3. Run unit & integration tests
4. Dependency vulnerability scan
5. Build Docker image
6. Container vulnerability scan (Trivy — HIGH/CRITICAL severities)
7. Push image to Amazon ECR
8. Deploy to staging (SSH + Docker, credentials pulled from Secrets Manager at deploy time)
9. Automated smoke test against the staging endpoint
10. **Manual approval gate** ("Deploy to Production?")
11. Deploy to production (identical mechanism, separate secret/instance)
12. Automated smoke test against the production endpoint

### Notifications
Build success/failure triggers an email via Jenkins Email Extension to the configured recipient, including a direct link to the build console output.

---

## Secret Management

**Implemented control:** AWS Secrets Manager.

Database credentials (host, port, db name, username, password) for both staging and production are stored as JSON secrets in AWS Secrets Manager (`8byte/staging/rds`, `8byte/production/rds`), rather than as plaintext environment variables, Jenkins credentials, or values committed to the repository.

- EC2 instances retrieve secrets directly at deploy time using their attached **IAM instance profile** (`secretsmanager:GetSecretValue`, scoped to only that environment's secret ARN via resource-level IAM policy) — no static AWS access keys are stored on any instance.
- Jenkins never sees or logs the database password; it is fetched and injected into the container's environment entirely on the remote EC2 host during the SSH deploy step.
- This satisfies the assignment's "at least one of secret management / backup strategy" requirement.

---

## Security Considerations

- **No inbound `0.0.0.0/0` on sensitive ports.** SSH (22) is restricted to a specific administrator IP/CIDR; the application port (3000) is scoped to the load balancer/allowed source security group rather than the public internet directly.
- **Security-group-to-security-group referencing** is used for RDS inbound rules (port 5432 permitted only from the staging and production EC2 security groups by ID), rather than static IP allowlisting — this remains correct even if instance IPs change.
- **No long-lived IAM access keys on compute resources.** EC2 instances use IAM instance profiles for both ECR pull access and Secrets Manager read access.
- **Database credentials are never stored in source control.** `.gitignore` excludes `terraform.tfvars` and any file containing secret material.
- **Principle of least privilege on IAM policies** — the Secrets Manager read policy attached to each EC2 role is scoped by ARN pattern to only that environment's own secret, not a wildcard across all secrets.
- **State file security** — Terraform state (which can contain sensitive resource attributes) is stored in a remote S3 backend rather than locally or committed to git.

### Known gap (documented, not resolved, due to assignment scope/time)
During initial testing, an IAM user's static access key was temporarily entered directly on an EC2 instance via `aws configure` while debugging IAM instance-profile propagation. This key has since been rotated/deactivated. This is called out here deliberately as an example of a real operational risk encountered and corrected during the exercise — see [Known Limitations](#known-limitations--challenges-faced).

---

## Cost Optimization Measures

- **Free Tier–eligible instance types** (`t3.micro`) used for both application EC2 instances and initially attempted for the (later abandoned) EKS node group.
- **Single shared RDS instance** used across staging and production rather than provisioning two separate database instances, since AWS RDS Free Tier only covers a single instance for 12 months. This is a deliberate trade-off — see limitations below.
- **No NAT Gateway duplication** — both application EC2 instances are placed in public subnets with security-group-level restriction rather than provisioning a NAT Gateway per AZ (NAT Gateways incur hourly + data processing charges even when idle).
- **No persistent Kubernetes control plane costs** — abandoning EKS (which bills ~$0.10/hour for the control plane alone, in addition to worker nodes) in favor of plain EC2 removed a fixed cost that would have run regardless of actual usage.
- **Manual production approval gate** in the pipeline prevents unnecessary redeploy cycles (and associated ECR storage/data transfer) from untested changes reaching production automatically.

---

## Monitoring & Logging

*(Status: see repository issue tracker / commit history for current implementation state — infrastructure metrics via CloudWatch Agent on EC2, RDS metrics via native CloudWatch integration, and centralized application/system logs via CloudWatch Logs are the intended design; dashboards to be added covering infrastructure health and application request/error/latency metrics.)*

---

## Known Limitations / Challenges Faced

| Challenge | Resolution |
|---|---|
| EKS node group (`t3.micro`) could not schedule application pods — `0/1 nodes are available: 1 Too many pods` | Root-caused to the ENI-based max-pods-per-node limit (4 pods on `t3.micro`), fully consumed by system pods (`aws-node`, `kube-proxy`, 2x `coredns`). Free Tier does not allow scaling to a larger instance type without cost. Pivoted to EC2 + Docker deployment model instead of EKS. |
| Kubernetes manifests referenced in the pipeline did not exist in the repository yet | Root-caused to manifests never having been committed; files were authored and pushed to `app/k8s/` before being referenced by the pipeline. (Retained in repo history even after the EKS→EC2 pivot for transparency.) |
| Static AWS credentials were briefly configured on an EC2 instance via `aws configure` while debugging IAM role propagation | Identified as a security risk; credentials removed from the instance and the underlying IAM access key rotated/deactivated. Root cause (IAM instance profile not yet attached) was fixed separately so static keys are no longer needed. |
| Jenkins Multibranch job initially configured as a plain "Pipeline" job instead of "Multibranch Pipeline," preventing PR-based triggering | Job deleted and recreated with the correct item type; GitHub branch source and PR-discovery behaviour added explicitly. |
| Jenkins GitHub branch scanning defaulted to anonymous API access, triggering GitHub's low unauthenticated rate limit and multi-minute scan delays | Diagnosed via Scan Repository Log output; resolved by explicitly selecting the GitHub PAT credential inside the Branch Source configuration (it was present in Jenkins' credential store but not attached to the source). |
| Shared RDS instance used across staging and production rather than two isolated database instances | Accepted trade-off due to AWS Free Tier's single-instance RDS allowance; documented here as a deviation from production best practice rather than silently left unaddressed. |

---

## Repository Structure

```
terraform/
├── modules/
│   ├── vpc/
│   ├── ec2/
│   └── rds/
└── environments/
    ├── stg/
    └── prod/
app/
├── Jenkinsfile
├── Dockerfile
├── k8s/                # retained from initial EKS attempt
├── src/
└── package.json
```
