#!/bin/zsh
# Run a load-bound gate in the first genuinely quiet CPU window.
#
#   usage: quiet-window.sh <min-idle-percent> <max-loadavg> <keep-samples> <command...>
#
#   ts: ./scripts/quiet-window.sh 35 15 3 npm run conformance:input-runtime
#   ts: ./scripts/quiet-window.sh 35 15 3 zsh -c "npm run probe:input-latency; npm run conformance:input-runtime"
#
# WHY NOT LOADAVG: this box is 18 cores, and loadavg has read 30 while `top`
# reported 20-41% idle. It counts runnable and uninterruptible threads, not
# available CPU, so `loadavg < 9` can sit for 45 minutes while a third of the
# machine is idle, and it can also read 8.8 while a cold launch is slow. The
# condition here is sampled CPU idle, taken from the SECOND of two `top -l 2`
# samples (the first covers boot-to-now), with the busiest of the kept samples
# deciding, and it must hold for <keep-samples> consecutive readings.
#
# WHAT A PASS MEANS: a gate run inside the window can still fail, and that is the
# point. The window removes the machine as the explanation for the number, so a
# failure inside it is about the code. The readings are printed on both sides of
# the command, because a window that closed mid-run is visible in the after one.
#
# HOW QUIET IT ACTUALLY GETS: idle has been seen swinging 38% to 4.6% around a
# single fast command, so a long sustained window is rare on this box and asking
# for one mostly buys a timeout. Treat the condition as a least-busy window, not
# an idle machine: what makes a run interpretable is its own two readings, and a
# low <min-idle-percent> with a high <keep-samples> is a worse bet than the
# reverse. Waiters here should be bounded, and a timeout is a result too: it says
# no such window existed, which is the honest reason a load-bound number is
# missing.

set -u
min_idle=${1:?min-idle-percent}; max_load=${2:?max-loadavg}; keep=${3:?keep-samples}; shift 3
(($#)) || { print -u2 "quiet-window.sh: no command given"; exit 2; }

idle_percent() { top -l 2 -n 0 -s 1 2>/dev/null | awk -F, '/^CPU usage/{print $3+0}' | tail -1 }
loadavg_1m() { sysctl -n vm.loadavg | awk '{print $2}' }
reading() { print "idle=$(idle_percent)% loadavg=$(loadavg_1m)" }

streak=0
best_idle=101
best_reading=""
deadline_seconds=${QUIET_WINDOW_DEADLINE_SECONDS:-3600}
deadline=$((SECONDS + deadline_seconds))
while ((SECONDS < deadline)); do
    idle=$(idle_percent)
    load=$(loadavg_1m)
    ((idle < best_idle)) && { best_idle=$idle; best_reading="idle=${idle}% loadavg=${load}"; }
    if (($(printf '%.0f' "$idle") >= min_idle)) && (($(printf '%.0f' "$load") <= max_load)); then
        ((streak++))
    else
        streak=0
    fi
    if ((streak >= keep)); then
        print "QUIET_WINDOW_OPEN $(reading) streak=${streak}"
        "$@"
        rc=$?
        print "QUIET_WINDOW_CLOSE rc=${rc} $(reading)"
        exit $rc
    fi
    sleep 15
done
print "QUIET_WINDOW_TIMEOUT no window of idle>=${min_idle}% loadavg<=${max_load} for ${keep} samples in ${deadline_seconds}s; best was ${best_reading}"
exit 3
