# Launches the local Wise MCP with an encrypted, user-scoped Windows token.
# Uses the current Windows account; a different account cannot decrypt the DPAPI file.
[CmdletBinding()]
param(
    [ValidateSet('stdio','check','verify')][string]$Mode = 'stdio',
    [string]$StoreDirectory = (Join-Path $env:LOCALAPPDATA 'WiseMCP')
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This launcher requires Windows.' }
$tokenFile = Join-Path $StoreDirectory 'wise-api-token.dpapi'
if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw 'Wise token not configured. Run scripts/windows/set-wise-token.ps1 interactively first.'
}
$secure = Get-Content -LiteralPath $tokenFile -Raw -Encoding Ascii | ConvertTo-SecureString
if ($secure.Length -lt 16) { throw 'Stored Wise credential is invalid.' }
if ($Mode -eq 'check') {
    Write-Output 'Windows DPAPI credential is readable by this Windows account.'
    exit 0
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$cli = Join-Path $repo 'dist\cli.js'
if ($Mode -eq 'stdio' -and -not (Test-Path -LiteralPath $cli)) {
    throw 'Compiled Wise MCP missing. Run npm run build in the repository.'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:WISE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    # Defense in depth: this temporary Windows host cannot expose money-changing tools.
    $env:WRITES_ENABLED = 'false'
    $env:WISE_API_URL = 'https://api.wise.com'
    Remove-Item Env:WISE_MCP_TEST_MODE -ErrorAction SilentlyContinue
    $env:DATA_DIR = Join-Path $StoreDirectory 'data'
    if ($Mode -eq 'verify') {
        # Never print profile details or the token: report only the HTTP result.
        & $node '--input-type=module' '-e' 'const r=await fetch("https://api.wise.com/v1/me",{headers:{Authorization:"Bearer "+process.env.WISE_API_TOKEN,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(15000)}); if(r.ok){console.log("Wise authentication verified.");}else{console.error("Wise authentication failed: HTTP "+r.status);}process.exit(r.ok?0:1)'
    } else {
        & $node $cli
    }
    $code = $LASTEXITCODE
    exit $code
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Item Env:WISE_API_TOKEN -ErrorAction SilentlyContinue
}
