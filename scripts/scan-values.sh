#!/usr/bin/env bash
# Fails when a tracked file contains something that looks like a secret value (Stripe key, private key block, GitHub token).
# Used by CI and by `pnpm run verify`. Secret-looking fixtures are assembled at run time in tests, never written as literals
# (see CONTRIBUTING.md).
set -u
cd "$(dirname "$0")/.."
pattern='(sk_(live|test)_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'
# grep exits 0 on a match, 1 on none, 2 on an error: only 1 is a pass.
git ls-files -z | xargs -0 grep -nE "$pattern"
case $? in
  1) exit 0 ;;
  0) echo "Possible secret value in a tracked file (see above). Assemble fixtures at run time, see CONTRIBUTING.md." >&2; exit 1 ;;
  *) echo "scan-values: the scan itself failed" >&2; exit 2 ;;
esac
