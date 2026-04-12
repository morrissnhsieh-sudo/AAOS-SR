# ==============================================================================
# stop_all.ps1
# Terminates the AAOS services and agents launched by start_all.ps1
# ==============================================================================

Write-Host "Stopping AAOS processes..." -ForegroundColor Cyan

# The signatures to search for in running process command lines
$targetSignatures = @(
    "AAOS Gateway",
    "AAOS Remote Node",
    "src/index.ts",
    "node_agent_cli.ts"
)

# Fetch all processes using WMI to access their command line arguments
$allProcs = Get-CimInstance Win32_Process

$count = 0
foreach ($proc in $allProcs) {
    if (-not [string]::IsNullOrWhiteSpace($proc.CommandLine)) {
        foreach ($signature in $targetSignatures) {
            # Check if this process matches any of our target signatures
            # Also ensure we do not kill the currently running script ($PID)
            if ($proc.CommandLine.Contains($signature) -and $proc.ProcessId -ne $PID) {
                Write-Host "Terminating process $($proc.ProcessId)... ($signature)" -ForegroundColor Yellow
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
                $count++
                break # Move to next process
            }
        }
    }
}

if ($count -gt 0) {
    Write-Host "Successfully terminated $count AAOS process(es)." -ForegroundColor Green
} else {
    Write-Host "No running AAOS processes found to terminate." -ForegroundColor Gray
}
