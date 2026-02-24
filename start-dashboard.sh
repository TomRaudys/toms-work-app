#!/bin/bash
# Load fnm environment if available
export PATH="/Users/tomraudys/.fnm:$PATH"
eval "$(fnm env --shell bash 2>/dev/null)" || true

# Fallback to known node path
if ! command -v node &>/dev/null; then
  export PATH="/Users/tomraudys/.fnm/node-versions/v24.13.1/installation/bin:$PATH"
fi

cd /Users/tomraudys/Documents/GitHub/toms-work-app
exec node server.js
