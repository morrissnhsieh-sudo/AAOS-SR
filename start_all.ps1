# ==============================================================================
# start_all.ps1
# Starts the AAOS (Autonomous Agent Orchestration System) components.
# ==============================================================================

Write-Host "Starting AAOS Gateway and Agents..." -ForegroundColor Cyan

# Define the project root directory
$PROJECT_ROOT = $PSScriptRoot

# Function to start a service in a new PowerShell window
function Start-ServiceWindow {
    param (
        [string]$Title,
        [string]$Command
    )
    Write-Host "Starting $($Title)..." -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = '$Title'; cd $PROJECT_ROOT; $Command"
}

# --- Vertex AI Configuration (override any stale session env vars) ---
$env:VERTEX_PROJECT_ID = "d-sxd110x-ssd1-cdl"
$env:VERTEX_LOCATION   = "us-central1"
$env:VERTEX_MODEL      = "gemini-2.0-flash"

# 1. Start the main AAOS Gateway
# This requires an entrypoint which orchestrates the channel, heartbeat, memory, and plugins.
Start-ServiceWindow -Title "AAOS Gateway" -Command "npx tsx src/index.ts"

# Wait a moment to ensure the gateway's MCP and WebSocket servers are up
Start-Sleep -Seconds 3

# 2. Start a Remote Node Agent (Multi-node deployment)
# Nodes connect to the gateway via WebSocket to receive dispatched tasks.
Start-ServiceWindow -Title "AAOS Remote Node 1" -Command "npx tsx src/nodes/node_agent_cli.ts --id node-1"
Start-ServiceWindow -Title "AAOS Remote Node 2" -Command "npx tsx src/nodes/node_agent_cli.ts --id node-2"

Write-Host "All basic services have been launched in separate windows." -ForegroundColor Green
Write-Host "Note: Ensure you have run 'npm install' beforehand." -ForegroundColor Gray
