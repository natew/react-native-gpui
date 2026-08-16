#!/bin/zsh
# Measure the resident memory of ONE rngpui-service, honestly and reproducibly.
#
#   usage: measure-footprint.sh <label> <cwd> <command...>
#
#   ts:  ./scripts/measure-footprint.sh floor . \
#          node scripts/run-hermes-example.mjs examples/minimal-one-view.tsx
#   gui: ./scripts/measure-footprint.sh controlroom ~/team-machine/gui \
#          node native-shell/scripts/run-hermes-fixture.mjs native-shell/app.tsx
#
# METRIC: phys_footprint, from `vmmap -summary`. This is Apple's own accounting and
# what Activity Monitor's Memory column shows. Two reasons not to use an RSS sum:
# it counts shared framework pages once per process that maps them, and it misses
# the IOKit graphics allocations (IOSurface, IOAccelerator) that dominate this app
# after first paint. RSS is printed alongside only so the gap is visible.
#
# CONTROLS THAT MATTER:
#   * window forced to 1360x880. IOSurface is a per-full-resolution backing store
#     (~19.1 MB at this size on a 2x display), so a footprint taken at another
#     window size is not comparable to any other number here.
#   * busiest of three samples, because one sample routinely catches a process
#     between phases and reads a committed one as small.
#   * measured AFTER a settle delay: first paint is what buys the graphics
#     allocations, so an early sample reports a floor that has not happened yet.
#   * the user's GUI (/tmp/agentbus-gpui-user.pid) is excluded BY PID and never
#     sampled. It is a full ControlRoom holding the user's own state, so counting
#     it as a baseline would silently inflate every number here.
set -u
LABEL=${1:?usage: measure-footprint.sh <label> <cwd> <command...>}
WORKDIR=${2:?usage: measure-footprint.sh <label> <cwd> <command...>}
shift 2
(($# > 0)) || { print "usage: measure-footprint.sh <label> <cwd> <command...>"; exit 2 }

cd "$WORKDIR" || exit 2
USER_GUI_PID=$(cat /tmp/agentbus-gpui-user.pid 2>/dev/null || print 0)

RNGPUI_NO_ACTIVATE=1 \
RNGPUI_WINDOW_SIZE=1360,880 \
RNGPUI_FONT_DIR=${RNGPUI_FONT_DIR:-$HOME/team-machine/gui/native-shell/fonts} \
RNGPUI_EXAMPLE_TIMEOUT_MS=90000 \
AGENTBUS_FIXTURE_ONLY=${AGENTBUS_FIXTURE_ONLY:-1} \
"$@" >/dev/null 2>&1 &
runner=$!

svc=""
for i in {1..100}; do
  svc=$(ps -eo pid,ppid,args | awk -v r=$runner -v u="$USER_GUI_PID" \
        '$2==r && $0 ~ /rngpui-service/ && $1!=u {print $1; exit}')
  [[ -n "$svc" ]] && break
  sleep 0.5
done
if [[ -z "$svc" ]]; then
  print "MEASURE_FAIL no service process for: $*"
  kill $runner 2>/dev/null
  exit 1
fi
if [[ "$svc" == "$USER_GUI_PID" ]]; then
  print "MEASURE_FAIL refusing to sample the user's GUI (pid $svc)"
  kill $runner 2>/dev/null
  exit 1
fi

sleep 12   # settle: let first paint and steady state happen

best=0
for i in 1 2 3; do
  mb=$(vmmap -summary "$svc" 2>/dev/null | awk '/Physical footprint:/ {print $3; exit}' | sed 's/M$//')
  [[ -z "$mb" ]] && mb=0
  best=$(python3 -c "print(max(float('$best'), float('$mb')))")
  sleep 2
done

iosurface=$(vmmap -summary "$svc" 2>/dev/null | awk '/^IOSurface/ {print $3; exit}')
peak=$(vmmap -summary "$svc" 2>/dev/null | awk '/Physical footprint \(peak\)/ {print $4; exit}')
rss_kb=$(ps -o rss= -p "$svc" 2>/dev/null | tr -d ' ')

print "LABEL=$LABEL pid=$svc"
print "PHYS_FOOTPRINT_MB=$best  (peak $peak)"
print "RSS_MB=$(python3 -c "print(round(${rss_kb:-0}/1024,1))")"
print "IOSurface=$iosurface"

kill $runner 2>/dev/null
sleep 1
kill $svc 2>/dev/null
