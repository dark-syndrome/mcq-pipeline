@echo off
REM ============================================================
REM  MCQ Agent — environment setup for Windows (Anaconda)
REM  Run from project root in Anaconda Prompt:
REM      scripts\setup_env.bat
REM ============================================================

echo.
echo [1/4] Creating Anaconda environment "mcq_env" with Python 3.11...
call conda create -n mcq_env python=3.11 -y
if errorlevel 1 (
    echo Failed to create conda environment. Is Anaconda installed and on PATH?
    exit /b 1
)

echo.
echo [2/4] Activating mcq_env...
call conda activate mcq_env
if errorlevel 1 (
    echo Failed to activate environment.
    exit /b 1
)

echo.
echo [3/4] Installing dependencies from requirements.txt...
pip install -r requirements.txt
if errorlevel 1 (
    echo Dependency installation failed.
    exit /b 1
)

echo.
echo [4/4] Installing the project package in editable mode...
pip install -e .
if errorlevel 1 (
    echo Editable install failed.
    exit /b 1
)

echo.
echo =====================================================
echo  Setup complete!
echo  To use this environment in future sessions:
echo      conda activate mcq_env
echo  Then run:
echo      mcq-agent generate --input examples/sample_lesson.md
echo =====================================================
