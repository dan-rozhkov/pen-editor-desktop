#!/bin/zsh
# Runs the three nightly jobs one after another, each as a fresh headless Claude session.
set -u
export PATH=/Users/daniilrozhkov/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export HOME=/Users/daniilrozhkov
D=/Users/daniilrozhkov/prj/pen-editor-app
N=$D/bench/nightly
LOG=$N/logs/$(date +%Y%m%d-%H%M)
mkdir -p "$LOG"
cd "$D" || exit 1
for i in 1 2 3; do
  echo "== job $i start $(date)" >> "$LOG/run.log"
  caffeinate -i claude -p "$(cat "$N/prompt-$i.md")" --permission-mode auto --output-format stream-json --verbose > "$LOG/job-$i.jsonl" 2> "$LOG/job-$i.err"
  echo "== job $i exit $? $(date)" >> "$LOG/run.log"
done
echo "== all done $(date)" >> "$LOG/run.log"
launchctl bootout "gui/$(id -u)/com.daniil.pen-nightly" 2>/dev/null
