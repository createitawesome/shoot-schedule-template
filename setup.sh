#!/usr/bin/env bash
# setup.sh — Link this repo into Claude Code's skills directory.
#
# Claude Code discovers skills via ~/.claude/skills/<name>. Run this once
# after cloning to create that symlink pointing back at this checkout.
#
# Usage: ./setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"
LINK_PATH="$SKILLS_DIR/shoot-schedule-template"

mkdir -p "$SKILLS_DIR"

if [ -L "$LINK_PATH" ]; then
  EXISTING_TARGET="$(readlink "$LINK_PATH")"
  if [ "$EXISTING_TARGET" = "$REPO_DIR" ]; then
    echo "Already linked: $LINK_PATH -> $REPO_DIR"
    exit 0
  fi
  echo "ERROR: $LINK_PATH already links elsewhere ($EXISTING_TARGET)."
  echo "Remove it manually first if you want it to point here: rm \"$LINK_PATH\""
  exit 1
elif [ -e "$LINK_PATH" ]; then
  echo "ERROR: $LINK_PATH exists and is not a symlink. Move it aside first."
  exit 1
fi

ln -s "$REPO_DIR" "$LINK_PATH"
echo "Linked: $LINK_PATH -> $REPO_DIR"
echo
echo "Next: ask Claude Code to \"set up my shoot calendar\" to start the"
echo "onboarding flow (adds your first team and asks how you want the"
echo "calendar delivered)."
