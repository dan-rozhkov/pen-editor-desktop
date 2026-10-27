#!/bin/zsh
export PATH=/Users/daniilrozhkov/.local/bin:/opt/homebrew/bin:/usr/bin:/bin
export HOME=/Users/daniilrozhkov
cd /Users/daniilrozhkov/prj/pen-editor-app
claude auth status 2>&1 | grep -E '"(loggedIn|authMethod)"'
claude -p 'Reply with the single word PONG.' --permission-mode auto 2>&1 | tail -2
