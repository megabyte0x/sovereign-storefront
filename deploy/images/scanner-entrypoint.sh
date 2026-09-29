#!/bin/sh
# The scanner binds scanner.sock inside .{config}.live-state next to the config
# file. Both the scanner and the seller mount scanner-state at
# /var/lib/ssf/scanner, so this symlink on the shared ssf-run volume resolves
# in the seller namespace. Do not point it at a volume the seller does not mount.
set -eu
ln -sfn /var/lib/ssf/scanner/.scanner.json.live-state /run/ssf/live
exec /usr/local/bin/scanner serve --config /var/lib/ssf/scanner/scanner.json
