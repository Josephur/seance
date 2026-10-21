# The words over the plains: six treatments, one setting

**Status: built, 2026-10-21** (plan 6 of the `ps` theme; `docs/projects/ps-theme.md` §2, §7, §10.4, §11 and §13 record it, with the measured figures). What follows is the design as approved, with the builder check's resolutions (§9) and the figures that came out of the build (§10).

## 1. Intent

People reading the `ps` theme find the words' black outline harsh. It is there for a reason — the calibration showed a soft shadow alone cannot carry white words over the moon's disc or a bright horizon at 4.5 : 1 (ps-theme.md §7, §11) — but the look it makes is the complaint. The user's decision (2026-10-21, after the six mock-ups at https://claude.ai/artifact/UE1sXhfbbzndsgSm6jjoky): **build all six treatments as one theme setting, with Bubbles as the default.**

The treatments, in the setting's order:

| Value     | Name in Settings | What it is                                                                                                                                                                    |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bubbles` | Bubbles          | Every row of the message column on a translucent card: paper tint with ink words by day, dark tint with light words at night. Nothing on the words. **Default.**              |
| `glass`   | Glass            | The whole message column on the chrome's glass: the float tint over a backdrop blur, luminous by day, dark at night. Nothing on the words.                                    |
| `scrim`   | Scrim            | A graded tint across the column, strongest at the near edge and fading toward the far one, no blur. The mock-up's look (§4.3).                                                |
| `outline` | Outline          | What ships today: white words in an eight-way 1 px ring at 78 % black, a 2 px second ring at 28 %, a soft shadow; dark ink in a pale halo inside the ink window (snowy days). |
| `rim`     | Tinted rim       | One 1 px eight-way ring at 60 % in a deep shade of the hour's own sky, the soft shadow in the same tint, no second ring; the ink window unchanged.                            |
| `glow`    | Soft glow        | No ring: four blurred black shadows (0.125 / 0.25 / 0.6 / 1.1 rem at 55 / 50 / 45 / 40 %) under the white words; a wider pale aura under the ink inside the ink window.       |

Two families fall out of that and most of the design follows from it:

- **The surface family** (`bubbles`, `glass`, `scrim`): the words are plain; a _surface_ between them and the plains holds the floor. Which words are ink and which are light is the hour's (`data-ps-light`), as it is for the chrome.
- **The shadow family** (`outline`, `rim`, `glow`): the words carry a text-shadow; the ink window (`data-ps-text`) decides ink or light, as today.

## 2. Goals, non-goals, anti-goals

Goals:

- One setting, six values, Bubbles the default for everyone who has not chosen — including people who already use `ps`.
- Every treatment keeps the theme's own standard where it can: the words held at 4.5 : 1 (solved to 4.6) against the worst ground the scene can put behind them, nicks at 3 : 1 as large text under the light words, exactly as §11 does today. Where a treatment _cannot_ reach that — the rim and the glow over the brightest grounds, the scrim's far side; the user chose them from the pictures — the floor it does reach is computed or measured and pinned, so a regression is caught and §11 says the number.
- The surface family costs nothing per glyph (the outline is nineteen shadows per glyph today); the glass column's blur falls off on the phone layout like the always-on glass does.
- Reduced transparency, reduced motion, high contrast, the private view's frost, the disconnected fade, right-to-left: every treatment behaves under each.

Non-goals:

- No new scene elements, no change to the plains, the chrome's glass or the generated chrome palette.
- No per-treatment re-solve of the shadow family's colours: the outline's solved palette serves all three (§5).
- Not a per-network or per-channel choice; it is a theme setting like the other three.
- No change to the early theme loader: a page whose stored choice is not Bubbles paints Bubbles once and flips when the stored settings apply at boot, exactly as the font-size step and the own-messages style flip today. The default never flashes.

Anti-goals (a failure even if it works):

- A treatment that is legible only because the plains are gone. The glass column is the only one allowed to wash the whole column, and it keeps the scene visible through the tint.
- Cards that cover the column wall to wall. A card hugs its row's content (`width: fit-content`), so the plains show between and beside messages.
- A surface treatment that leaves any piece of the column keyed on the ink window: with ink words beside a dark toolbar the page reads as broken (§4.4).

## 3. The setting

- `settings.ts`: `psWords`, `default: "bubbles"`, `apply` writes `document.documentElement.dataset.psWords = normalizePsWords(value)`, the pattern of `fontSize` and `ownMessages`. `normalizePsWords` and `PS_WORDS` (the six values in the setting's order) live in a Vue-free helper (`client/js/helpers/psWords.ts`), unknown or missing → `bubbles`. No `sync`.
- Settings → Appearance, inside the existing `theme === 'ps'` block, between Scene animation and Message layout: a heading "Words over the plains" and a radio group in the Scene animation's markup (`label.opt` with `opt-hint`), one radio per value with a one-line hint. Labels are literal English on this branch, as the other ps labels are (no translation system here).
- The settings backup already carries `settings`, so the key rides along.
- `ps.css` reads `:root[data-ps-words="…"]`. The Bubbles rules are scoped `:root:is(:not([data-ps-words]), [data-ps-words="bubbles"])`; the other five are scoped by their value. The attribute stays on `<html>` under other themes, which do not read it.

## 4. The surface family

### 4.1 Bubbles

- **The card** is every `.msg` row of the column (messages, notices, actions, joins and parts, modes, topics, condensed rows), plus the column's other standing items: the `.show-more` button, the date marker's and the unread marker's labels (their lines stay), the search view's notes. A row keeps its stacked-row grid and gains `width: fit-content; max-width: 100%`, `border-radius: 0.5rem`, inline padding `0.6rem` inside the card with the column's `0.625rem` gutter outside it as margin, block padding as the row has today, and a `0.125rem` gap to the next row.
- **A run is separate cards**, one per line, as messengers draw consecutive messages (my call; the mock-up drew a run as one card, which the DOM — one `.msg` per line — would make a stepped shape). The continuation row's hidden time still sits in its column inside the card, so the text lines up with the first card's.
- **The message toolbar is anchored to the row's inline-start edge under Bubbles** (`.msg-actions` sits at `right: 0.5rem` of the row today; on a short card that hangs it leftward off the card and `.chat`'s `overflow-x: hidden` clips it). The rows are start-aligned, so the toolbar stands at the column's start over every card; the jump-to-recent column on the right never meets it. The hover area is the card.
- **The fill, by day:** `rgb(255 251 244 / var(--ps-g-tint-card, var(--ps-g-tint-a)))`, the ink of the surface palette (§5). `--ps-g-tint-card` is a new surface of `glass.ts`: solved like the four chrome surfaces each 5-minute step, within 0.40–0.78, over **every** ground (as `float` is), but **flat** — a card has no backdrop filter, so the solve mixes the tint straight over the ground with no brightness lift and no saturate. What it holds is the surface palette's binding pair, fixed as constants the way `DAY_GLASS_TEXT`/`DAY_GLASS_MARK` are: `DAY_CARD_TEXT` (the palette's lightest text, at 4.6) and `DAY_CARD_MARK` (its lightest mark, at 3.1). Published by `publish.ts` by day beside the four, removed at night and on `unpublish`; the mount snapshot test and "destroy leaves nothing" take it.
- **The fill, by night:** `rgb(12 17 32 / var(--ps-s-tint-night))`, a generated value of the surface palette (§5), declared at 0.62 (the mock-up's dark card).
- **No shadow on the words**, no transition of a shadow; the fill and the words flip over `--ps-flip` with the chrome.
- **A mention row** keeps its wash, as the card's fill: `rgb(255 214 230 / <card tint>)` by day, `rgb(40 20 48 / <night tint>)` at night; the generator reads both as grounds of the surface palette, as the floors test reads the mention washes today.
- The reply quote, the reaction chips (glass, float tint), the code box (`--ps-code-bg`), the embers and the pending settle are unchanged; they sit inside or on the card.

### 4.2 Glass

- The glass goes on `#chat .chat-content > .chat` — the message list, a sibling of the user list, so the user list's own blur still sees the scene (the disconnected fade lives on this element already for the same reason). The recipe is the chrome's: `background-color: rgb(255 251 244 / var(--ps-g-tint-float, var(--ps-g-tint-a)))` by day and `rgb(12 17 32 / var(--ps-s-tint-night))` at night, `backdrop-filter: blur(0.625rem) var(--ps-g-lift,) saturate(1.12)`. The float tint is already "every ground, with the lift": no new solve.
- The words take the surface palette (§5); nothing on the words.
- **On the phone layout** the column drops the blur and the lift and takes **the card tint** (`--ps-g-tint-card`), the flat solve proven over every ground without a filter — not `--ps-g-tint-a` as the header does, since the card tint is exactly the unfiltered solve the header lacks. The phone test's list of rules allowed to read a scene tint gains this one. The overlay states (the drawer, the user list over the chat) are unchanged.

### 4.3 Scrim

- **The mock-up's look, kept:** a `linear-gradient` on the same element, no blur, three stops — at the near edge the card tint plus 0.12 (capped 0.85), at 45 % of the width the card tint, at the far edge **0.3 × the card tint** (about 0.2 at the mock-up's 0.66) — paper by day, the dark tint at night, running inline-start → inline-end and mirrored under `[dir="rtl"]` (gradients take no logical direction). The night words carry the mock-up's one faint shadow, `0 0.0625rem 0.125rem rgb(0 0 0 / 30%)`; the day words nothing.
- **Its floor is held over the near 45 % by construction** (the card's flat solve, the same palette) and **computed and pinned over the far half**: the floors test reports the surface palette's worst contrast at the far edge's opacity over every ground and the spec records the figure (a flat tint is arithmetic, no measurement). Words that reach the far side read under the floor — the user chose the picture over the wash, and the glass column is the treatment for a floor everywhere.
- Costs the same everywhere; nothing changes on the phone layout.

### 4.4 All three

- **Everything in the column that keys on the ink window is re-keyed on the hour under the surface family.** Today `:root[data-ps-text="light"] #chat .chat` sets `--window-bg-color`, `--composer-bg`, `--chat-accent-fg` and `--button-text-color-hover` (the message toolbar, the "Copied" note, the link preview, the marker labels), underlines links, and the dark mention wash and the high-contrast reset hang off the same attribute. The scene keeps publishing `data-ps-text` under every treatment, so at a clear noon (text light, light day) Bubbles would put ink words beside a dark toolbar. Under the surface scope every one of those takes `[data-ps-light="night"]` as its key instead, at a specificity above the text-keyed rules; "the message toolbar is solid but follows the column's treatment" becomes "follows the hour" there.
- **Reduced transparency** makes the surface solid (`--ps-g-solid`), in the block that is `ps.css`'s last rule.
- **Without the scene** (chunk still loading, failed, or an older build) there is no `data-ps-light`: the day fills apply at the generated fallback `--ps-g-tint-a`, ink words. Never an unstyled or midnight page.
- **The private view's frost** stays; a card or the column's glass sits over the frosted scene.
- **High contrast** (`data-contrast="more"`) keeps pointing the muted tokens at the full text colour, in the surface palette too.

## 5. The colours

- **A third generated block, `ps:surface-palette`**, written by `tools/ps/palette-blocks.ts` between the glass block and the animals: every token the message column reads (the same list as the message block: body, muted, faint, links, events, notice, action, markers, the code tokens, the `.user.color-N` sweep × 32, and the tokens §4.4 re-keys), solved for day and for night, under `:root:is(:not([data-ps-words]), [data-ps-words="bubbles"], [data-ps-words="glass"], [data-ps-words="scrim"]) #chat .chat` and its `[data-ps-light="night"]` twin, plus `--ps-s-tint-night` on `:root`. The bases are the glass palette's **bases** (its ink, soft, accent, badge and the one nick hue table, before any rule-2 move), so the column on a surface reads as the chrome does.
- **The order that breaks the cycle** (the chrome's own): the generator solves the day palette first at the **declared day card tint 0.66** (the mock-up's), flat, over every ground of the dense sweep, moving only lightness within rule 2's 0.08 — the soft ink will come out darker than the chrome's `#4c5970`, which only holds over the autumn-evening blade above the cap; the message block's `#142747` holds at about 0.47. The two colours that bind become `DAY_CARD_TEXT`/`DAY_CARD_MARK` in `glass.ts`, and the page's per-step solve then finds the lowest tint in 0.40–0.78 that holds them for the moment's grounds; at the declared tint they hold over the worst ground by construction, so the step solve lands at or under 0.66 and the cards look like the mock-up. The glass column's day words are checked at the float tint through the lift as a second surface; the worst of the two binds.
- **Night:** solved at the declared 0.62 over every ground, the night soft and ink re-solved from their bases (not the night glass's rule-2 results, which were moved to hold at 0.74); `solveGlass` raises the tint only when a spec colour cannot hold within rule 2, never above 0.74. The figure it settles on is `--ps-s-tint-night`.
- **The shadow family keeps the message palette as it is**, solved at the outline's measured α (0.6039 → 0.6 capped; halo 0.1614). The rim's and the glow's own strengths are measured by `tools/ps/calibrate.mjs` (extended to read the computed `text-shadow` under each `data-ps-words`, and the rim's target colour from `--ps-rim`), recorded in ps-theme.md §11 and `tools/ps/legibility.ts` (`ALPHA_RIM`, `ALPHA_GLOW`, `ALPHA_GLOW_HALO`). No colour is re-solved for them: under the light treatment they are nearly white already, and the user chose a softer treatment over a stricter floor.
- **What the rim and the glow are held to**, a rule rather than a list: from the measured α, the boundary luminance above which white cannot reach 4.5 : 1 through the layer is computed; every ground below it is held at 4.5 (the sky bands, the land, the river, the yurt's walls at most hours), and over every ground above it — the white day clouds first (`#fffffe`, the light treatment's worst ground today), then the bodies, the low sun's core, the roof's snow and the veiled grounds — the worst figure is pinned to two decimals in the test and recorded in §11. The same for the ink aura inside the ink window against the dark grounds.
- **The rim's colour, `--ps-rim`:** the hour's sky-top (the palette's `skyTop`, what `--canvas-bg-color` is) with its OKLCH lightness scaled by 0.45 and its chroma pulled into gamut, computed in `grounds.ts` beside `haloFor` and published by `publish.ts`; fallback in `ps.css` `#123a6e` (a clear noon's). The generator derives the same value from the palette for the measurement's target.

## 6. Verification

- Mocha: the helper's normaliser; `test/themes/ps.ts` — the outline's shadow list now under its scope, each treatment's rules under theirs and Bubbles as the unscoped default, the card's geometry and the toolbar's anchor, the column's glass naming the float tint, the scrim's three stops and its RTL mirror, the phone rule giving the column the card tint and no blur, reduced transparency covering the three surfaces, the words carrying no shadow in the surface family, every re-keyed token present under the surface scope; `test/scenes/ps/glass.ts` — the card surface's flat solve and `glassVars` with `--ps-g-tint-card`; `test/scenes/psng/mount.ts` — the snapshot and destroy; `test/scenes/ps/grounds.ts` — `rimFor`; `test/scenes/ps/legibility.ts` — the surface block read in full, its floors at the scene's card tints and at the generated night tint over the sparse sweep and the pinned moments, the mention washes on the surfaces, the scrim's far-edge figure, the rim's and the glow's pinned floors by the luminance rule.
- Browser: `tools/scenarios/ps-scene-settings.mjs` — the setting's default, each choice through the Settings radio sets the attribute and the rule that proves it (a card's background and the toolbar's place on a row, the column's `backdrop-filter`, the gradient, each shadow shape); `tools/scenarios/theme-ps.mjs` — screenshots of the six at noon and at midnight, and the glyph samples run under the rim and the glow at the six pinned moments, their figures reported against the pinned floors.
- `tools/ps/calibrate.mjs` run once on a production build for the rim's and the glow's α; the numbers go into the spec and the tests by hand, as the outline's did.
- The glass column's cost measured on this host the way §10.1 measured the chrome's (busy % with the scene in motion, desktop and the phone layout), recorded in §10.1.

## 7. Documentation

- `docs/projects/ps-theme.md`: a §2 row for the decision, §7 rewritten around the six, §10.4 the setting, §11 the surface palette, the scrim's far-edge figure and the two measured floors, §13 "Plan 6, the words" with its known items.
- `docs/resources/themes.md`'s ps section and `CLAUDE.md`'s ps paragraph: the words sentence and the settings sentence.
- The mock-up canvas stays the design record of the look.

## 8. Left to the builder

- The exact card padding, radius and gap, and the marker labels' pills, judged in the browser against the mock-up (the numbers in §4.1 are the starting point).
- Whether the condensed summary row and the topic row read better with a card or without; the default is with.
- The glow's four layers and the rim's one ring at 60 % are the mock-up's; the calibration may suggest moving the glow's alphas up before pinning, within what still reads as a glow and not a rim.
- The order and wording of the six hints in Settings.

## 9. The builder check (2026-10-21)

A fresh reviewer read the first draft against the tree and found seven places a builder would have to guess. Each was settled above; none changes what the user chose.

1. The card's tint and the surface palette were defined in terms of each other → the chrome's order (§5: declared tint first, the binding pair fixed, then the per-step solve).
2. "Everywhere but the bodies" was wrong for the rim and the glow — the white clouds are the worst ground → the luminance rule (§5).
3. The phone's glass column had no proven tint → the card tint (§4.2).
4. The scrim in the document was a wall-to-wall wash; the user chose the mock-up's fading one → the mock-up's, floor computed and pinned on the far side (§4.3).
5. Several column surfaces key on the ink window → re-keyed on the hour under the surface family (§4.4).
6. A non-default choice flashes once at boot → the font-size precedent, accepted (§2).
7. `width: fit-content` would move and clip the message toolbar → anchored to the row's start under Bubbles (§4.1).

## 10. What the build measured (2026-10-21)

- The surface palette: day at the declared 0.66, the lightest 4.5-floor colour `.user.color-20 #07423e`, the faint ink `#49566e`; night **0.74** (the mock-up's 0.62 could not hold the glass soft within rule 2 over the full moon; the night chrome's criterion raised it to the cap). The card's tint at a clear June noon 0.44; the mention washes count as grounds of both the palette's solve and the card's.
- The scrim's far edge: the ink 2.12 : 1 by day, 1.42 : 1 at night, pinned.
- The rim α 0.4164, the glow α 0.1372, the glow's aura 0.1503 (tools/ps/calibrate.mjs, 9546 checks, the outline reproduced as the control). Pinned per kind over every light ground: the rim white 2.35, muted 1.88, faint 2.01, nick 1.27, 28 639 of 134 108 grounds under white's floor; the glow white 1.37, muted 1.10, faint 1.29, nick 1.00, 67 724 of 149 117 under; the glow's ink aura holds 4.5 (4.68). The "hold wherever white holds" rule of §5 was replaced by these pins: where white barely holds, the lighter muted ink does not, so the rule failed by construction.
- The glyph samples under the rim and the glow: rendered at a clear summer noon the rim holds the words at 3.86 : 1, the time at 2.43, the nick at 2.18 and faint text at 3.51 (the 10th percentile of the ring, the worst element), the glow 2.01, 1.19, 1.07 and 1.79; both rise through the evening (the rim's words 8.51 at sunset, 11.46 at dusk, 13.17 at midnight; the glow's 4.40, 5.36, 5.99) — `tools/scenarios/theme-ps.mjs` pins these (`GLYPH_PINNED`).
- Under Bubbles an own row keeps its card above `style.css`'s own-message rules (which clear the background at a higher specificity); the "Highlighted row" look lays its tint over the card as an image, and reduced transparency makes own rows' and mentions' cards solid like the rest. The dark-on-light mIRC colours take their brighter values at night and under the shadow family's light words only, never on a day card. The glow's and the rim's Settings hints say they read under the usual floor by day (the glow: words 2.01 : 1 at a clear noon).
- The glass column's cost: measured by `tools/scenarios/ps-words-cost.mjs` (headless, software composited, a clear noon at Scene animation Full, ten seconds each, the frame intervals a requestAnimationFrame loop sees): on the desktop layout the outline's frames came 28.2 ms apart on average (p95 33.4), Bubbles' 26.0 (33.4; fewer shadows per glyph) and the glass column's **50.8 (p95 66.7, the worst 99.9)** — the backdrop blur over the whole message list about doubles the interval where the CPU rasterises it; on the phone layout all three held 16.7 ms (p95 16.7), since the column there carries no blur. No long task in any sample. A GPU-composited browser blurs on the GPU and pays far less; the figures compare the treatments with each other on this host, as §10.1's do.
