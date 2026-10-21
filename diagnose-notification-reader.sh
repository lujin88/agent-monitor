#!/bin/bash
# Read-only diagnosis for "Agent Monitor Notifications.app" reporting full_disk_access_required.
#
#   bash ~/agent-monitor/diagnose-notification-reader.sh
#
# It does NOT open the notification database, read the TCC database, change any
# permission, start or stop any process, or print notification content or keys.
# It only inspects: the app's code signature, running reader processes and who
# launched them, and whitelisted health fields from the reader's status files.

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Agent Monitor Notifications.app"
BUNDLE_ID="com.lu.agent-monitor.notifications"

echo "=== Agent Monitor notification reader: read-only diagnosis ==="
echo "macOS: $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
echo

echo "--- 1. App bundle and code signature ---"
if [ ! -d "$APP" ]; then
  echo "NOT FOUND: $APP"
  echo "-> Full Disk Access must be granted to this exact app path. Build/copy it there first."
else
  echo "Path: $APP"
  SIG="$(codesign -dv --verbose=2 "$APP" 2>&1)"
  echo "$SIG" | grep -E '^(Identifier|Format|Signature|TeamIdentifier|CDHash)=|flags=' | sed 's/^/  /'
  if echo "$SIG" | grep -q 'Signature=adhoc'; then
    echo "  NOTE: ad-hoc signature. macOS ties the Full Disk Access entry to this exact build."
    echo "        Rebuilding and signing may change the designated identity, so an older"
    echo "        entry in Full Disk Access can stay switched on but no longer match."
  fi
  if echo "$SIG" | grep -q 'not signed'; then
    echo "  NOTE: the app is not signed; macOS privacy grants are unreliable for unsigned apps."
  fi
  BID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null)"
  echo "  Info.plist bundle id: ${BID:-missing}"
  [ "$BID" = "$BUNDLE_ID" ] || echo "  NOTE: expected $BUNDLE_ID; the duplicate-instance check and the grant use the bundle id."
fi
echo

echo "--- 2. Running reader processes (who launched them) ---"
PIDS="$(pgrep -f 'Agent Monitor Notifications.app/Contents/MacOS/' 2>/dev/null)"
if [ -z "$PIDS" ]; then
  echo "No reader process is visible to this diagnostic. Process-list access may be restricted; check the fresh health timestamp below."
else
  for p in $PIDS; do
    PPID_OF="$(ps -o ppid= -p "$p" | tr -d ' ')"
    START="$(ps -o lstart= -p "$p")"
    PARENT="$(ps -o comm= -p "$PPID_OF" 2>/dev/null)"
    echo "  pid $p  started $START  parent pid $PPID_OF ($PARENT)"
    if [ "$PPID_OF" != "1" ]; then
      echo "    NOTE: not launched by launchd. launch ancestry alone cannot establish TCC responsibility"
      echo "          Inspect the current app grant; do not grant extra access to the parent."
    fi
  done
  COUNT="$(echo "$PIDS" | wc -w | tr -d ' ')"
  [ "$COUNT" -gt 1 ] && echo "  NOTE: $COUNT instances. A new launch exits if one is already running, so an"
  [ "$COUNT" -gt 1 ] && echo "        instance started before the permission was granted may still be the one reporting."
fi
echo

echo "--- 3. Reader health files (whitelisted fields only) ---"
for f in notification-reader-status.json notification-reader-probe.json; do
  FILE="$DIR/$f"
  if [ ! -f "$FILE" ]; then echo "$f: not present"; continue; fi
  echo "$f (modified $(stat -f '%Sm' "$FILE" 2>/dev/null || date -r "$FILE")):"
  /usr/bin/env node -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const keys=["status","mode","checkedAt","launchedBy","pid","openErrno","openError","openSQLiteCode","observedSinceLaunch","waitingSinceLaunch","completedSinceLaunch","ignoredSinceLaunch","readerVersion","successfulPolls","matchedAppRecords","matchingNotificationRecords","baselineAt"];
    for(const k of keys) if(r[k]!==undefined) console.log("  "+k+": "+(k==="checkedAt"?new Date(r[k]).toLocaleString()+" ("+Math.round((Date.now()-r[k])/1000)+"s ago)":r[k]));
    if(r.mode==="probe") console.log("  NOTE: written by --probe (often run from Terminal), not by the background app.");
    if(r.openErrno===undefined && r.status==="full_disk_access_required") console.log("  NOTE: written by the previous reader build, which reported every open failure as Full Disk Access.");
  ' "$FILE" 2>/dev/null || echo "  (could not parse; node not found or file malformed)"
done
echo

cat <<'EOF'
--- 4. How to read this ---
openErrno 1  (Operation not permitted) = access denied; privacy restrictions are a possible cause.
openErrno 13 (Permission denied)       = ordinary file permissions, not Full Disk Access.
openErrno 2  (No such file)            = the database path changed on this macOS version.
launchedBy parent-process              = parent PID is not 1; this does not prove TCC responsibility.
status file older than ~10 s           = health is stale; the reader may be stopped or unable to write.

Suggested order (you perform these; nothing here is automatic):
 1. Quit every reader instance (Activity Monitor -> "Agent Monitor Notifications" -> Quit).
 2. System Settings -> Privacy & Security -> Full Disk Access: remove the old
    "Agent Monitor Notifications" entry with "-", then add the current app again with "+".
 3. Start it from Finder (double-click) or: open "$HOME/agent-monitor/Agent Monitor Notifications.app"
    Do not start the binary inside Contents/MacOS from Terminal.
 4. Wait 10 seconds and run this script again.
Do not grant Full Disk Access to Terminal, Node, Python or Claude for this.
EOF
