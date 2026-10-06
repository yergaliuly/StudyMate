#Requires -Version 7.0
<#
Stores existing R2/OpenAI credentials on the StudyMate backend only.
Requires the already authenticated Northflank CLI and Node.js 22+.
Credentials travel through stdin and process memory, not files or OS command-line arguments.
Does not enable adapters/workers, create resources, or call R2/OpenAI.
#>
[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$project = 'studymate-dev'
$service = 'studymate-backend'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nfCommand = Get-Command northflank -ErrorAction Stop | Select-Object -First 1
$cliEntry = Join-Path (Split-Path $nfCommand.Source) 'node_modules/@northflank/cli/dist/cli.js'
if (!(Test-Path -LiteralPath $cliEntry -PathType Leaf)) {
    throw 'Northflank CLI entry not found beside its npm launcher.'
}

# The JSON argument is created inside Node, after reading stdin. It is never an OS argument.
$bridge = @'
import { pathToFileURL } from 'node:url';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.project !== 'studymate-dev' || request.service !== 'studymate-backend') process.exit(2);
const entry = process.argv[1];
const command = request.action === 'get' ? ['get', 'service'] :
  request.action === 'patch' ? ['patch', 'service', 'combined'] : null;
if (!command) process.exit(2);
process.argv = [process.execPath, entry, ...command,
  '--project', request.project, '--service', request.service, '--quiet', '--output', 'json'];
if (request.action === 'patch') process.argv.push('--input', JSON.stringify(request.payload));
await import(pathToFileURL(entry).href);
'@

function Invoke-PrivateNorthflank([string]$Action, [hashtable]$Payload = @{}) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in @('--input-type=module', '-e', $bridge, $cliEntry)) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $request = @{action=$Action; project=$project; service=$service; payload=$Payload}
        $process.StandardInput.Write(($request | ConvertTo-Json -Depth 30 -Compress))
        $process.StandardInput.Close()
        if (!$process.WaitForExit(90000)) {
            $process.Kill($true)
            throw 'Northflank timed out. A write may have succeeded; check the dashboard before retrying.'
        }
        $output = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw 'Northflank command failed. Output is hidden because it may contain secrets. Check CLI login/access in the dashboard.'
        }
        try { return ConvertFrom-Json -InputObject $output -AsHashtable }
        catch { throw 'Northflank returned an unexpected response. Raw output is hidden.' }
    } finally {
        $process.Dispose()
    }
}

function Assert-InactiveAdapters([hashtable]$Environment) {
    foreach ($key in @('STUDYMATE_R2_ENABLED', 'STUDYMATE_JOBS_ENABLED', 'STUDYMATE_MATERIAL_MAINTENANCE_ENABLED')) {
        if (!$Environment.ContainsKey($key) -or $Environment[$key] -cne 'false') {
            throw "Stop: $key must be explicitly false. Check the current backend settings before continuing."
        }
    }
    if (!$Environment.ContainsKey('STUDYMATE_AI_PROVIDER') -or $Environment.STUDYMATE_AI_PROVIDER -cne 'disabled') {
        throw 'Stop: STUDYMATE_AI_PROVIDER must be explicitly disabled. Check the current backend settings before continuing.'
    }
}

function Read-PrivateValue([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    try {
        $value = [Net.NetworkCredential]::new('', $secure).Password
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match '\s') {
            throw 'A credential is empty or contains whitespace. No settings were changed.'
        }
        return $value
    } finally { $secure.Dispose() }
}

$before = Invoke-PrivateNorthflank 'get'
if ($before.id -cne $service -or $before.serviceType -cne 'combined' -or $before.runtimeEnvironment -isnot [hashtable]) {
    throw 'Unexpected backend service response. No settings were changed.'
}
Assert-InactiveAdapters $before.runtimeEnvironment
if ($CheckOnly) {
    Write-Host 'Preflight OK: Northflank CLI is authenticated; backend adapters/workers are inactive.'
    return
}

Write-Host 'Target: studymate-dev / studymate-backend. Saving settings may restart the backend.'
Write-Host 'Use your existing private R2 bucket and existing API credentials. Keys are entered invisibly.'
$endpoint = (Read-Host 'R2 S3 endpoint (https://<account-id>.r2.cloudflarestorage.com)').Trim().TrimEnd('/')
if ($endpoint -cnotmatch '^https://[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$') {
    throw 'Invalid R2 S3 account endpoint. Use the HTTPS endpoint from Cloudflare R2, without the bucket name.'
}
$bucket = (Read-Host 'Existing private R2 bucket name').Trim()
if ($bucket -cnotmatch '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') { throw 'Invalid R2 bucket name.' }
$values = @{
    STUDYMATE_R2_ENDPOINT = $endpoint
    STUDYMATE_R2_BUCKET = $bucket
    STUDYMATE_R2_ACCESS_KEY_ID = Read-PrivateValue 'R2 Access Key ID'
    STUDYMATE_R2_SECRET_ACCESS_KEY = Read-PrivateValue 'R2 Secret Access Key'
    STUDYMATE_OPENAI_API_KEY = Read-PrivateValue 'OpenAI API key'
}
if ($values.STUDYMATE_OPENAI_API_KEY -cnotmatch '^sk-') { throw 'Expected an OpenAI API key starting with sk-.' }

try {
    # Re-read after interactive input to retain changes made by another developer in the meantime.
    $current = Invoke-PrivateNorthflank 'get'
    Assert-InactiveAdapters $current.runtimeEnvironment
    $environment = $current.runtimeEnvironment.Clone()
    foreach ($key in $values.Keys) { $environment[$key] = $values[$key] }
    $null = Invoke-PrivateNorthflank 'patch' @{runtimeEnvironment=$environment}
    $after = Invoke-PrivateNorthflank 'get'
    # Some worker flags default to true in the application, so explicit inactive values are required.
    Assert-InactiveAdapters $after.runtimeEnvironment
    foreach ($key in $environment.Keys) {
        if (!$after.runtimeEnvironment.ContainsKey($key) -or $after.runtimeEnvironment[$key] -cne $environment[$key]) {
            throw 'Settings were submitted, but verification differed. Do not retry blindly; ask to check the backend settings.'
        }
    }
    Write-Host 'Saved and verified: all 5 R2/OpenAI variables are present on studymate-backend.'
    Write-Host 'Other runtime values were preserved. Adapters/workers remain inactive; no OpenAI calls were made.'
    Write-Host 'Next: verify the backend is healthy, deploy pilot limits, then enable and test the integrations.'
} finally {
    $values.Clear()
    $before = $null
    $current = $null
    $environment = $null
    $after = $null
}
