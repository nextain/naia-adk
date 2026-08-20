param(
    [Parameter(Mandatory = $true)] [string]$SourcePath,
    [Parameter(Mandatory = $true)] [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $SourcePath).Path
if ([System.IO.Path]::GetExtension($source).ToLowerInvariant() -ne ".hwp") { throw "SourcePath must point to an .hwp file." }
$output = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($output).ToLowerInvariant() -ne ".hwpx") { throw "OutputPath must end with .hwpx." }
$outputDirectory = [System.IO.Path]::GetDirectoryName($output)
if (-not [System.IO.Directory]::Exists($outputDirectory)) { [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null }
if ($source -eq $output) { throw "SourcePath and OutputPath must be different." }

$moduleKey = "HKCU:\Software\HNC\HwpAutomation\Modules"
$moduleName = "FilePathCheckerModuleExample"
$modulePath = $null
if (Test-Path -LiteralPath $moduleKey) {
    $modulePath = (Get-ItemProperty -LiteralPath $moduleKey -Name $moduleName -ErrorAction SilentlyContinue).$moduleName
}
if ([string]::IsNullOrWhiteSpace($modulePath) -or -not (Test-Path -LiteralPath $modulePath)) {
    throw "Hancom FilePathCheckerModuleExample is not registered or its DLL path is missing. Refusing non-interactive conversion to avoid a blocking security dialog."
}

$hwp = $null
try {
    $hwp = New-Object -ComObject "HWPFrame.HwpObject"
    $registered = $hwp.RegisterModule("FilePathCheckDLL", $moduleName)
    if (-not $registered) { throw "Hancom rejected the registered file-path security module." }
    try { $hwp.XHwpWindows.Item(0).Visible = $false } catch {}
    $opened = $hwp.Open($source, "HWP", "forceopen:true")
    if (-not $opened) { throw "Hancom HWP could not open the source." }
    $saved = $hwp.SaveAs($output, "HWPX", "")
    if (-not $saved -or -not [System.IO.File]::Exists($output)) { throw "Hancom HWP could not create the HWPX output." }
    Write-Output $output
}
finally {
    if ($null -ne $hwp) {
        try { $hwp.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp) } catch {}
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
