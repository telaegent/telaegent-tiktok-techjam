[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [ValidatePattern('^rg-telaegent-gh-proof-[a-z0-9-]{1,40}$')]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [string]$SshPublicKeyPath,

    [Parameter(Mandatory)]
    [string]$AllowedSshSource,

    [ValidatePattern('^[a-z0-9]+$')]
    [string]$Location = 'southeastasia',

    [ValidatePattern('^[A-Za-z0-9_]+$')]
    [string]$VmSize = 'Standard_B2s',

    [ValidatePattern('^[a-z][a-z0-9-]{0,30}$')]
    [string]$VmName = 'vm-telaegent-gh-proof',

    [ValidatePattern('^[a-z_][a-z0-9_-]{0,31}$')]
    [string]$AdminUsername = 'telaegent',

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9@._-]{1,80}$')]
    [string]$DeployedBy,

    [ValidateRange(1, 24)]
    [int]$LifetimeHours = 4,

    [string]$AzPath = 'az',

    [switch]$KeepFailedResourceGroup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = & $AzPath @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')`n$($result -join [Environment]::NewLine)"
    }
    return $result
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $text = (Invoke-Az -Arguments ($Arguments + @('--only-show-errors', '--output', 'json'))) -join "`n"
    return $text | ConvertFrom-Json
}

if (-not (Get-Command $AzPath -ErrorAction SilentlyContinue)) {
    throw "Azure CLI was not found: $AzPath"
}

$sourceParts = $AllowedSshSource.Split('/')
if ($sourceParts.Count -ne 2 -or $sourceParts[1] -ne '32') {
    throw 'AllowedSshSource must be a single IPv4 /32 CIDR.'
}
$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($sourceParts[0], [ref]$parsedIp) -or
    $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'AllowedSshSource must contain a valid IPv4 address.'
}

$resolvedKeyPath = (Resolve-Path -LiteralPath $SshPublicKeyPath).Path
$publicKey = (Get-Content -LiteralPath $resolvedKeyPath -Raw).Trim()
if ($publicKey.Length -gt 8192 -or
    $publicKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$') {
    throw 'SshPublicKeyPath does not contain one supported OpenSSH public key.'
}

Invoke-Az -Arguments @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
$account = Invoke-AzJson -Arguments @('account', 'show')
if ($account.id -ne $SubscriptionId -or $account.state -ne 'Enabled') {
    throw 'The requested Azure subscription is not active in the current login.'
}

$locationResult = (Invoke-Az -Arguments @(
    'account', 'list-locations',
    '--query', "[?name=='$Location'].name | [0]",
    '--output', 'tsv',
    '--only-show-errors'
)) -join ''
if ($locationResult.Trim() -ne $Location) {
    throw "Azure location is unavailable to this subscription: $Location"
}

$skuResults = Invoke-AzJson -Arguments @(
    'vm', 'list-skus',
    '--location', $Location,
    '--size', $VmSize,
    '--resource-type', 'virtualMachines',
    '--all'
)
$usableSku = $skuResults | Where-Object {
    $_.name -eq $VmSize -and ($null -eq $_.restrictions -or $_.restrictions.Count -eq 0)
} | Select-Object -First 1
if (-not $usableSku) {
    throw "VM size $VmSize is unavailable or restricted in $Location for this subscription."
}

$groupExists = ((Invoke-Az -Arguments @(
    'group', 'exists', '--name', $ResourceGroupName, '--output', 'tsv', '--only-show-errors'
)) -join '').Trim()
if ($groupExists -eq 'true') {
    throw "Refusing to reuse existing resource group: $ResourceGroupName"
}

$expiresOn = (Get-Date).ToUniversalTime().AddHours($LifetimeHours).ToString('o')
$templatePath = Join-Path $PSScriptRoot 'main.bicep'
$deploymentName = 'github-auth-proof-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
$createdGroup = $false

if (-not $PSCmdlet.ShouldProcess(
    "$SubscriptionId/$ResourceGroupName",
    "Create temporary Telaegent GitHub authentication proof resources in $Location"
)) {
    return
}

try {
    Invoke-Az -Arguments @(
        'group', 'create',
        '--subscription', $SubscriptionId,
        '--name', $ResourceGroupName,
        '--location', $Location,
        '--tags',
        'project=telaegent',
        'purpose=github-auth-proof',
        'branch=khoa.dao',
        "expiresOn=$expiresOn",
        "deployedBy=$DeployedBy",
        'dataClassification=controlled-demo-only',
        '--only-show-errors',
        '--output', 'none'
    ) | Out-Null
    $createdGroup = $true

    $deployment = Invoke-AzJson -Arguments @(
        'deployment', 'group', 'create',
        '--subscription', $SubscriptionId,
        '--resource-group', $ResourceGroupName,
        '--name', $deploymentName,
        '--template-file', $templatePath,
        '--parameters',
        "location=$Location",
        "vmName=$VmName",
        "vmSize=$VmSize",
        "adminUsername=$AdminUsername",
        "sshPublicKey=$publicKey",
        "allowedSshSource=$AllowedSshSource",
        "expiresOn=$expiresOn",
        "deployedBy=$DeployedBy"
    )

    $outputs = $deployment.properties.outputs
    $publicIp = [string]$outputs.publicIpAddress.value
    if (-not [System.Net.IPAddress]::TryParse($publicIp, [ref]$parsedIp)) {
        throw 'Deployment did not return a valid public IP address.'
    }

    $hostKeyResult = Invoke-AzJson -Arguments @(
        'vm', 'run-command', 'invoke',
        '--subscription', $SubscriptionId,
        '--resource-group', $ResourceGroupName,
        '--name', $VmName,
        '--command-id', 'RunShellScript',
        '--scripts', 'cloud-init status --wait >/dev/null && cat /etc/ssh/ssh_host_ed25519_key.pub'
    )
    $hostKeyText = ($hostKeyResult.value | ForEach-Object { $_.message }) -join "`n"
    $hostKeyMatch = [regex]::Match(
        $hostKeyText,
        '(?m)^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$'
    )
    if (-not $hostKeyMatch.Success) {
        throw 'Could not retrieve the VM SSH host key through Azure Run Command.'
    }

    $localOutputRoot = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent | Split-Path -Parent) '.local\azure-proof'
    New-Item -ItemType Directory -Path $localOutputRoot -Force | Out-Null
    $knownHostsPath = Join-Path $localOutputRoot "$ResourceGroupName-known_hosts"
    Set-Content -LiteralPath $knownHostsPath -Value "$publicIp $($hostKeyMatch.Value)" -Encoding ascii

    $metadata = [ordered]@{
        purpose = 'github-auth-proof'
        subscriptionId = $SubscriptionId
        resourceGroupName = $ResourceGroupName
        location = $Location
        vmName = $VmName
        vmSize = $VmSize
        adminUsername = $AdminUsername
        publicIpAddress = $publicIp
        allowedSshSource = $AllowedSshSource
        managedIdentityPrincipalId = [string]$outputs.managedIdentityPrincipalId.value
        knownHostsFileName = Split-Path -Leaf $knownHostsPath
        deployedBy = $DeployedBy
        deployedAt = (Get-Date).ToUniversalTime().ToString('o')
        expiresOn = $expiresOn
    }
    $metadataPath = Join-Path $localOutputRoot "$ResourceGroupName.json"
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8

    Write-Host 'Azure GitHub authentication proof environment is ready.'
    Write-Host "Metadata: $metadataPath"
    Write-Host "Known hosts: $knownHostsPath"
    Write-Host "Public IP: $publicIp"
    Write-Host "Expires tag: $expiresOn"
    Write-Host 'Run Invoke-GitHubAuthProof.ps1 with the metadata and matching SSH private key.'
}
catch {
    if ($createdGroup -and -not $KeepFailedResourceGroup) {
        Write-Warning "Deployment failed. Deleting the newly created resource group $ResourceGroupName."
        & $AzPath group delete `
            --subscription $SubscriptionId `
            --name $ResourceGroupName `
            --yes `
            --no-wait `
            --only-show-errors | Out-Null
    }
    throw
}
