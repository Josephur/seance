---
name: perf-measure
description: Measure and optimise Seance's animation and rendering cost (the ps theme scene, any CSS/SVG/canvas animation, glass/blur) on a real iPhone, Android and Chrome without fooling yourself. Use before claiming a performance win, before deploying a perf change to preview, when picking between two ways to animate something, or when a scene "feels heavy". Not for IRC-layer logic or bundle size.
---

# Measuring Seance performance

Written from ps NG (spec `docs/projects/ps-ng.md` §8–§11, results in §10.6, §11.4 and §11.5). Most rules below exist because a wrong conclusion was drawn once.

## Rules

1. **The scene must be on screen.** An opaque viewport hides it and makes every variant look free (the canvas fire was "measured" behind a solid navy `#viewport`). Screenshot the device first.
2. **iOS: sum WebContent + GPU + backboardd** (Activity Monitor via xctrace), as % of one core. Work moves between the three; one process alone lies. A change that drops WebContent and raises backboardd is not a win.
3. **Measure on every platform the change touches** (iPhone, Android, Chrome) before deploying or reporting. Chrome numbers rank; they do not transfer. `steps()` saves compositing in Chrome but costs WebContent in WebKit (spec §2, §11.2), a moved SVG sprite was repainted in WebKit (the wing-strip measurement of 2026-10-08, recorded in the author's notes, not the spec), and a paused animation still costs backboardd on iOS (§8.1).
4. **A/B before naming a cause.** Change one thing: hidden / frozen / on. Add a switch (`&x=name` in the harness) rather than editing the build. A cause guessed without an isolating run was wrong both times it was tried (a 6×5 tiling, the clip).
5. **Bisect by commit when a number regresses.** Build each suspect commit, run the same slots. Plan 5's 60-point dusk regression was `65bf63c7` (the `.psng-strip` wrapper and its placed pose boxes; which of them was not isolated), found in three runs; the prime suspect (`overflow: clip`) was innocent.
6. **Re-baseline in the same run.** Earlier readings were taken at other host loads, so put coffee (the floor, ~1) and the last known-good build in the same sitting. Plan 5's bisect re-ran `826f8736` (the plan-4 tree with classic deleted) beside the suspects: it read 29.4, close to §10.6's 28.4 from `f0cbbc6a`, which is what made the 14.6 / 43.3 comparison trustworthy.
7. **n ≥ 2 rounds, slots rotated** each round; read the IQR. Quote a number only when its readings agree within a few points; otherwise say "rank only".
8. **Host load:** check `uptime` first. This Mac idles at 5–14; gate at ~10–15, never run builds or mocha during a run, and call a run "rank only" above that. Android emulator: also check swap and `MemAvailable`, cold-boot it.

## What is cheap and what is not (iPhone 16, measured)

- Compositor-only `transform`/`opacity` via CSS animations: cheap when each layer is ≤ the viewport; in the spike, 1 to 12 tiled layers add only +2 to +4 backboardd, WebContent and GPU 0. The absolute level moves between sittings: §2 read 20–21.5 at 1 layer and 23–24.5 at 12; the re-measurement of 2026-10-18 (§11.6) read 13.3 and 15.5–17.1, rank only (load 10–37, slots not rotated).
- Not cheap (measured): SVG attribute (SMIL) animation, the animated feTurbulence filter (the old sun on `upstream/develop` c9a70e1b, noon, classic as shipped: total 392.7, of it WebKit GPU 376, three readings 390.5–392.7; with only the filter removed 108.1; with the whole sun removed 103.4; re-measured 2026-10-18, §11.6), WebGL (48–70), `steps()` in WebKit (+4–6 WebContent), a paused-but-present animation scene (19.1 against 1.1 for none, spec §8.1), and the skeins' ~196 nested animations (§10.1, §10.6). In Chrome, 130 per-drop animations meant 130 layers; 3 rain sheets took the rain from 28–35 to 20–24 (no rain 19–22; PR #98, closed, never measured on a phone).
- Rule of thumb from the spike, not measured on a device: keep every animated box within the viewport (giant strips cost GPU memory on mobile).
- In calm, backboardd pays per moving cloud, but not a fixed amount each (§11.4): at noon five clouds read 31.3 and two 19.3 (about 4 per cloud removed); in a storm nine read 34.2 and two 20.4 (about 2 per cloud removed).
- A *still* scene costs ~1–2 (coffee ≈ 1): the target for hidden, unattended, query and reduced-motion states is no animation object at all, not `pause()`.

## The harness (gitignored, `tmp/perf/ng2/`)

If it is gone, rebuild it from this shape; do not invent a new method.

- `app/` is `tmp/psng`'s production `public/` plus `spike.js` (a timed playlist player: `?plan=a~b&t0=&dwell=`, `&x=` CSS switches, `&g=` groups, `&at=` pinned clock). `./refresh-app.sh` rebuilds and rsyncs it (keeps `spike.js`). `serve.py` serves it on 8113 with `no-store`, plus the ircd forward on 8068.
- `lib.mjs` `VARIANTS` (label → query + `ok(beacon)` that proves the variant actually applied, e.g. the right animation names) and slot lists (`GATE5`, `PLAN2`…) for `run-chrome.mjs`. `ios-run.sh` `SHORT=<name>` picks slots from its own hardcoded `WANT` lists, so a new list goes in both files; `DRYRUN=1` prints the plan. Run `run-chrome.mjs` (a full headless-Chrome measurement, rounds rotated) first to prove every variant's `ok()` passes before spending phone time.
- iPhone: USB, unlocked, Auto-Lock Never, charger; `ios-run.sh <rounds>` (about 55 s a slot) records 15 s of Activity Monitor inside each slot; `node summarize.mjs ios ios-2.jsonl <rid>` prints the table. The dev ircd and `serve.py` must be up (`ios-run.sh` refuses otherwise). Over Wi-Fi xctrace does not work.
- Android: emulator numbers are release-WebView `top` + `gfxinfo` and need a quiet host (swap under 50 MB, MemAvailable over 600 MB, cold boot); profile inside only with a release build that has `webContentsDebuggingEnabled: true` in `capacitor.config.ts`'s android block, signed with the release key so it installs over (revert the config after). Use the SDK's `adb`, not Homebrew's, which hangs.

## Before reporting

- Say which slots, rounds, load and moments (noon/night/dusk/storm are pinned dates in `lib.mjs`).
- Record results in `docs/projects/ps-ng.md` (§11.4 style: table, then what it rules out).
- A change goes to `preview` only after the A/B, not before.
