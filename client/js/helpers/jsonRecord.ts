/**
 * A localStorage value holding a JSON object, parsed once per change: the
 * reader keeps the last raw string and its parse, so a module that asks on
 * every line (irc/closedQueries.ts) pays a string compare, not a JSON.parse.
 * Anything that is not an object reads as `{}`. Vue-free and DOM-free.
 */
export function recordReader<T>(): (raw: string | null) => Record<string, T> {
	let lastRaw: string | null | undefined;
	let last: Record<string, T> = {};

	return (raw) => {
		if (raw !== lastRaw) {
			lastRaw = raw;

			try {
				const parsed: unknown = JSON.parse(raw ?? "{}");
				last =
					parsed && typeof parsed === "object" && !Array.isArray(parsed)
						? (parsed as Record<string, T>)
						: {};
			} catch {
				last = {};
			}
		}

		return last;
	};
}
