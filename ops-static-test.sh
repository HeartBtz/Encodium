#!/usr/bin/env bash
# Read-only checks. Never source or execute the installer/deployment helpers.
set -euo pipefail
cd "${1:-$(dirname "${BASH_SOURCE[0]}")}"

require() { grep -Eq -- "$1" "$2" || {
	printf 'Missing contract: %s (%s)\n' "$1" "$2" >&2
	exit 1
}; }
reject() { if grep -Eq -- "$1" "$2"; then
	printf 'Unsafe contract: %s (%s)\n' "$1" "$2" >&2
	exit 1
fi; }

for file in install.sh deploy/encodium-deploy deploy/encodium-ci-receiver scripts/install*; do
	[[ -f "$file" ]] || continue
	bash -n "$file"
done
reject '(^deploy[-_]|stage: *deploy|root@|^[[:space:]]*- (ssh|scp|rsync) )' .gitlab-ci.yml
require 'git archive --format=tar.gz' .gitlab-ci.yml
require 'bash ops-static-test.sh' .gitlab-ci.yml
require 'npm ci --omit=dev --ignore-scripts' install.sh
require 'EUID != 0' install.sh
require 'Existing .env preserved' install.sh
require 'Provide ADMIN_PASS through the environment' install.sh
reject 'source .*\.env|killall|kill -9|chmod 777|echo.*INSTALL_ADMIN_PASS' install.sh
require "require\('dotenv'\).config" db.js
require 'User=\$RUN_USER' install.sh
require 'RUN_USER="\$\(whoami\)"' install.sh
require 'runuser -u plex -- test -r' deploy/encodium-deploy
require 'chmod 755 "\$staging"' deploy/encodium-deploy
require '--exclude=.env --exclude=data' deploy/encodium-deploy
printf 'Encodium ops static contracts: PASS\n'
