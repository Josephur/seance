# Markdown messages

Status: implemented on `markdown-messages-development` (2026-08-29); headers
and collapsing large code blocks added on `markdown-messages` (2026-08-31,
plan in `docs/archives/2026-08-31-markdown-documents-plan.md`); lists, `>>>`
quotes, multi-backtick code, pipe tables, TeX, emoji shortcodes and the
code-block label added 2026-09-01.

Discord-style Markdown is rendered in everything `ParsedMessage` shows when
the `markdown` setting (default on, Settings → Appearance → Messages) is set.
Display-only; nothing changes on the wire.

The MOTD is the exception. It is pushed as a `MONOSPACE_BLOCK`
(`client/js/irc/handlers/numerics.ts`, `motdEnd`), and a monospace block is a
code block — nothing is interpreted inside one, so it renders verbatim and its
ASCII-art banners keep their `_____`, `\_` and `|...|`. `ParsedMessage` has a
`markdown` prop (default `true`) that `MessageTypes/monospace_block.vue` sets
to `false`; the setting can only ever turn Markdown off, never back on.

Design: `docs/archives/2026-08-29-markdown-messages-design.md`.

## Syntax

The whole of it — nothing outside this table is Markdown here. `\` before any
marker character makes it literal.

| Markup                             | Result                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**text**`                         | bold (`.irc-bold`)                                                                                                                                                                            |
| `*text*`, `_text_`                 | italic (`.irc-italic`); `_` only at word boundaries                                                                                                                                           |
| `__text__`                         | underline (`.irc-underline`)                                                                                                                                                                  |
| `~~text~~`                         | strikethrough (`.irc-strikethrough`)                                                                                                                                                          |
| `` `code` ``, ` `code` `           | inline code (`.irc-monospace`), a verbatim span; the closing run must match the opening one, so ` `a `b` c` ` holds backticks                                                                 |
| ` ```[lang][:file]⏎code``` `       | code block (`<code class="md-code-block">`, rows, gutter, `lang` kept as the highlighter's tag, a `lang:file` tag names the file the label shows, single-line allowed)                        |
| 3+ backticks                       | a fence: the closing run must be at least as long as the opening one, so a ````` fence holds a ` `` `                                                                                         |
| `- text`                           | unordered list (`.md-list`/`.md-ul`, one item per line, marker drawn by CSS)                                                                                                                  |
| `1. text`–`9. text`                | ordered list (`.md-ol`), the CSS counter starting at the first item's number                                                                                                                  |
| `\|\|text\|\|`                     | spoiler (`<span class="md-spoiler">`, click or Enter/Space toggles `.md-spoiler-shown`)                                                                                                       |
| `> text` at the start of a line    | quote (`<span class="md-quote">`, block-level, `> ` removed)                                                                                                                                  |
| `>>>` at the very start            | quote-everything-after: the rest of the message is one quote, inner `> ` markers still removed                                                                                                |
| `#`–`######` + space at line start | header (`<span class="md-header md-h1">`…`md-h6`, block-level, marker removed; `> # t` nests)                                                                                                 |
| pipe table                         | GFM: a row of cells, a `---` separator row (with `:---`/`---:`/`:---:` alignment), then rows until a line without a pipe; rendered as a real `<table class="md-table">`, first row the header |
| `` $`tex`$ ``                      | inline TeX (`MathSpan`, KaTeX, one line only)                                                                                                                                                 |
| `$$tex$$`                          | display TeX (`MathSpan`, block-level, may span lines)                                                                                                                                         |
| `:name:`                           | emoji shortcode (gemoji aliases only — an unknown name is not emoji, so `10:30:45` stays a timestamp)                                                                                         |
| `[text](url)`                      | masked link (`<a class="md-link" title=url target=_blank rel=noopener>`), schemes `http:`, `https:`, `web+irc:` only                                                                          |
| `\*` etc.                          | backslash escapes any marker character (`-` and `$` included)                                                                                                                                 |

## How it works

The pipeline is `parseStyle` → **`applyMarkdown`** → finders → `merge` →
**layout tree** → `parse()` / `toPlainText`. Its vocabulary — fragment,
marker, opaque span, verbatim span, finder, part, layout tree, wrap, masked
link, monospace block — is defined in `CONTEXT.md`; use those words.

- `applyMarkdown` (`client/js/helpers/ircmessageparser/parseMarkdown.ts`)
  removes the marker characters and sets the flags on the style fragments,
  handing back `{fragments, verbatim}` — the verbatim spans are the stretches
  nothing is interpreted inside, and the channel/nick/emoji finders skip them.
  It is the module's only entry point; the marker scan behind it is private.
  URLs are opaque to the scanner: `opaqueSpans` runs `findLinks` and
  `trimTrailingEmphasis` peels the trailing `**` linkify-it swallows back off,
  so the markers around a URL still close.
- `layout(text, options)`
  (`client/js/helpers/ircmessageparser/layout.ts`) decides what a message
  renders as and says so as plain data: a `LayoutNode` tree of text nodes
  (presentational style only), the parts a finder made interactive
  (link/channel/emoji/nick) and the wraps (`quote`, `header`, `codeBlock`,
  `spoiler`, `href`, nested in that order). It imports no Vue, store or DOM, so
  the rendering decision is unit-testable.
- The adapters walk that tree. `parse()` (`client/js/helpers/parse.ts`) is the
  Vue one and the whole of its interface: inside it a private `toVNodes` walk
  owns `createFragment`, the wrap elements and the four `renderPart` branches.
  `toPlainText` is the other, used by `Chat.vue`'s `plainTopic` for the
  window-title `title` attribute.

A masked link is an `<a class="md-link" title="<url>">`; the class is what
tells it apart from a linkified anchor.

**Masked links can lie, so they say where they go** (2026-10-22). The label is
free text, so `[paypal.com](https://evil.example)` shows one address and opens
another. `client/js/helpers/linkSafety.ts` `judgeLink(label, href)` compares
hosts, never strings. The destination is `new URL(href).hostname`, which sees
through userinfo (`https://bank.com@evil.example`) and gives an IDN host in
punycode. The label is first read as a reader sees it: NFKC, invisible
characters and bidi marks removed, ideographic dots read as dots, and text
drawn in its own background colour left out (`layout.ts` `visibleText`). Its
addresses are the host-shaped words that end in a real TLD or carry a letter
outside ASCII (a lookalike); an e-mail address counts by its domain. A
schemeless source-file name (`setup.py`, `readme.md`, `main.rs`) is not an
address unless a path follows it. `layout()` puts the verdict on the `href`
node, finds no link, channel or nick inside the label and lets no emoji
shortcode reach across its edge, and `parse.ts` renders it:

- `honest`: every address in the label is the destination's host (one
  leading `www.` aside); rendered as before;
- `masked`: a prose label, or one naming a parent or a subdomain of the real
  host (`github.io` for attacker.github.io, `paypal.s3.amazonaws.com` for
  s3.amazonaws.com: a shared host is anyone's): the real host follows the
  label, in `<span class="md-link-host">` inside the anchor (a phone shows no
  title);
- `mismatch` (the label names another site): the host in the error colour, a
  warning glyph, and a click, Ctrl/Cmd-click or middle click raises the
  confirm dialog ("Check this link"), which names the real host, not the raw
  href, and whose Open anyway opens it (`helpers/openLink.ts`).

Limits: a long press's own menu, a right click's "Open in new tab" or a drag cannot be intercepted, so there the host after the label is the only warning; the label holds no link of its own (layout.ts finds no link, channel or nick inside an `href` wrap), so those menus name the real destination. Enter never reaches a chat link (`keybinds.ts` sends keys outside a field to the composer). Tests
`test/helpers/linkSafety.ts`, `test/helpers/layout.ts`; browser check
`tools/scenarios/masked-links.mjs` (also `--mobile --width=390 --height=844`,
and `SEANCE_THEME=ps`). CSS for the wrapped elements
(`.md-quote`, `.md-header`/`.md-h1`…`.md-h6`, `.md-code-block`,
`.md-code-toggle`, `.md-spoiler`/`.md-spoiler-shown`) lives in
`client/css/style.css`, after `.irc-italic`. The channel header's topic is one
clipped `nowrap` line, so the block-level ones are overridden back to `inline`
there — and the collapse toggle to `display: none`.

## Headers

`#` to `######` followed by one space at the start of a line makes that line a
header, the way `> ` makes it a quote — a header is a **line-level** thing and
ends at its newline, so `# Title` on the first line of a pasted document leaves
the rest of it alone. `#chan` is not a header (no space), `\#` escapes, markers
inside a header still work (`# **bold** title`) and `> # q` nests the header
inside the quote. Nothing else of Markdown's header syntax is taken: no closing
hashes, no `===` underline, no anchors.

The level is the wrap's value (`{wrap: "header", level: 1…6}`), which is what
keeps two adjacent lines of different levels in wraps of their own. It also
means two adjacent lines of _one_ level necessarily share a single wrap, whose
text holds the newline between them — hence `white-space: pre-wrap` on
`.md-header`, without which the two headings would render as one line. The
newlines a header line sits between are removed the way a fence's are, so a
header leaves no blank row behind it.

`parse.ts` renders the wrap as `<span class="md-header md-h<level>">`; the
stylesheet does the rest, capped for chat rather than for a document: h1
1.5em/700 down to h6 0.85em/600 uppercase and muted, h5 and h6 in
`--body-color-muted`. Only the size, weight and colour are the level's — the
element is the same in all six.

## Code blocks

A code block is rows: `CodeBlock.vue` renders one `<span class="md-line">` per
line inside the `<code class="md-code-block">`, and blocks of two lines or more
also get `md-code-block--numbered`, whose CSS counter draws the gutter. The
number is `::before` content, so selecting the block copies the code and not the
numbers. The block renders its plain characters and nothing else: `parse.ts`
builds it from `toPlainText` of the wrap's children, so IRC colour codes inside
one do not style it and a URL inside one is not a link, as on Discord. Inline
`` `code` `` is not flattened that way, so a URL there is still a link — the
verbatim span suppresses the channel/nick/emoji finders in both, but `findLinks`
runs on the whole message and it is the block that drops what it found.

A message that renders at least one code block gets a **Copy code** action in
its own hover toolbar (`MessageActions.vue`, `.msg-action-copy`, next to
reply/react/edit; a copy that worked closes the bar and leaves a `Copied`
label in its corner for a second, `.msg-copied`). It is not a control on the block: the toolbar already
appears on hover and works on touch (`.msg-actions.active`), and a second
control in the same corner was neither reachable with a mouse nor with a thumb.
Which blocks a message holds is decided on the layout tree, not on the DOM:
`codeBlocksOf(nodes)` (`layout.ts`) returns each `codeBlock` wrap's
`toPlainText`, so what is copied is the block's characters — newlines included,
without the fence or the gutter — and several blocks are joined by a blank line.
The `markdown` setting off means there are no blocks and no action. The copy
itself is `writeClipboard` (`client/js/clipboard.ts`): `navigator.clipboard`
where it works, an off-screen `<textarea>` and `document.execCommand("copy")`
where it does not (a deploy served over plain http is not a secure context).
Both paths fail silently, and a copy that did not happen leaves the label alone.

A block of more than `COLLAPSE_THRESHOLD` (12) lines is **collapsed**: it
renders its first `COLLAPSE_EXCERPT` (8) lines and a
`<button class="md-code-toggle">` reading `Show all N lines`. The hidden lines
are not in the DOM, so selecting a collapsed block copies what it shows; the
toolbar's Copy code action is unaffected, because it reads the layout tree and
not the rows. `excerptRange(lineCount)` in `codeLines.ts` is the whole decision
— pure, and settled before Prism is fetched — and, like the gutter width, it is
computed from the plain text, so neither moves when the tokens land. The
highlighter still sees the whole code once; only the rendered rows are sliced,
so the gutter counts 1…8 and then 1…N with nothing restarting mid-block. The
state is the component's own: an edit keeps it (the text changes under the same
instance, which is why the token reset is a `watch`), and the `markdown` setting
flipping unmounts the block, so it comes back collapsed — as a shown spoiler
comes back hidden.

The MOTD never collapses. It is a monospace block, and
`MessageTypes/monospace_block.vue` renders it through `ParsedMessage` with
`:markdown="false"`, so there is no `codeBlock` wrap and `CodeBlock.vue` never
mounts for it.

A block **carries a caption** when something is known about it: the file a
`lang:file` tag named, else the language — the tag as typed until the tokens
land (`js` becomes `javascript`), and the guesser's answer only once there is
one. The caption is the block's own first row inside the `<code>`, in the
message's typeface and a muted size, so it reads as a label and never as an
empty first line of code; it rides the block as `data-lang` for the tests, and
`user-select: none`, like the gutter, keeps it out of copies. ```ansi` is in
the shipped grammar list — terminal output is the paste chat gets.

## Lists, quotes-everything-after, tables, TeX, shortcodes

**Lists** are `- ` lines, or `1.`–`9. ` with a space (`* ` is not one: it is
italic). Consecutive items share one `list` wrap, the way quote lines do; the
wrap's value is `ul`, or `ol:<first item's number>` — the adapter sets the
counter's start from it, so `3. …` counts 3, 4. The markers are removed and
the bullet or number is drawn — a `::before` column the way the gutter works,
with one space of its own after it — so selecting a list yields the items. A
line with nothing after the marker is not a list; lists do not nest, and a
table's rows are never list lines.

**`>>>`** at the very start of a message quotes everything after it: one
`quote` range over the rest of the text, so `> ` lines inside it still lose
their markers and lists and styles still nest inside. It is the only quote
form that spans lines by itself; `> ` still needs one per line.

**Tables** are found before the main scan, the way URLs are zoned: a row of
cells, a separator row of `---` cells (as many as the header, `:` colon forms
setting each column's alignment), then every following line that holds a pipe.
The scan removes the separator row and the outer pipes with their padding, and
zones every pipe it keeps, so `||` is never a spoiler inside a table. One
`table` wrap spans the whole thing, its value the columns' alignment letters;
the rows are the newlines it kept, the cells the pipes. `parse.ts` renders a
real `<table>` — `thead` from the first row, `text-align` from the letters —
and a `splitNodes` helper walks the wrap's children splitting them, cloning a
spoiler that straddles a boundary around each side. A code fence, a header, a
quote or a list can never start inside one. Escaped pipes are not supported:
`\|` becomes a literal pipe, which is a cell boundary like any other.

**TeX** is `$`…`$` inline and `$$…$$` display — Element's grammar, the
dollar-backtick shape being what keeps `$5 and 50 cents` out of the maths.
The spans are verbatim and carry the TeX on the wrap; `MathSpan.vue` renders
it with **KaTeX** (MIT, `js/katex.js`, a chunk exactly like the highlighter —
a message without math never fetches it) and shows the raw TeX until, unless,
it lands. `throwOnError: false`, so a broken TeX renders as KaTeX's red error
text rather than throwing. KaTeX's output is set as `innerHTML` — the one
deliberate exception to the pipeline's no-HTML-strings rule: KaTeX escapes
everything it is given and emits only its own markup, so the TeX reaches the
DOM only as something KaTeX rendered. Its stylesheet and fonts are static
files (`css/katex.min.css`, `css/fonts/`, copied by webpack — css-loader runs
with `url: false`, so importing the stylesheet through webpack would strand
the fonts); the first span that renders links the stylesheet, and nothing is
fetched before. Offline the TeX stays text, like an unhighlighted block.

**Shortcodes** are `:name:` for a name in `shortcodes.json` (generated from
the `gemoji` package by `tools/generate-shortcode-map.mjs`, committed —
regenerate when the dep is bumped). Gating the match on the map is what keeps
`10:30:45` a timestamp: `30` is not an alias, so nothing fires. A match
renders as the character — an `emoji` part whose text is the glyph, not the
`:name:` typed — through the same `.emoji` span, `title` and all, that unicode
emoji gets.

The MOTD is unaffected by all of it: Markdown is off there, so there are no
lists, tables, maths or shortcodes in one.

Flipping it changes a height in the middle of the timeline, so `CodeBlock.vue`
restores the scroll position around the change: a reader who was at the bottom
of the channel stays at the bottom — `MessageList`'s own at-bottom formula,
verbatim, so the two never disagree about the same scroller — and anyone else
keeps the block's top edge exactly where it was on screen.

Highlighting is `highlighter.ts` (Vue-free, mocha loads it):

- The fence's language tag is kept by `applyMarkdown` as `lang` and carried on
  the layout tree's `codeBlock` wrap. It is a tag only when the fence line ends
  in a newline — ` ```js x``` ` on one line is content, as on Discord.
  `normalizeLang` resolves it through Prism's own alias table
  (`prismjs/components.json`, so nothing is hand-maintained): `js` →
  `javascript`, `sh` → `bash`, plus the punctuation forms Prism has no alias for
  (`c++`, `c#`).
- An untagged block of `MIN_GUESS_LINES` (2) lines or more is guessed with
  flourite, and the guess is used only when it is strictly past
  `GUESS_MIN_CONFIDENCE` (0.5), i.e. strictly ahead of the runner-up —
  flourite's scores go negative, so "ahead of the runner-up" is the only share
  that means anything.
- `ensureLanguage` fetches the grammar and its dependencies, memoised per id;
  `highlight` then turns `Prism.tokenize`'s nested tokens into one plain
  `CodeToken` array per line (innermost type wins), which the component renders
  as `<span class="tok-<type>">`. No HTML strings, so a code block is as
  XSS-proof as the rest of the pipeline. The nine token colours are CSS
  variables in `style.css` (`--tok-comment`, `--tok-keyword`, …) with dark
  values in `themes/morning.css`.
- Everything is lazy: `js/highlighter.js` (Prism's core and alias table),
  `js/prism-<lang>.js` (one per grammar; `webpackInclude` in `highlighter.ts`
  picks the 72 this deploy ships, closed over Prism's own dependency links) and
  `js/flourite.js`. Only a block that names a language or is long enough to
  guess fetches anything at all. The service worker precaches the shell, not
  these, so the first block in an offline app stays plain — a failed import is
  caught, and the block simply never highlights.

**Needs multiline.** Both paths need a newline in the message: a fence tag is
only a tag before one, and a guess needs two lines. So does a collapsed block,
and so does a header. Newlines reach the wire where the client and the server
both negotiate `draft/multiline` (`client/js/irc/caps.ts`, merged), and the
browser cover for all of it is the multi-line cases in
`test/e2e/markdown.spec.ts` — ungated now that it is.

## Licensing

Both are MIT, and their copyright notices ship with the chunks that carry them:

| Package    | Version | Licence | Upstream                                   | Notice in                              |
| ---------- | ------- | ------- | ------------------------------------------ | -------------------------------------- |
| `prismjs`  | 1.30.0  | MIT     | https://github.com/PrismJS/prism           | `public/js/highlighter.js.LICENSE.txt` |
| `flourite` | 1.3.0   | MIT     | https://github.com/teknologi-umum/flourite | `public/js/flourite.js.LICENSE.txt`    |
| `katex`    | 0.16.22 | MIT     | https://github.com/KaTeX/KaTeX             | `public/js/katex.js.LICENSE.txt`       |

`gemoji` (MIT) is a devDependency only: `tools/generate-shortcode-map.mjs`
reads it once and the generated `shortcodes.json` is what ships.

## Shortcuts

`Alt+K` (`⌥K` on Apple) toggles the `markdown` setting, same as the
Settings → Appearance → Messages checkbox — bound in `client/components/App.vue`
alongside the other `Alt+<key>` toggles and listed in the Help window's shortcut
table. The checkbox itself carries no hint — no other setting does.

## Tests

- `test/helpers/parseMarkdown.ts` — one `describe` per row of the spec's syntax
  table, asserting the text and flags `applyMarkdown` produces. No offsets: a
  fragment boundary moving is not behaviour.
- `test/helpers/layout.ts` — the tree a message renders as, wraps and parts
  included, what the adapter is handed for a code block (its characters, URL
  included), and what `codeBlocksOf` reads back out of it for the Copy code
  action.
- `test/helpers/highlighter.ts` — tag normalisation, line splitting, the token
  → node mapping (against a stub grammar and a real one), and the guesser.
- `test/helpers/codeLines.ts` — `excerptRange` and the two collapse constants,
  the decision a block makes before Prism is anywhere near it.
- `test/helpers/math.ts` — the KaTeX path: inline and display renders, a
  broken TeX coming back as error text, empty TeX coming back as nothing.
- `test/e2e/markdown.spec.ts` — `SEANCE_E2E_IRC_URL=wss://host:port/ yarn test:e2e`
  drives the built client against a live ircd with Playwright. It covers what
  only a browser can answer: that the elements the tree names really appear,
  that the spoiler toggles, that a code block renders as one row, that a URL
  inside one is not an anchor and that the toolbar's Copy code action puts the
  block's characters on the clipboard (and is absent from a message without a
  block). The multi-line cases cover what only a message with newlines can
  show: the fence language tag, the gutter, headers of two levels in one
  message, and a 16-line block collapsing to 8 rows, expanding, collapsing
  again — with the Copy code action still yielding all sixteen lines.
