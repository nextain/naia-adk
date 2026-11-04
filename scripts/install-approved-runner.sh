#!/bin/bash
# Human-only one-time installation. Never run as an AI work step.
set -euo pipefail
# Deliberately unconditional: a config file is not an authenticated issuer.
# Re-enable only in the issuer PR with verified identity, consent and staging tests.
echo 'Installation refused: Discord issuer is not implemented. Issuer configuration and acceptance are required in the next PR.' >&2
exit 1

if [[ $EUID != 0 || $# != 2 ]]; then
  echo 'Usage (as root): install-approved-runner.sh ACCOUNT ROLES_FILE' >&2
  exit 1
fi
account=$1
roles_file=$2
[[ $account =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || { echo 'Invalid account' >&2; exit 1; }
/usr/bin/id "$account" >/dev/null
# Check existing ancestors before install can follow or modify any destination.
/usr/bin/env -i /usr/bin/node --input-type=module -e '
import fs from "node:fs";import path from "node:path";
for(const target of process.argv.slice(1)) {
 let current="/";
 for(const part of target.split("/").filter(Boolean)) {
  current=path.join(current,part);
  let st;
  try { st=fs.lstatSync(current); } catch(error) { if(error.code==="ENOENT")break; throw error; }
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022))throw Error("Untrusted destination ancestor: "+current);
 }
}' /usr/local/libexec /etc/sudoers.d /var/lib
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# Refuse overwrite; preserve any existing installation for explicit human review.
for target in /usr/local/libexec/naia-approved-run /usr/local/libexec/naia-approved-runner.mjs /etc/naia-approved-runner /var/lib/naia-approved-runner /etc/sudoers.d/naia-approved-runner; do
  [[ ! -e $target && ! -L $target ]] || { echo "Already exists: $target" >&2; exit 1; }
done
/usr/bin/env -i /usr/bin/node --input-type=module -e 'import fs from "node:fs";import {pathToFileURL} from "node:url";const {parseRoles}=await import(pathToFileURL(process.argv[2]));parseRoles(fs.readFileSync(process.argv[1]))' "$roles_file" "$source_dir/approved-root-runner.mjs"
/usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec
/usr/bin/install -d -o root -g root -m 0700 /etc/naia-approved-runner /var/lib/naia-approved-runner /var/lib/naia-approved-runner/used /var/lib/naia-approved-runner/audit
/usr/bin/install -o root -g root -m 0600 "$roles_file" /etc/naia-approved-runner/roles.json
/usr/bin/install -o root -g root -m 0644 "$source_dir/approved-root-runner.mjs" /usr/local/libexec/naia-approved-runner.mjs
# The shell wrapper clears interpreter-affecting environment before Node starts.
cat > /usr/local/libexec/naia-approved-run <<'WRAPPER'
#!/bin/sh
[ "$#" -eq 0 ] || exit 1
exec /usr/bin/env -i SUDO_UID="$SUDO_UID" /usr/bin/node /usr/local/libexec/naia-approved-runner.mjs
WRAPPER
/bin/chown root:root /usr/local/libexec/naia-approved-run
/bin/chmod 0755 /usr/local/libexec/naia-approved-run
# NOSETENV and fixed empty argument match apply to this one entrypoint only.
sudoers_stage=$(/usr/bin/mktemp /etc/sudoers.d/.naia-approved-runner.XXXXXXXX)
trap '/bin/rm -f -- "$sudoers_stage"' EXIT
printf '%s ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/naia-approved-run ""\n' "$account" > "$sudoers_stage"
/bin/chown root:root "$sudoers_stage"
/bin/chmod 0440 "$sudoers_stage"
/usr/sbin/visudo -cf "$sudoers_stage"
/bin/mv -T -- "$sudoers_stage" /etc/sudoers.d/naia-approved-runner
