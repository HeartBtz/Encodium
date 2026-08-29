#!/usr/bin/env bash
set -euo pipefail

npm audit --audit-level=low

if git ls-files \
  | grep -E '(^|/)(\.env($|\.)|id_(rsa|ed25519)$|.*\.pem$|.*\.key$)' \
  | grep -Ev '(^|/)\.env\.example$' \
  | grep -q .; then
  echo "Security check failed: a secret-like file is tracked." >&2
  exit 1
fi

if git grep -IlE -- '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----' -- ':!scripts/security-check.sh' | grep -q .; then
  echo "Security check failed: a private key is present in tracked content." >&2
  exit 1
fi

if git grep -nE 'on(click|load|error|submit)=' -- public | grep -q .; then
  echo "Security check failed: inline event handlers violate the CSP." >&2
  exit 1
fi

if git grep -nE '(events|thumb|stream).*\?token=' -- public routes | grep -q .; then
  echo "Security check failed: an authentication token is exposed in a URL." >&2
  exit 1
fi

while IFS= read -r file; do
  node --check "$file"
done < <(git ls-files '*.js')

echo "Security checks passed."
