---
name: perf-measure
description: Performance measurement for Seance's animation and rendering cost (the ps scene, any CSS/SVG/canvas animation, glass/blur) on the iPhone, Android and Chrome. Use before deploying or claiming a perf change, when choosing between two ways to animate something, or when a scene feels heavy or a number regressed. Not for IRC-layer logic or bundle size.
---

# Measuring Seance performance

Learned on ps NG; the spec `docs/projects/ps-ng.md` (§8–§11) holds every reading. Each step's _why_ is a wrong conclusion drawn once.

## Procedure

1. **Gate the host.** `sysctl -n vm.loadavg`, then build nothing and run no mocha until the run ends. Each script gates on its own: `run-chrome.mjs` waits up to 2 min for a 1-min load under 2.5 (`MAXLOAD`) and then runs anyway, `droid-plan3.sh` waits up to 2 h and then skips (exit 3), and `ios-run.sh` does not gate. All three record the load per slot. This Mac idles at 5–14 on 12 cores, so the 2.5 gate rarely opens: raise `MAXLOAD=` only when the report says so (Chrome and the emulator rank only anyway). An iPhone figure is quotable only from slots under a load of ~15 (§11.6's layers at 10–37 were rank only). Android also needs a cold-booted emulator with 4 GB (`-no-snapshot-load -gpu auto -memory 4096`: the AVD's own 2 GB sits at 400–800 MB of zram swap after boot), so the script's gate (an `am kill-all`, then guest swap under 50 MB and MemAvailable over 600 MB) can open; keep `MAXSWAP` at 50 (the 4 GB run of 2026-10-16 held 1–19 MB). Done when the report can name, per script, the gate it ran under and each slot's load.
2. **Write the A/B as variants**, one change each (hidden / frozen / on), as `lib.mjs` `VARIANTS` entries with an `&x=` switch rather than an edited build, each with an `ok(beacon)` that proves it applied (e.g. the right animation names). Put coffee (the floor, ~1) and the last known-good build in the same sitting: readings from other sittings were taken at other loads. Done when the slot list holds the variants, coffee and the baseline. _Why: a cause named without an isolating run was wrong both times (a 6×5 tiling, the clip)._
3. **Prove the variants in Chrome**: `node run-chrome.mjs <rounds> [label regex] > chrome-x.jsonl`. Done when every slot's `ok()` passes. Phone time is spent only after this.
4. **Screenshot each device with the scene on it.** Done when the scene is visible in the screenshot. _Why: the canvas fire was once "measured" behind an opaque navy `#viewport`, where every variant is free._
5. **Run every platform the change touches**, n ≥ 2 rounds (the scripts rotate slots by 3 each round). Chrome ranks; its numbers do not transfer: `steps()` saves compositing in Chrome and costs WebContent in WebKit (§2, §11.2), WebKit repainted a moved SVG sprite (the wing strips, 2026-10-08, not in the spec), and a paused animation still costs backboardd on iOS (§8.1). Done when each platform has n ≥ 2 valid readings per slot from rotated rounds (a copied script keeps the rotation).
6. **Read the sum, quote or rank.** On iOS the cost is **WebContent + GPU + backboardd**, as % of one core: work moves between the three, so a drop in one and a rise in another is no win. Quote a number only when its readings agree within a few points at a low load; otherwise call it _rank only_. Done when every figure in the report is a median with its IQR or marked rank only.
7. **Bisect by commit when a number regresses**: build each suspect commit, same slots, same sitting. Done when one commit owns the regression. _Why: plan 5's 60-point dusk regression was `65bf63c7`, found in three runs; the prime suspect (`overflow: clip`) was innocent._
8. **End a phone run visibly**: `xcrun devicectl device process launch --device <UDID> com.apple.Preferences`, or stop `serve.py`. The harness page looks the same mid-run and after; the user reads the switch as "done".
9. **Record, then deploy.** Add a §11.x to `docs/projects/ps-ng.md` (§11.4 style: the slots, rounds, load and pinned moments, a table, then what it rules out). A change goes to `preview` only after this.

## What is cheap and what is not (iPhone 16)

- **Cheap**: compositor-only `transform`/`opacity` CSS animations with every animated box within the viewport. 1 to 12 tiled layers add about +2 to +4, all backboardd (§2, §11.6). Giant strips cost GPU memory on mobile (the spike's rule of thumb, not measured).
- **Free**: a _still_ scene, ~1–2 (coffee ≈ 1). Hidden, unattended, query and reduced-motion states get no animation object at all, never `pause()`: a paused-but-present scene read 19.1 against 1.1 (§8.1).
- **Dear**: the animated `feTurbulence` filter, ~285 % of a core on its own (the old sun, §11.6); WebGL 48–70; SVG attribute (SMIL) animation; `steps()` in WebKit, +4–6 WebContent; the skeins' ~196 nested animations (§10.1, §10.6).
- **Per moving cloud** in calm, backboardd pays about 4 at noon and 2 in a storm (§11.4).
- **Chrome only**: one animation per raindrop is one layer each; three rain sheets took 28–35 to 20–24 (PR #98, closed, never measured on a phone).

## The harness (`tmp/perf/ng2/`, gitignored)

If it is gone, rebuild it in this shape; the method is the point.

- `app/` is a production `public/` plus `spike.js`, a timed playlist player: `?plan=a~b&t0=&dwell=`, `&x=` CSS switches, `&g=` groups, `&at=` a pinned clock. `./refresh-app.sh` rebuilds it from its `WT` worktree and rsyncs (keeps `spike.js`). `serve.py` serves it on 8113 with `no-store`, plus the ircd forward on 8068.
- `lib.mjs` holds `VARIANTS` (label → query + `ok`), the pinned moments (`MOMENTS`: noon, night, dusk, rain, storm) and slot lists (`GATE5`, `PLAN2`…). `ios-run.sh` takes `SLOTS="a b"` or `SHORT=<name>` from its own `WANT` lists, so a new list goes in both files; `DRYRUN=1` prints the plan and duration.
- **iPhone**: USB for xctrace (over Wi-Fi it does not work) and the Mac's Wi-Fi for the page; unlocked, Auto-Lock Never, on the charger. `ios-run.sh [rounds]` (55 s a slot) records 15 s of Activity Monitor inside each slot and refuses to start without `serve.py` and the ircd forward. `node summarize.mjs ios ios-2.jsonl <rid>` prints the table.
- **Android**: `nohup ~/Library/Android/sdk/emulator/emulator -avd seance-android -no-snapshot-load -gpu auto -memory 4096 & disown`, then `adb reverse tcp:8113 tcp:8113` and `tcp:8068`; `droid-plan3.sh [rounds]` on the emulator's Chrome, rank only (`top` per process; the sum is Chrome's processes + surfaceflinger). Use the SDK's `adb` (`~/Library/Android/sdk/platform-tools/adb`); Homebrew's hangs. To profile inside, build release with `webContentsDebuggingEnabled: true` in `capacitor.config.ts`'s android block, signed with the release key so it installs over, and revert the config after.
