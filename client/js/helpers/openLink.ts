/**
 * Opening a masked link after the user has been warned (helpers/linkSafety.ts,
 * parse.ts). The dialog's button is the user gesture, so a new tab is allowed.
 */

import eventbus from "../eventbus";

/** Open `href` in a new tab the way an anchor would (https and web+irc: alike). */
export function openExternal(href: string): void {
	const a = document.createElement("a");
	a.href = href;
	a.target = "_blank";
	a.rel = "noopener";
	a.click();
}

/** Ask before opening a link whose text (`shown`) names another address than it opens. */
export function confirmMismatch(href: string, shown: string): void {
	eventbus.emit(
		"confirm-dialog",
		{
			title: "Check this link",
			text: `The link text shows ${shown}, but it opens ${href}.`,
			button: "Open anyway",
		},
		(confirmed: boolean) => {
			if (confirmed) {
				openExternal(href);
			}
		}
	);
}
