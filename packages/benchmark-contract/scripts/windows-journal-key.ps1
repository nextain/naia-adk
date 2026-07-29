param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("init", "exec")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$KeyFile,

    [string]$NodeScript,

    [string]$NodeArgumentsBase64 = "W10="
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$resolvedKeyFile = [System.IO.Path]::GetFullPath($KeyFile)
$entropy = [System.Text.Encoding]::UTF8.GetBytes("naia-benchmark-journal-key-v1")

function New-ProtectedJournalKey {
    param([string]$Destination)
    if ([System.IO.File]::Exists($Destination)) {
        throw "Journal key already exists: $Destination"
    }
    $parent = [System.IO.Path]::GetDirectoryName($Destination)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    $plain = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($plain)
        $protected = [System.Security.Cryptography.ProtectedData]::Protect(
            $plain,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes($Destination, $protected)
    }
    finally {
        if ($null -ne $plain) { [System.Array]::Clear($plain, 0, $plain.Length) }
        if ($null -ne $rng) { $rng.Dispose() }
    }
}

function Invoke-WithProtectedJournalKey {
    param([string]$Source, [string]$ScriptPath, [string[]]$Arguments)
    if (-not [System.IO.File]::Exists($Source)) { throw "Journal key does not exist: $Source" }
    if ([string]::IsNullOrWhiteSpace($ScriptPath)) { throw "NodeScript is required for exec" }
    $resolvedScript = [System.IO.Path]::GetFullPath($ScriptPath)
    if (-not [System.IO.File]::Exists($resolvedScript)) { throw "NodeScript does not exist: $resolvedScript" }
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        [System.IO.File]::ReadAllBytes($Source),
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try {
        $env:NAIA_BENCHMARK_JOURNAL_KEY = [System.Convert]::ToBase64String($plain)
        & node $resolvedScript @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Node benchmark runner exited with code $LASTEXITCODE" }
    }
    finally {
        Remove-Item Env:NAIA_BENCHMARK_JOURNAL_KEY -ErrorAction SilentlyContinue
        [System.Array]::Clear($plain, 0, $plain.Length)
    }
}

if ($Action -eq "init") {
    New-ProtectedJournalKey -Destination $resolvedKeyFile
    Write-Output "Windows DPAPI journal key initialized."
}
else {
    $NodeArgumentsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($NodeArgumentsBase64))
    if (-not $NodeArgumentsJson.TrimStart().StartsWith("[")) { throw "NodeArgumentsJson must be a JSON array" }
    $decodedArguments = ConvertFrom-Json -InputObject $NodeArgumentsJson
    [string[]]$parsedArguments = @($decodedArguments | ForEach-Object { [string]$_ })
    Invoke-WithProtectedJournalKey -Source $resolvedKeyFile -ScriptPath $NodeScript -Arguments $parsedArguments
}
