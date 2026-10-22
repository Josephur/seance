import {expect, Page, test} from "@playwright/test";
import {
	COLLAPSE_EXCERPT,
	COLLAPSE_THRESHOLD,
} from "../../client/js/helpers/ircmessageparser/codeLines";

// Live end-to-end cover for Markdown rendering: the built `public/` tree in a
// real browser, talking to a real ircd, asserting on what the DOM ends up
// holding. The tree it renders from is unit-tested in `test/helpers/layout.ts`;
// what only a browser can answer is whether the elements that tree names really
// turn up. It only runs when SEANCE_E2E_IRC_URL points at a WebSocket ircd
// (e.g. `wss://irc.example.org:9998/`), and it sends eleven messages to a real
// channel, so keep it that way.
const ircUrl = process.env.SEANCE_E2E_IRC_URL;
const channel = process.env.SEANCE_E2E_CHANNEL ?? "#ps";

test.skip(!ircUrl, "set SEANCE_E2E_IRC_URL to run the live Markdown e2e test");

// `?uri=` speaks our own scheme (`docs/resources/irc-links.md`): the authority
// is the WebSocket endpoint, the fragment is the channel, TLS is implied.
function webIrcUri(url: string) {
	const chan = channel.startsWith("#") ? channel : `#${channel}`;

	return `web+irc://${new URL(url).host}/${chan}`;
}

// Connects through the connect form exactly as a `web+irc://` link does and
// waits until the channel window is open. The random nick doubles as the
// `data-from` selector for our own messages; keep it short enough to survive
// the server's NICKLEN.
async function connect(page: Page) {
	const nick = `seance-e2e-${Math.floor(1000 + Math.random() * 9000)}`;

	await page.goto(`/?uri=${encodeURIComponent(webIrcUri(ircUrl!))}`);
	await page.waitForSelector("#connect");
	await page.fill("#connect\\:nick", nick);
	await page.click("#connect form button[type=submit]");
	await page.waitForSelector(`#chat-container[data-current-channel="${channel}"]`);
	// The channel window opens as soon as the connect form is submitted, well
	// before registration finishes, and the input refuses to send until the
	// network is connected — so wait for our own nick to turn up in the
	// channel's user list, which only happens once the JOIN went through.
	await page.waitForSelector(`#chat-container .userlist .user[data-name="${nick}"]`, {
		timeout: 60_000,
	});
	await page.waitForSelector("#input");

	return nick;
}

async function say(page: Page, text: string) {
	await page.click("#input");
	await page.fill("#input", text);
	await page.press("#input", "Enter");
}

// Composes `lines` the way a user does — Shift+Enter between them, Enter to
// send. `page.fill` would set the value in one go and never exercise the
// keyboard path, which is what puts the newlines there (`ChatInput.vue`
// submits on `@keypress.enter.exact`, so Shift+Enter falls through to the
// textarea).
async function sayLines(page: Page, lines: string[]) {
	await page.click("#input");

	for (const [i, line] of lines.entries()) {
		if (i > 0) {
			await page.keyboard.press("Shift+Enter");
		}

		await page.keyboard.type(line);
	}

	await page.keyboard.press("Enter");
}

// Our own message carrying `token`. Picking messages by a unique token rather
// than by position keeps the assertions pointed at one specific line in a
// channel other people are talking in.
function own(page: Page, nick: string, token: string) {
	return page
		.locator(`.msg[data-type="message"][data-from="${nick}"]:has-text("${token}")`)
		.first();
}

test("renders Markdown in own messages", async ({page}) => {
	// The copy button below reads the clipboard back. Chromium-only permission
	// names, which is all the suite runs (`playwright.config.ts` names no other
	// project), and the page is on 127.0.0.1, so `navigator.clipboard` is there.
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

	const nick = await connect(page);
	const token = `md${nick.slice(-4)}`;

	await say(
		page,
		`${token}a **bold** *it* __ul__ ~~st~~ \`co\` ||sp|| [lnk](https://example.com/)`
	);

	const msg = own(page, nick, `${token}a`);

	await expect(msg.locator(".irc-bold")).toHaveText("bold");
	await expect(msg.locator(".irc-italic")).toHaveText("it");
	await expect(msg.locator(".irc-underline")).toHaveText("ul");
	await expect(msg.locator(".irc-strikethrough")).toHaveText("st");
	await expect(msg.locator(".irc-monospace")).toHaveText("co");
	await expect(msg.locator(".md-spoiler")).toHaveText("sp");
	// A masked link is the anchor carrying `md-link` and the destination in
	// its title, which is what tells it apart from a linkified one.
	const masked = msg.locator("a.md-link");

	// Its text is not its URL, so the real host follows the label.
	await expect(masked).toHaveText("lnkexample.com");
	await expect(masked.locator(".md-link-host")).toHaveText("example.com");
	await expect(masked).toHaveAttribute("title", "https://example.com/");
	await expect(msg.locator(".content")).not.toContainText("**");
	await expect(msg.locator(".content")).not.toContainText("||");

	await msg.locator(".md-spoiler").click();
	await expect(msg.locator(".md-spoiler")).toHaveClass(/md-spoiler-shown/);
	// Inline code is not a code block, so this message offers no copy action
	await expect(msg.locator(".msg-action-copy")).toHaveCount(0);

	await say(page, `> ${token}b quoted \`\`\`block https://example.com/x\`\`\``);

	const quoted = own(page, nick, `${token}b`);

	await expect(quoted.locator(".md-quote")).toContainText("quoted");
	await expect(quoted.locator(".md-code-block")).toHaveText("block https://example.com/x");
	await expect(quoted.locator(".content")).not.toContainText(">");
	// A code block renders its characters and nothing else, so the URL in it
	// stays code: the layout tree does hold a link node there, and the adapter
	// flattens it (`test/helpers/layout.ts`, "renders a code block from its
	// characters alone").
	await expect(quoted.locator(".md-code-block a")).toHaveCount(0);
	// A code block is rows now, one per line, with the gutter counter only on
	// blocks of two lines or more. One row is all a single-line message can
	// hold: a fence language tag is only a tag when the fence line ends in a
	// newline, and a second row needs one too — so the gutter and the fence tag
	// are the multi-line test below. The highlighter itself is covered by
	// `test/helpers/highlighter.ts`.
	await expect(quoted.locator(".md-code-block .md-line")).toHaveCount(1);
	await expect(quoted.locator(".md-code-block")).not.toHaveClass(/md-code-block--numbered/);

	// "Copy code" lives in the message's own toolbar and only turns up on a
	// message that renders a block. What it copies is the block's characters —
	// no fence, no gutter.
	const copy = quoted.locator(".msg-action-copy");

	await expect(copy).toHaveAttribute("aria-label", "Copy code");
	await expect(copy).toHaveAttribute("title", "Copy code");
	await quoted.hover();
	await copy.click();
	// The label goes back to "Copy code" after a second and a half, so it is
	// the only thing asserted between the click and the clipboard read
	await expect(copy).toHaveAttribute("aria-label", "Copied");

	const clipboard = await page.evaluate(() => navigator.clipboard.readText());

	expect(clipboard).toBe("block https://example.com/x");
});

// What only a message with newlines in it can show: the fence language tag, the
// gutter, and headers, which are a line-level thing by construction. Newlines
// reach the wire where the server and the client both negotiate
// `draft/multiline`.
test("renders a fenced multi-line code block and headers", async ({page}) => {
	const nick = await connect(page);
	const token = `md${nick.slice(-4)}`;
	// Every message this run puts in the channel: the random nick is nobody
	// else's, so counting these is counting our own sends.
	const all = page.locator(`.msg[data-type="message"][data-from="${nick}"]`);

	await sayLines(page, ["```js", `const x = 1; // ${token}f`, "let y = x;", "```"]);

	const msg = own(page, nick, `${token}f`);
	const block = msg.locator(".md-code-block");

	// `data-lang` lands only once the lazy Prism chunk has resolved and the
	// block has re-rendered with its tokens, so this is the assertion that
	// waits for the highlighting — and `js` normalised to `javascript` is the
	// fence tag having survived as a tag.
	await expect(block).toHaveAttribute("data-lang", "javascript");

	const keywords = await block.locator(".tok-keyword").allInnerTexts();

	expect(keywords).toContain("const");
	expect(keywords).toContain("let");

	// Two code rows, so the block carries the gutter counter.
	await expect(msg.locator(".md-code-block--numbered .md-line")).toHaveCount(2);
	await expect(msg.locator(".content")).not.toContainText("```");
	// Deliberately after the rest: a per-line send would have shown up as four
	// separate messages long before the highlighted block above rendered.
	await expect(all).toHaveCount(1);

	// A header ends at its line, so a pasted document is headers and body in
	// one message: two levels here, each its own block, and the body plain.
	await sayLines(page, ["# Big", "## Small", `${token}h body text`]);

	const doc = own(page, nick, `${token}h`);

	await expect(all).toHaveCount(2);
	await expect(doc.locator(".md-h1")).toHaveText("Big");
	await expect(doc.locator(".md-h2")).toHaveText("Small");
	// The markers are gone, and the body is not part of either header
	await expect(doc.locator(".content")).not.toContainText("#");
	await expect(doc.locator(".md-header")).toHaveCount(2);
});

// A block past COLLAPSE_THRESHOLD lines shows COLLAPSE_EXCERPT of them and a
// toggle. The counts come from the constants rather than from literals, so the
// spec follows the thresholds if they ever move. The hidden lines are not in
// the DOM, which is the whole point — so this is also where the toolbar's Copy
// action has to prove it copies the code and not the screen: it reads the
// layout tree, not the rendered rows.
test("collapses a long code block to an excerpt", async ({page}) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

	const nick = await connect(page);
	const token = `md${nick.slice(-4)}`;
	// The shortest block that collapses at all, so the send stays minimal: one
	// line past the threshold, the first carrying this run's token so the
	// message can be picked out while the block is still collapsed. With the
	// two fence lines that is COLLAPSE_THRESHOLD + 3 lines on the wire, which
	// the server's `draft/multiline` `max-lines` has to allow for this to
	// arrive as one message (AfterNET offers 100).
	const lineCount = COLLAPSE_THRESHOLD + 1;
	const code = Array.from({length: lineCount}, (_, i) => `const v${i + 1} = ${i + 1};`);

	code[0] = `// ${token}k`;

	await sayLines(page, ["```js", ...code, "```"]);

	const msg = own(page, nick, `${token}k`);
	const rows = msg.locator(".md-code-block .md-line");
	const toggle = msg.locator(".md-code-toggle");

	await expect(toggle).toHaveText(`Show all ${lineCount} lines`);
	await expect(rows).toHaveCount(COLLAPSE_EXCERPT);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");

	// Our own send left the channel scrolled to the bottom, and a reader at the
	// bottom stays there across the height change (the other branch keeps the
	// block's top edge stationary, which for a block that grows downward is by
	// construction a no-op — there is nothing observable to assert).
	const atBottom = () =>
		page.evaluate(() => {
			const el = document.querySelector("#chat .chat") as HTMLElement;

			return el.scrollHeight - el.scrollTop - el.offsetHeight <= 30;
		});

	expect(await atBottom()).toBe(true);

	await toggle.click();

	await expect(rows).toHaveCount(lineCount);
	await expect(toggle).toHaveText("Show less");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	expect(await atBottom()).toBe(true);

	await toggle.click();

	await expect(rows).toHaveCount(COLLAPSE_EXCERPT);
	await expect(toggle).toHaveText(`Show all ${lineCount} lines`);

	// Collapsed, with the lines past the excerpt nowhere in the DOM — and the
	// Copy action still yields every one of them, because it copies the block
	// the layout tree holds rather than the rows on screen.
	const copy = msg.locator(".msg-action-copy");

	await msg.hover();
	await copy.click();
	await expect(copy).toHaveAttribute("aria-label", "Copied");

	const clipboard = await page.evaluate(() => navigator.clipboard.readText());

	expect(clipboard).toBe(code.join("\n"));
});

test("leaves the text alone when the setting is off, Alt+K toggles it", async ({page}) => {
	const nick = await connect(page);
	const token = `md${nick.slice(-4)}`;
	// Navigate by hash only: `page.goto` would reload the SPA and drop the
	// socket, because the connect URL differs in path and query.
	const chat = await page.evaluate(() => location.hash);

	// Sent while the setting is still on, so the flip has to re-render it.
	// The words are deliberately neutral: everyone else in the channel sees
	// these lines rendered, so a payload that describes a look ("not bold")
	// reads as a bug on their screen.
	await say(page, `${token}p **toggle-probe**`);

	const pre = own(page, nick, `${token}p`);

	await expect(pre.locator(".irc-bold")).toHaveText("toggle-probe");

	// Alt+K with the chat input focused, exactly like a user would use it
	await page.click("#input");
	await page.keyboard.press("Alt+K");

	await page.evaluate(() => {
		location.hash = "#/settings/appearance";
	});

	const markdown = page.locator('input[name="markdown"]');

	await expect(markdown).not.toBeChecked();

	await page.evaluate((hash) => {
		location.hash = hash;
	}, chat);
	await page.waitForSelector("#input");

	// The message that was already on screen re-renders with the markers back
	await expect(pre.locator(".irc-bold")).toHaveCount(0);
	await expect(pre.locator(".content")).toContainText("**toggle-probe**");

	await say(page, `${token}c **markers-kept**`);

	const msg = own(page, nick, `${token}c`);

	await expect(msg.locator(".content")).toContainText("**markers-kept**");
	await expect(msg.locator(".irc-bold")).toHaveCount(0);

	// Alt+K again re-enables rendering, restoring both messages
	await page.click("#input");
	await page.keyboard.press("Alt+K");

	await page.evaluate(() => {
		location.hash = "#/settings/appearance";
	});

	await expect(markdown).toBeChecked();

	await page.evaluate((hash) => {
		location.hash = hash;
	}, chat);
	await page.waitForSelector("#input");

	await expect(pre.locator(".irc-bold")).toHaveText("toggle-probe");
	await expect(msg.locator(".irc-bold")).toHaveText("markers-kept");
});

// The newer block-level syntax: lists, a pipe table, TeX, a shortcode, `>>>`,
// and the code block's corner label. Everything here needs newlines on the
// wire (the table, the display-adjacent sends), so it rides `draft/multiline`
// the same way the fenced block above does.
test("renders lists, tables, TeX, shortcodes and the quote-everything-after", async ({page}) => {
	const nick = await connect(page);
	const token = `md${nick.slice(-4)}`;

	// One unordered list of two items, then an ordered one starting at five:
	// markers gone from the text, the bullets and numbers drawn by CSS.
	await sayLines(page, [
		`${token}l groceries:`,
		"- **tea** and something else",
		"- oat milk",
		"5. fifth step",
		"6. sixth step",
	]);

	const listed = own(page, nick, `${token}l`);

	await expect(listed.locator(".md-list.md-ul .md-li")).toHaveCount(2);
	await expect(listed.locator(".md-list.md-ul .md-li").first()).toContainText("tea");
	await expect(listed.locator(".md-list.md-ul .md-li .irc-bold")).toHaveText("tea");
	await expect(listed.locator(".md-list.md-ol .md-li")).toHaveCount(2);
	await expect(listed.locator(".md-list.md-ol .md-li").first()).toHaveText("fifth step");
	// The counters start where the list said: `5.` at the fifth step, and the
	// typed markers are nowhere in the message.
	await expect(listed.locator(".md-list.md-ol")).toHaveAttribute(
		"style",
		/counter-reset:\s*md-oli 4/
	);
	await expect(listed.locator(".content")).not.toContainText("- **");
	await expect(listed.locator(".content")).not.toContainText("5. ");

	// A pipe table: the separator row gone, real `th`/`td` elements, and each
	// column sitting the way its separator cell asked.
	await sayLines(page, [`${token}t Item | Qty`, "--- | ---:", "screws | 12"]);

	const table = own(page, nick, `${token}t`).locator(".md-table");

	await expect(table.locator("thead th")).toHaveCount(2);
	await expect(table.locator("tbody td")).toHaveCount(2);
	// The first cell holds the token too — it is part of the message
	await expect(table.locator("thead th").first()).toContainText("Item");
	await expect(table.locator("tbody td").first()).toHaveText("screws");
	await expect(table.locator("thead th").nth(1)).toHaveCSS("text-align", "right");
	await expect(own(page, nick, `${token}t`).locator(".content")).not.toContainText("---");

	// A shortcode renders as the character, inline TeX as KaTeX once the chunk
	// lands, and a double-backtick span keeps the backtick it holds.
	await say(page, `${token}m hi :smile: $\`E=mc^2\`$ and \`\`a \`b\` c\`\` done`);

	const mixed = own(page, nick, `${token}m`);

	await expect(mixed.locator(".emoji")).toHaveText("😄");
	await expect(mixed.locator(".content")).not.toContainText(":smile:");
	await expect(mixed.locator(".md-math .katex")).toBeVisible();
	await expect(mixed.locator(".irc-monospace")).toHaveText("a `b` c");

	// `>>>` quotes the rest of the message, a list nesting inside it; and a
	// four-backtick fence holds a three-backtick one, its `lang:file` tag
	// naming the file the label shows.
	await sayLines(page, [">>> quoted text", `- ${token}q listed inside`]);

	const quotedAll = own(page, nick, "quoted text");

	await expect(quotedAll.locator(".md-quote")).toContainText("quoted text");
	await expect(quotedAll.locator(".md-quote .md-list .md-li")).toHaveCount(1);
	await expect(quotedAll.locator(".content")).not.toContainText(">>>");

	await sayLines(page, ["````python:notes.md", `${token}f has \`\`\` inside`, "````"]);

	const nested = own(page, nick, `${token}f`);
	const block = nested.locator(".md-code-block");

	// The label is the file, not the language, and it does not wait for Prism.
	await expect(block).toHaveAttribute("data-lang", "notes.md");
	await expect(block).toContainText("has ``` inside");
	await expect(nested.locator(".content")).not.toContainText("````");
});
