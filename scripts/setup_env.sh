#!/usr/bin/env bash
# ============================================================
#  MCQ Agent — environment setup for Mac / Linux (Anaconda)
#  Run from project root:
#      bash scripts/setup_env.sh
# ============================================================
set -e

echo ""
echo "[1/4] Creating Anaconda environment 'mcq_env' with Python 3.11..."
conda create -n mcq_env python=3.11 -y

echo ""
echo "[2/4] Activating mcq_env..."
# Source conda for non-interactive shells
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate mcq_env

echo ""
echo "[3/4] Installing dependencies from requirements.txt..."
pip install -r requirements.txt

echo ""
echo "[4/4] Installing the project package in editable mode..."
pip install -e .

echo ""
echo "====================================================="
echo " Setup complete!"
echo " To use this environment in future sessions:"
echo "     conda activate mcq_env"
echo " Then run:"
echo "     mcq-agent generate --input examples/sample_lesson.md"
echo "====================================================="
