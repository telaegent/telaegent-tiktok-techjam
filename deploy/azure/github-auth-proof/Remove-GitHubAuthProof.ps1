[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [ValidatePattern('^rg-telaegent-gh-proof-[a-z0-9-]{1,40}$')]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [string]$ConfirmResourceGroupName,

    [string]$AzPath = 'az',

    [switch]$Wait
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($ConfirmResourceGroupName -cne $ResourceGroupName) {
    throw 'ConfirmResourceGroupName must exactly match ResourceGroupName.'
}
if (-not (Get-Command $AzPath -ErrorAction SilentlyContinue)) {
    throw "Azure CLI was not found: $AzPath"
}

& $AzPath account set --subscription $SubscriptionId
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to select the requested Azure subscription.'
}

$groupText = & $AzPath group show `
    --subscription $SubscriptionId `
    --name $ResourceGroupName `
    --only-show-errors `
    --output json
if ($LASTEXITCODE -ne 0) {
    throw "Resource group does not exist or is inaccessible: $ResourceGroupName"
}
$group = ($groupText -join "`n") | ConvertFrom-Json
if ($group.tags.project -ne 'telaegent' -or
    $group.tags.purpose -ne 'github-auth-proof' -or
    $group.tags.branch -ne 'khoa.dao') {
    throw 'Refusing deletion because the resource group lacks the exact Telaegent proof tags.'
}

if (-not $PSCmdlet.ShouldProcess(
    "$SubscriptionId/$ResourceGroupName",
    'Delete the entire tagged temporary Azure resource group'
)) {
    return
}

$arguments = @(
    'group', 'delete',
    '--subscription', $SubscriptionId,
    '--name', $ResourceGroupName,
    '--yes',
    '--only-show-errors'
)
if (-not $Wait) {
    $arguments += '--no-wait'
}
& $AzPath @arguments
if ($LASTEXITCODE -ne 0) {
    throw 'Azure resource-group deletion failed.'
}

$repoRoot = Split-Path $PSScriptRoot -Parent | Split-Path -Parent | Split-Path -Parent
$localOutputRoot = Join-Path $repoRoot '.local\azure-proof'
foreach ($path in @(
    (Join-Path $localOutputRoot "$ResourceGroupName.json"),
    (Join-Path $localOutputRoot "$ResourceGroupName-known_hosts")
)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}

if ($Wait) {
    Write-Host "Deleted resource group: $ResourceGroupName"
}
else {
    Write-Host "Deletion started for resource group: $ResourceGroupName"
    Write-Host 'Run az group exists to confirm completion.'
}

