# Azure GitHub Authentication Proof

This package reproduces the validated GitHub CLI device-authentication flow on
a short-lived Azure Ubuntu VM. It is deliberately an experiment, not the final
Telaegent runtime architecture.

## Ownership boundary

- Thai signs into Azure with Thai's own authorized account and deploys.
- Khoa supplies an SSH **public** key and performs GitHub authentication using
  Khoa's own GitHub account.
- Nobody shares Azure tokens, `.azure` caches, GitHub tokens, SSH private keys,
  or provider credentials.
- The NUS tenant's Conditional Access rejection must not be bypassed. Use an
  Azure account/subscription whose owner permits this deployment.

## What is created

One disposable resource group containing:

- Ubuntu 22.04 minimal Gen2 VM with Trusted Launch;
- system-assigned managed identity for later Key Vault research;
- 32 GiB Standard SSD OS disk;
- VNet, subnet, NIC, Standard static public IP, and NSG;
- exactly one inbound rule: TCP/22 from the supplied operator IPv4 `/32`;
- pinned, checksum-verified GitHub CLI 2.98.0;
- isolated GitHub CLI home/config/state and repository workspace.

No password login, broad SSH rule, Docker socket, GitHub credential, source
repository, or application secret is embedded in the template or cloud-init.

The default `Standard_B2s` size is only for this authentication proof. It is not
a benchmark-backed production or final hackathon runtime choice.

## Prerequisites

Thai needs:

- Azure CLI 2.89.1 or later;
- an authorized Azure subscription;
- permission to create a resource group, VM, network resources, and managed
  identity;
- PowerShell 7 or Windows PowerShell 5.1;
- Khoa's SSH public key file;
- Khoa's current public IPv4 address as a `/32` CIDR.

Khoa retains the matching SSH private key. Thai never needs it.

Create a dedicated key if needed:

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\telaegent-azure-proof" -C "telaegent-azure-proof"
```

Share only `telaegent-azure-proof.pub` with Thai.

Determine Khoa's current public IPv4 through a trusted network source and
communicate it out of band. Do not use `0.0.0.0/0`. The deployment script only
accepts a single IPv4 `/32`.

## 1. Thai: authenticate and inspect the subscription

Use the normal Azure login allowed by Thai's tenant policy:

```powershell
az login
az account list --output table
az account set --subscription '<subscription-id>'
az account show --output table
```

Do not export or send access tokens. Subscription and tenant IDs are identifiers
rather than credentials, but keep them within the team.

## 2. Thai: dry-run the deployment command

From the repository root:

```powershell
$proof = 'deploy\azure\github-auth-proof\Deploy-GitHubAuthProof.ps1'

& $proof `
  -SubscriptionId '<subscription-guid>' `
  -ResourceGroupName 'rg-telaegent-gh-proof-khoa' `
  -SshPublicKeyPath 'C:\path\to\khoas-public-key.pub' `
  -AllowedSshSource '<khoa-public-ip>/32' `
  -DeployedBy 'thai' `
  -WhatIf
```

The script refuses to reuse an existing resource group. It validates the Azure
location, VM SKU, SSH key, subscription state, and `/32` source before creating
anything.

## 3. Thai: deploy

Run the same command without `-WhatIf`:

```powershell
& $proof `
  -SubscriptionId '<subscription-guid>' `
  -ResourceGroupName 'rg-telaegent-gh-proof-khoa' `
  -SshPublicKeyPath 'C:\path\to\khoas-public-key.pub' `
  -AllowedSshSource '<khoa-public-ip>/32' `
  -DeployedBy 'thai'
```

The resource group is tagged with project, purpose, branch, deployer, data
classification, and a UTC expiry timestamp. The default lifetime tag is four
hours. Azure does not delete resources automatically from this tag; Thai still
must run the cleanup script.

If deployment fails, the script starts deletion of the newly created resource
group by default. Use `-KeepFailedResourceGroup` only when diagnostics are
needed and delete it immediately afterward.

The script writes two ignored, non-secret artifacts under `.local/azure-proof`:

- deployment metadata JSON;
- `known_hosts` entry retrieved through Azure Run Command.

The host key is obtained through the authenticated Azure control plane so Khoa
does not have to disable SSH host verification.

## 4. Khoa: run the proof

Thai sends Khoa the non-secret metadata JSON and `known_hosts` file. Khoa runs:

```powershell
& 'deploy\azure\github-auth-proof\Invoke-GitHubAuthProof.ps1' `
  -MetadataPath '.local\azure-proof\rg-telaegent-gh-proof-khoa.json' `
  -SshPrivateKeyPath "$HOME\.ssh\telaegent-azure-proof"
```

The script verifies:

1. clean unauthenticated baseline;
2. interactive GitHub device flow;
3. authenticated identity;
4. credential file metadata without printing the token;
5. `gh auth setup-git`;
6. repository discovery across ownership, direct collaboration, and
   organization membership;
7. stable numeric repository ID `1345851083`;
8. private repository clone into the isolated workspace;
9. authentication and checkout persistence after a full VM reboot;
10. local GitHub credential and checkout removal after the proof.

GitHub CLI local logout does not revoke the OAuth grant server-side. Revoking
the GitHub CLI OAuth application would revoke GitHub CLI tokens across the
user's devices and is therefore a separate explicit user decision.

## 5. Thai: delete the complete resource group

Cleanup requires the exact resource-group name twice and refuses deletion
unless the resource group carries all expected Telaegent proof tags:

```powershell
& 'deploy\azure\github-auth-proof\Remove-GitHubAuthProof.ps1' `
  -SubscriptionId '<subscription-guid>' `
  -ResourceGroupName 'rg-telaegent-gh-proof-khoa' `
  -ConfirmResourceGroupName 'rg-telaegent-gh-proof-khoa' `
  -Wait
```

Confirm it is gone:

```powershell
az group exists `
  --subscription '<subscription-guid>' `
  --name 'rg-telaegent-gh-proof-khoa'
```

Expected output: `false`.

## Stop conditions

Stop and clean up rather than improvising if:

- the VM size or region is restricted;
- SSH would require `0.0.0.0/0`;
- Azure Conditional Access rejects Thai's permitted login;
- deployment would reuse an existing resource group;
- a token appears in logs or repository files;
- the VM host key cannot be obtained through Azure Run Command;
- GitHub authentication resolves to the wrong user;
- the repository numeric ID does not match;
- cleanup tags do not match exactly.

## Evidence to record

Record only safe evidence:

- Azure region, VM size, provisioning/reboot durations, and resource IDs;
- GitHub login and numeric user ID;
- credential path, owner, mode, and persistence behavior—not token contents;
- repository counts by affiliation;
- numeric repository ID, canonical full name, branch, and commit;
- cleanup confirmation.

Never copy raw Azure/GitHub tokens, `.azure` caches, `hosts.yml`, SSH private
keys, repository source, or hidden provider state into documentation or chat.

