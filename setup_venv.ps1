#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up the MCQ Agent Python virtual environment from scratch.
.DESCRIPTION
    Creates .venv, installs all dependencies, copies .env template,
    creates output/logs directories, and runs smoke tests.
    Safe to re-run — will skip steps that are already done.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ─────────────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Message)
    Write-Host "`n>> $Message" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$Message)
    Write-Host "   OK  $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "   !!  $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  ERR  $Message" -ForegroundColor Red
}

# ── Step 0: Check Python version ────────────────────────────────────────────

Write-Step "Checking Python version"

try {
    $pythonVersion = python --version 2>&1
} catch {
    Write-Fail "Python not found. Install Python 3.10+ from https://python.org and try again."
    exit 1
}

$versionMatch = $pythonVersion -match "Python (\d+)\.(\d+)"
if (-not $versionMatch) {
    Write-Fail "Could not parse Python version: $pythonVersion"
    exit 1
}

$major = [int]$Matches[1]
$minor = [int]$Matches[2]

if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
    Write-Fail "Python 3.10+ required; found $pythonVersion"
    exit 1
}

Write-OK "Found $pythonVersion"

# ── Step 1: Create virtual environment ──────────────────────────────────────

Write-Step "Creating virtual environment (.venv)"

if (Test-Path ".venv") {
    Write-Warn ".venv already exists — skipping creation"
} else {
    python -m venv .venv
    Write-OK "Virtual environment created at .venv\"
}

# ── Step 2: Resolve pip/python inside venv ──────────────────────────────────

$venvPython = ".\.venv\Scripts\python.exe"
$venvPip    = ".\.venv\Scripts\pip.exe"

if (-not (Test-Path $venvPython)) {
    Write-Fail "venv python not found at $venvPython — venv may be corrupt. Delete .venv and re-run."
    exit 1
}

# ── Step 3: Upgrade pip ─────────────────────────────────────────────────────

Write-Step "Upgrading pip"
& $venvPython -m pip install --upgrade pip --quiet
Write-OK "pip upgraded"

# ── Step 4: Install dependencies ────────────────────────────────────────────

Write-Step "Installing dependencies from requirements.txt"

if (-not (Test-Path "requirements.txt")) {
    Write-Fail "requirements.txt not found. Are you in the mcq_pipeline directory?"
    exit 1
}

& $venvPip install -r requirements.txt --quiet
Write-OK "Dependencies installed"

# ── Step 5: Install the mcq-agent package (editable) ────────────────────────

Write-Step "Installing mcq-agent package in editable mode"

if (-not (Test-Path "pyproject.toml")) {
    Write-Fail "pyproject.toml not found. Are you in the mcq_pipeline directory?"
    exit 1
}

& $venvPip install -e . --quiet
Write-OK "mcq-agent installed (editable)"

# ── Step 6: Set up .env ─────────────────────────────────────────────────────

Write-Step "Setting up .env file"

if (Test-Path ".env") {
    Write-Warn ".env already exists — not overwriting. Edit it manually if needed."
} elseif (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-OK ".env created from .env.example"
    Write-Warn "ACTION REQUIRED: Open .env and fill in your API key(s) before generating questions."
} else {
    Write-Warn ".env.example not found — skipping .env creation. Create .env manually."
}

# ── Step 7: Create output directories ───────────────────────────────────────

Write-Step "Creating output/ and logs/ directories"

foreach ($dir in @("output", "logs")) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
        Write-OK "Created $dir\"
    } else {
        Write-OK "$dir\ already exists"
    }
}

# ── Step 8: Run smoke tests ─────────────────────────────────────────────────

Write-Step "Running smoke tests (offline — no API calls)"

$pytestPath = ".\.venv\Scripts\pytest.exe"

if (Test-Path $pytestPath) {
    $result = & $pytestPath tests/ -v --tb=short 2>&1
    $exitCode = $LASTEXITCODE

    $result | ForEach-Object { Write-Host "   $_" }

    if ($exitCode -eq 0) {
        Write-OK "All smoke tests passed"
    } else {
        Write-Warn "Some smoke tests failed. Check the output above."
        Write-Warn "This may be OK if the tests require a network or have optional deps."
    }
} else {
    Write-Warn "pytest not found at $pytestPath — skipping smoke tests"
}

# ── Done ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To activate the environment in a new terminal:"
Write-Host "    .\.venv\Scripts\Activate.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Quick sanity check:"
Write-Host "    mcq-agent generate examples/sample_lesson.md --count 3" -ForegroundColor Yellow
Write-Host ""

if (-not ((Get-Content ".env" -Raw) -match "sk-or-[A-Za-z0-9]|sk-ant-[A-Za-z0-9]|gsk_[A-Za-z0-9]")) {
    Write-Host "  REMINDER: .env still has placeholder keys." -ForegroundColor Red
    Write-Host "  Edit .env and add your real API key before running the pipeline." -ForegroundColor Red
    Write-Host ""
}
