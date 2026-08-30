[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$MetadataPath,

    [Parameter(Mandatory)]
    [string]$SshPrivateKeyPath,

    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'telaegent/telaegent-tiktok-techjam',

    [ValidatePattern('^[0-9]+$')]
    [string]$ExpectedRepositoryId = '1345851083',

    [ValidateRange(30, 600)]
    [int]$RestartTimeoutSeconds = 240,

    [switch]$KeepRemoteGitHubCredential
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw 'OpenSSH client was not found.'
}

$resolvedMetadataPath = (Resolve-Path -LiteralPath $MetadataPath).Path
$resolvedPrivateKeyPath = (Resolve-Path -LiteralPath $SshPrivateKeyPath).Path
$metadata = Get-Content -LiteralPath $resolvedMetadataPath -Raw | ConvertFrom-Json
if ($metadata.purpose -ne 'github-auth-proof') {
    throw 'Metadata is not for a Telaegent GitHub authentication proof environment.'
}
if ([string]$metadata.adminUsername -notmatch '^[a-z_][a-z0-9_-]{0,31}$') {
    throw 'Metadata contains an invalid SSH username.'
}
$metadataIp = $null
if (-not [System.Net.IPAddress]::TryParse(
        [string]$metadata.publicIpAddress,
        [ref]$metadataIp
    ) -or $metadataIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'Metadata contains an invalid public IPv4 address.'
}
$knownHostsFileName = [string]$metadata.knownHostsFileName
if ($knownHostsFileName -notmatch '^rg-telaegent-gh-proof-[a-z0-9-]{1,40}-known_hosts$' -or
    [System.IO.Path]::GetFileName($knownHostsFileName) -cne $knownHostsFileName) {
    throw 'Metadata contains an invalid known_hosts filename.'
}
$metadataDirectory = Split-Path $resolvedMetadataPath -Parent
$knownHostsPath = (Resolve-Path -LiteralPath (
    Join-Path $metadataDirectory $knownHostsFileName
)).Path
$knownHostLines = @(Get-Content -LiteralPath $knownHostsPath)
$escapedIp = [regex]::Escape([string]$metadata.publicIpAddress)
if ($knownHostLines.Count -ne 1 -or
    $knownHostLines[0] -notmatch "^${escapedIp} ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$") {
    throw 'known_hosts must contain exactly the pinned ed25519 key for the metadata IPv4 address.'
}
$target = "$($metadata.adminUsername)@$($metadata.publicIpAddress)"
$baseSshArguments = @(
    '-i', $resolvedPrivateKeyPath,
    '-o', "UserKnownHostsFile=$knownHostsPath",
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10'
)
$batchSshArguments = @($baseSshArguments + @('-o', 'BatchMode=yes'))

function Invoke-ProofSsh {
    param(
        [Parameter(Mandatory)][string]$RemoteCommand,
        [switch]$AllowFailure,
        [switch]$Interactive
    )
    $arguments = if ($Interactive) {
        @($baseSshArguments + @('-t'))
    }
    else {
        @($batchSshArguments)
    }
    $arguments += @($target, $RemoteCommand)
    & ssh @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "SSH command failed with exit code $exitCode."
    }
}

Write-Host 'Checking cloud-init readiness and the clean unauthenticated baseline.'
Invoke-ProofSsh -RemoteCommand @'
test -f /var/lib/telaegent/github-auth-proof/READY &&
/usr/local/bin/telaegent-gh-proof --version &&
git --version &&
if /usr/local/bin/telaegent-gh-proof auth status --hostname github.com >/dev/null 2>&1; then
  echo UNEXPECTED_EXISTING_GITHUB_AUTH
  exit 1
else
  echo BASELINE_UNAUTHENTICATED
fi
'@

Write-Host 'Starting interactive GitHub device authentication on the Azure VM.'
Invoke-ProofSsh `
    -Interactive `
    -RemoteCommand '/usr/local/bin/telaegent-gh-proof auth login --hostname github.com --web --git-protocol https'

Write-Host 'Verifying identity, repository discovery, numeric repository ID, and private clone.'
Invoke-ProofSsh -RemoteCommand "/usr/local/bin/telaegent-gh-proof-verify '$Repository' '$ExpectedRepositoryId'"

$previousBootId = (& ssh @batchSshArguments $target 'cat /proc/sys/kernel/random/boot_id' |
    Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $previousBootId -notmatch '^[0-9a-f-]{36}$') {
    throw 'Could not record the VM boot ID before restart.'
}

Write-Host 'Rebooting the VM to test credential and checkout persistence.'
Invoke-ProofSsh -AllowFailure -RemoteCommand 'sudo systemctl reboot' | Out-Null

$deadline = (Get-Date).AddSeconds($RestartTimeoutSeconds)
$ready = $false
do {
    Start-Sleep -Seconds 5
    $currentBootId = (& ssh @batchSshArguments $target @'
test -f /var/lib/telaegent/github-auth-proof/READY &&
cat /proc/sys/kernel/random/boot_id
'@ 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and
        $currentBootId -match '^[0-9a-f-]{36}$' -and
        $currentBootId -ne $previousBootId) {
        $ready = $true
        break
    }
} while ((Get-Date) -lt $deadline)
if (-not $ready) {
    throw "VM did not become reachable within $RestartTimeoutSeconds seconds."
}

Write-Host 'Verifying the same identity and repository after a full VM reboot.'
Invoke-ProofSsh -RemoteCommand "/usr/local/bin/telaegent-gh-proof-verify '$Repository' '$ExpectedRepositoryId'"

if (-not $KeepRemoteGitHubCredential) {
    Write-Host 'Removing the plaintext remote GitHub credential and cloned workspace.'
    Invoke-ProofSsh -RemoteCommand '/usr/local/bin/telaegent-gh-proof-clean'
    Invoke-ProofSsh -RemoteCommand @'
if /usr/local/bin/telaegent-gh-proof auth status --hostname github.com >/dev/null 2>&1; then
  echo REMOTE_GITHUB_AUTH_CLEANUP_FAILED
  exit 1
else
  echo REMOTE_GITHUB_AUTH_REMOVED
fi
'@
}
else {
    Write-Warning 'The plaintext GitHub CLI credential remains on the proof VM by explicit request.'
}

Write-Host 'Azure GitHub authentication proof completed successfully.'
Write-Host 'Ask the Azure deployment owner to run Remove-GitHubAuthProof.ps1 immediately.'
