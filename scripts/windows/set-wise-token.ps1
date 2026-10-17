# Stores the Wise API token encrypted with Windows DPAPI for the current user.
# Do not put tokens in Git, terminal arguments, or Executor connector definitions.
[CmdletBinding()]
param(
    [Security.SecureString]$Token,
    [string]$StoreDirectory = (Join-Path $env:LOCALAPPDATA 'WiseMCP')
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This script requires Windows.' }
if (-not $Token) {
    $Token = Read-Host 'Enter Wise API token (hidden)' -AsSecureString
}
if ($Token.Length -lt 16) { throw 'Token appears too short. No credential was saved.' }
New-Item -ItemType Directory -Path $StoreDirectory -Force | Out-Null

# Secure the containing directory BEFORE the token is written; abort on ACL errors.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $StoreDirectory '/inheritance:r' '/grant:r' "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure Wise credential directory.' }
$existing = @(Get-ChildItem -LiteralPath $StoreDirectory -Force)
if ($existing.Count -gt 0) {
    & icacls.exe (Join-Path $StoreDirectory '*') '/reset' '/T' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot secure existing Wise credential files.' }
}
$target = Join-Path $StoreDirectory 'wise-api-token.dpapi'
$tmp = Join-Path $StoreDirectory ('wise-api-token.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    # ConvertFrom-SecureString without -Key uses user-scoped DPAPI on Windows.
    $Token | ConvertFrom-SecureString | Set-Content -LiteralPath $tmp -NoNewline -Encoding Ascii
    Move-Item -LiteralPath $tmp -Destination $target -Force
    Write-Output 'Wise token encrypted using Windows DPAPI. The token was not displayed.'
} finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    $Token.Dispose()
}
