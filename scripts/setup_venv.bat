@echo off
REM =========================================================
REM  MCQ Agent — venv setup script (Windows Command Prompt)
REM  Safe to re-run: skips steps that are already done.
REM =========================================================

setlocal EnableDelayedExpansion

echo.
echo ================================================================
echo   MCQ Agent — Environment Setup
echo ================================================================

REM ── Step 0: Check Python ─────────────────────────────────────────

echo.
echo ^>^> Checking Python version
python --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo    ERR  Python not found. Install Python 3.10+ from https://python.org
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo    OK   Found Python %PYVER%

REM ── Step 1: Create venv ──────────────────────────────────────────

echo.
echo ^>^> Creating virtual environment (.venv)
if exist ".venv\" (
    echo    !!   .venv already exists -- skipping creation
) else (
    python -m venv .venv
    if %ERRORLEVEL% neq 0 (
        echo    ERR  Failed to create venv
        exit /b 1
    )
    echo    OK   Virtual environment created
)

REM ── Step 2: Upgrade pip ──────────────────────────────────────────

echo.
echo ^>^> Upgrading pip
.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
echo    OK   pip upgraded

REM ── Step 3: Install dependencies ─────────────────────────────────

echo.
echo ^>^> Installing dependencies from requirements.txt
if not exist "requirements.txt" (
    echo    ERR  requirements.txt not found. Run this script from mcq_pipeline\
    exit /b 1
)
.venv\Scripts\pip.exe install -r requirements.txt --quiet
if %ERRORLEVEL% neq 0 (
    echo    ERR  pip install failed
    exit /b 1
)
echo    OK   Dependencies installed

REM ── Step 4: Install mcq-agent package ────────────────────────────

echo.
echo ^>^> Installing mcq-agent package (editable)
.venv\Scripts\pip.exe install -e . --quiet
if %ERRORLEVEL% neq 0 (
    echo    ERR  Package install failed
    exit /b 1
)
echo    OK   mcq-agent installed

REM ── Step 5: Set up .env ──────────────────────────────────────────

echo.
echo ^>^> Setting up .env
if exist ".env" (
    echo    !!   .env already exists -- not overwriting
) else if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo    OK   .env created from .env.example
    echo    !!   ACTION REQUIRED: Open .env and fill in your API key(s)
) else (
    echo    !!   .env.example not found -- create .env manually
)

REM ── Step 6: Create directories ────────────────────────────────────

echo.
echo ^>^> Creating output\ and logs\ directories
if not exist "output\" (
    mkdir output
    echo    OK   Created output\
) else (
    echo    OK   output\ already exists
)
if not exist "logs\" (
    mkdir logs
    echo    OK   Created logs\
) else (
    echo    OK   logs\ already exists
)

REM ── Step 7: Smoke tests ───────────────────────────────────────────

echo.
echo ^>^> Running smoke tests (offline -- no API calls)
if exist ".venv\Scripts\pytest.exe" (
    .venv\Scripts\pytest.exe tests\ -v --tb=short
    if %ERRORLEVEL% neq 0 (
        echo    !!   Some smoke tests failed -- see output above
    ) else (
        echo    OK   All smoke tests passed
    )
) else (
    echo    !!   pytest not found -- skipping smoke tests
)

REM ── Done ─────────────────────────────────────────────────────────

echo.
echo ================================================================
echo   Setup complete!
echo ================================================================
echo.
echo   To activate the environment:
echo     .venv\Scripts\activate.bat
echo.
echo   Quick test run:
echo     mcq-agent generate examples\sample_lesson.md --count 3
echo.
echo   REMINDER: Make sure .env has a real API key before running.
echo.

endlocal
