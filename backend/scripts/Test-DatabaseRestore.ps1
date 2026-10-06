# Windows / PowerShell 7, PostgreSQL 17 client tools. Does not change the source DB.
# Passwords must be SecureString values (Read-Host -AsSecureString), never command-line literals.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceHost,
    [Parameter(Mandatory)][ValidateRange(1,65535)][int]$SourcePort,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$SourceDatabase,
    [Parameter(Mandatory)][string]$SourceUser,
    [Parameter(Mandatory)][securestring]$SourcePassword,
    [ValidateSet('require','verify-full','disable')][string]$SourceSslMode = 'require',
    [Parameter(Mandatory)][ValidateRange(1,65535)][int]$RestorePort,
    [Parameter(Mandatory)][string]$RestoreUser,
    [Parameter(Mandatory)][securestring]$RestorePassword,
    [string]$PgBin = 'C:\Program Files\PostgreSQL\17\bin',
    [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA 'StudyMate\backups')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($SourcePort -eq $RestorePort) { throw 'Use a separate restore server port, not the source/forwarded port.' }

function Invoke-Pg([string]$Executable, [string[]]$Arguments) {
    # Native stderr can contain row data. Retain it in memory, never put it in logs/reports.
    $result = & (Join-Path $PgBin ($Executable + '.exe')) @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed (exit $LASTEXITCODE). Details suppressed because they may contain database data. The source was not modified; inspect the new local restore DB separately."
    }
    return $result
}

$savedEnvironment = @{}
foreach ($key in @('PGHOST','PGHOSTADDR','PGSERVICE','PGSERVICEFILE','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGCONNECT_TIMEOUT','PGAPPNAME','PGOPTIONS')) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
try {
    # libpq hostaddr takes precedence over host; inherited service files can redirect connections.
    foreach ($key in @('PGHOSTADDR','PGSERVICE','PGSERVICEFILE')) { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
    foreach ($tool in @('pg_dump','pg_restore','psql','createdb')) {
        if (!(Test-Path -LiteralPath (Join-Path $PgBin ($tool + '.exe')) -PathType Leaf)) { throw "Missing PostgreSQL client: $tool" }
        if ((Invoke-Pg $tool @('--version')) -notmatch 'PostgreSQL\) 17\.') { throw 'Use PostgreSQL 17 client tools.' }
    }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss') + '_' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $directory = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) $stamp
    # Dumps contain private data/password hashes. This directory is private to the current Windows user.
    if (Test-Path -LiteralPath $directory) { throw 'Refusing to reuse an existing backup directory.' }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($identity)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $directory -AclObject $acl

    $dumpPath = Join-Path $directory ("studymate_$stamp.dump")
    $restoreDatabase = "studymate_restore_$stamp"
    if (Test-Path -LiteralPath $dumpPath) { throw 'Refusing to overwrite an existing backup.' }
    $env:PGHOST = $SourceHost
    $env:PGPORT = "$SourcePort"
    $env:PGDATABASE = $SourceDatabase
    $env:PGUSER = $SourceUser
    $env:PGPASSWORD = [Net.NetworkCredential]::new('', $SourcePassword).Password
    $env:PGSSLMODE = $SourceSslMode
    $env:PGCONNECT_TIMEOUT = '15'
    $env:PGAPPNAME = 'studymate-backup-restore-drill'
    $env:PGOPTIONS = '-c default_transaction_read_only=on'
    $sourceVersion = Invoke-Pg 'psql' @('-X','-w','-A','-t','-v','ON_ERROR_STOP=1','-c','SHOW server_version_num')
    if ([int]($sourceVersion | Select-Object -Last 1) -lt 170000 -or [int]($sourceVersion | Select-Object -Last 1) -ge 180000) { throw 'Source must use PostgreSQL 17.' }
    Invoke-Pg 'pg_dump' @('-w','--format=custom','--no-owner','--no-privileges','--lock-wait-timeout=15s',
        '--exclude-extension=pg_stat_kcache','--exclude-extension=pg_stat_statements',
        '--exclude-table-data=studymate.spring_session','--exclude-table-data=studymate.spring_session_attributes',"--file=$dumpPath") | Out-Null
    Invoke-Pg 'pg_restore' @('--list',$dumpPath) | Out-Null

    # Target is ALWAYS loopback and a newly generated database. There is no --clean / DROP path.
    $env:PGHOST = '127.0.0.1'
    $env:PGHOSTADDR = '127.0.0.1'
    $env:PGPORT = "$RestorePort"
    $env:PGDATABASE = 'postgres'
    $env:PGUSER = $RestoreUser
    $env:PGPASSWORD = [Net.NetworkCredential]::new('', $RestorePassword).Password
    $env:PGSSLMODE = 'disable'
    $env:PGOPTIONS = ''
    $targetVersion = Invoke-Pg 'psql' @('-X','-w','-A','-t','-v','ON_ERROR_STOP=1','-c','SHOW server_version_num')
    if ([int]($targetVersion | Select-Object -Last 1) -lt 170000 -or [int]($targetVersion | Select-Object -Last 1) -ge 180000) { throw 'Restore target must use PostgreSQL 17.' }
    Invoke-Pg 'createdb' @('-w','--template=template0','--encoding=UTF8',"--owner=$RestoreUser",$restoreDatabase) | Out-Null
    Invoke-Pg 'pg_restore' @('-w',"--dbname=$restoreDatabase",'--single-transaction','--exit-on-error','--no-owner','--no-privileges',$dumpPath) | Out-Null
    $env:PGDATABASE = $restoreDatabase
    $env:PGOPTIONS = '-c default_transaction_read_only=on'
    $checkSql = @'
SELECT json_build_object(
  'flywayVersion', (SELECT version FROM public.flyway_schema_history WHERE success AND version IS NOT NULL ORDER BY installed_rank DESC LIMIT 1),
  'users', (SELECT count(*) FROM studymate.users),
  'subjects', (SELECT count(*) FROM studymate.subjects),
  'materials', (SELECT count(*) FROM studymate.materials),
  'jobs', (SELECT count(*) FROM studymate.jobs),
  'summaries', (SELECT count(*) FROM studymate.material_summaries),
  'quizzes', (SELECT count(*) FROM studymate.quizzes),
  'attempts', (SELECT count(*) FROM studymate.attempts),
  'sessions', (SELECT count(*) FROM studymate.spring_session),
  'sessionAttributes', (SELECT count(*) FROM studymate.spring_session_attributes),
  'unvalidatedConstraints', (SELECT count(*) FROM pg_constraint WHERE connamespace='studymate'::regnamespace AND NOT convalidated)
);
'@
    $verification = (Invoke-Pg 'psql' @('-X','-w','-A','-t','-v','ON_ERROR_STOP=1','-c',$checkSql)) | ConvertFrom-Json
    if ($verification.sessions -ne 0 -or $verification.sessionAttributes -ne 0 -or $verification.unvalidatedConstraints -ne 0) { throw 'Restore verification failed.' }
    $report = [ordered]@{
        completedAtUtc = [DateTime]::UtcNow.ToString('o')
        archive = $dumpPath
        sha256 = (Get-FileHash -LiteralPath $dumpPath -Algorithm SHA256).Hash
        archiveBytes = (Get-Item -LiteralPath $dumpPath).Length
        restoreHost = '127.0.0.1'
        restorePort = $RestorePort
        restoreDatabase = $restoreDatabase
        verification = $verification
        scope = 'Consistent PostgreSQL logical backup restored atomically, constraints validated, login sessions and provider monitoring extensions pg_stat_kcache/pg_stat_statements excluded. R2 objects, cloud schedules and app behaviour are not tested by this script. No application or jobs started against restored data.'
    }
    $reportPath = Join-Path $directory ("restore_$stamp.json")
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "Backup restored and checked. Report: $reportPath"
    Write-Output "Local restore DB: $restoreDatabase (port $RestorePort). Keep all workers/maintenance/AI/R2 disabled if inspecting it with an app."
} finally {
    foreach ($entry in $savedEnvironment.GetEnumerator()) {
        if ($null -eq $entry.Value) { Remove-Item -LiteralPath ("Env:" + $entry.Key) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    }
}
