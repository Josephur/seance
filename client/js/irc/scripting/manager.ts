/**
 * Central manager for user Lua scripts.
 *
 * Coordinates script storage, sandbox initialization, event routing,
 * and slash commands.
 *
 * Designed to be store-free and DOM-free so tests can load it directly.
 * UI/browser context is provided via `setContextProvider` at boot.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import {LuaSandbox, type SandboxHost} from "./engine";
import {isScriptingEnabled, onScriptingEnabledChange} from "./enabled";
import {loadScripts, saveScript, getScript} from "./storage";
import type {
	Script,
	ScriptMessageEvent,
	ScriptJoinEvent,
	ScriptPartEvent,
	ScriptQuitEvent,
	ScriptKickEvent,
	ScriptNickEvent,
	ScriptTopicEvent,
	ScriptModeEvent,
} from "./types";

/** Record a script's error (or its absence); a library that no longer fits keeps the old one. */
function storeLastError(script: Script, error: string | undefined): void {
	script.lastError = error;

	try {
		saveScript(script);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[scripting] could not record the script's error:", err);
	}
}

export const SCRIPTING_DISABLED_ERROR =
	"Scripting is disabled. Enable it in Settings → General → Enable Scripting.";

export interface ActiveContextProvider {
	getContext(): {channel: string; network: string; nick: string};
	print(text: string): void;
	/** The network a script's line goes to: by uuid, else the open one, else the first. */
	clientFor(networkUuid?: string): IrcClient | undefined;
	/** The network an event came from, by its name. */
	clientNamed(name: string): IrcClient | undefined;
}

/**
 * Lines a script sends outside a command the user typed (from an event
 * handler, or while loading) go through the connection's background queue,
 * paced by the fake-lag clock; past this many waiting, more are dropped.
 */
export const MAX_QUEUED_LINES = 10;
const QUEUE_KEY = "lua:";
/** How long a script's own PRIVMSG/NOTICE is remembered, to know its echo. */
const ECHO_MEMORY_MS = 60_000;
const ECHO_MEMORY_SIZE = 100;

let contextProvider: ActiveContextProvider | null = null;

export function setContextProvider(provider: ActiveContextProvider | null): void {
	contextProvider = provider;
}

/** `PRIVMSG <target> :<text>` / `NOTICE …`, a CTCP ACTION unwrapped as the message event shows it. */
function spokenLine(line: string): {target: string; text: string} | null {
	const match = /^(?:PRIVMSG|NOTICE) (\S+) :(.*)$/i.exec(line);

	if (!match) {
		return null;
	}

	const action = /^\x01ACTION (.*)\x01?$/.exec(match[2]);
	return {target: match[1], text: action ? action[1] : match[2]};
}

function echoKey(network: string, target: string, text: string): string {
	return `${network}\n${target.toLowerCase()}\n${text}`;
}

class ScriptManager implements SandboxHost {
	private sandbox: LuaSandbox | null = null;
	private queueSeq = 0;
	/** What scripts said, so its echo does not wake the handlers that said it. */
	private ownLines = new Map<string, number>();
	private initPromise: Promise<void> | null = null;
	private activeContextOverride?: {
		client?: IrcClient;
		chan?: Channel;
		channel: string;
		network: string;
		nick: string;
	};

	/** Whether the sandbox exists — the Fengari chunk has been loaded. */
	public get loaded(): boolean {
		return this.sandbox !== null;
	}

	/** Drop the sandbox (and with it the loaded Lua state) at once. */
	public teardown(): void {
		if (this.sandbox) {
			this.sandbox.close();
			this.sandbox = null;
		}

		this.initPromise = null;
	}

	public async init(): Promise<void> {
		if (!isScriptingEnabled()) {
			return;
		}

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			const scripts = loadScripts();
			const hasEnabled = scripts.some((s) => s.enabled);

			if (!hasEnabled) {
				return;
			}

			await this.reload();
		})();

		return this.initPromise;
	}

	public async ensureSandbox(): Promise<LuaSandbox> {
		if (!isScriptingEnabled()) {
			throw new Error(SCRIPTING_DISABLED_ERROR);
		}

		if (!this.sandbox) {
			this.sandbox = await LuaSandbox.create(this);
		}

		return this.sandbox;
	}

	public async reload(): Promise<void> {
		if (!isScriptingEnabled()) {
			this.teardown();
			return;
		}

		if (this.sandbox) {
			this.sandbox.close();
			this.sandbox = null;
		}

		const scripts = loadScripts();
		const enabledScripts = scripts.filter((s) => s.enabled);

		if (enabledScripts.length === 0) {
			return;
		}

		const sandbox = await this.ensureSandbox();

		for (const script of enabledScripts) {
			const res = sandbox.eval(script.code, script.id);

			if (!res.success) {
				storeLastError(script, res.error);
				// eslint-disable-next-line no-console
				console.error(`[scripting] Error loading script "${script.name}":`, res.error);
			} else if (script.lastError) {
				storeLastError(script, undefined);
			}
		}
	}

	public async evalSnippet(
		code: string,
		ctx?: {chan?: Channel; client?: IrcClient}
	): Promise<{success: boolean; result?: string; error?: string}> {
		if (!isScriptingEnabled()) {
			return {success: false, error: SCRIPTING_DISABLED_ERROR};
		}

		if (ctx) {
			this.activeContextOverride = {
				client: ctx.client,
				chan: ctx.chan,
				channel: ctx.chan?.name ?? "",
				network: ctx.client?.name ?? "",
				nick: ctx.client?.nick ?? "",
			};
		}

		try {
			const sandbox = await this.ensureSandbox();
			return sandbox.eval(code, undefined);
		} finally {
			this.activeContextOverride = undefined;
		}
	}

	public dispatchMessage(event: ScriptMessageEvent): void {
		if (!this.sandbox) {
			return;
		}

		if (event.self) {
			const key = echoKey(event.network, event.target, event.text);
			const until = this.ownLines.get(key);

			if (until !== undefined) {
				this.ownLines.delete(key);

				if (until > Date.now()) {
					return; // a script's own line: answering it is how loops start
				}
			}
		}

		try {
			this.sandbox.dispatch("message", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching message event:", err);
		}
	}

	public dispatchSend(line: string, target?: string): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("send", {line, target});
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching send event:", err);
		}
	}

	public dispatchJoin(event: ScriptJoinEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("join", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching join event:", err);
		}
	}

	public dispatchPart(event: ScriptPartEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("part", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching part event:", err);
		}
	}

	public dispatchQuit(event: ScriptQuitEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("quit", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching quit event:", err);
		}
	}

	public dispatchKick(event: ScriptKickEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("kick", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching kick event:", err);
		}
	}

	public dispatchNick(event: ScriptNickEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("nick", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching nick event:", err);
		}
	}

	public dispatchTopic(event: ScriptTopicEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("topic", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching topic event:", err);
		}
	}

	public dispatchMode(event: ScriptModeEvent): void {
		if (!this.sandbox) {
			return;
		}

		try {
			this.sandbox.dispatch("mode", event);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[scripting] Error dispatching mode event:", err);
		}
	}

	public hasCommand(name: string): boolean {
		if (!this.sandbox) {
			return false;
		}

		return this.sandbox.hasCommand(name);
	}

	public runCommand(
		name: string,
		args: string[],
		rest: string,
		ctx?: {chan?: Channel; client?: IrcClient}
	): boolean {
		if (!this.sandbox) {
			return false;
		}

		if (ctx) {
			this.activeContextOverride = {
				client: ctx.client,
				chan: ctx.chan,
				channel: ctx.chan?.name ?? "",
				network: ctx.client?.name ?? "",
				nick: ctx.client?.nick ?? "",
			};
		}

		try {
			return this.sandbox.runCommand(name, args, rest);
		} finally {
			this.activeContextOverride = undefined;
		}
	}

	public getCommandNames(): string[] {
		if (!this.sandbox) {
			return [];
		}

		return this.sandbox.getRegisteredCommandNames();
	}

	// --- SandboxHost implementation ---

	public send(line: string, networkUuid?: string): void {
		const asked = this.activeContextOverride?.client;
		const client = asked ?? contextProvider?.clientFor(networkUuid);

		if (!client || !client.isConnected || line.length === 0) {
			// eslint-disable-next-line no-console
			console.warn("[scripting] seance.send dropped; no active network connection");
			return;
		}

		this.rememberOwnLine(client, line);

		if (asked) {
			client.send(line); // a command the user typed: they are waiting
			return;
		}

		this.sendPaced(client, line);
	}

	public reply(msg: ScriptMessageEvent, text: string): void {
		const target =
			msg.target.startsWith("#") || msg.target.startsWith("&") ? msg.target : msg.from;

		if (!target || !text) {
			return;
		}

		const line = `PRIVMSG ${target} :${text}`;
		const asked = this.activeContextOverride?.client;
		const client =
			asked ??
			(typeof msg.network === "string"
				? contextProvider?.clientNamed(msg.network)
				: undefined) ??
			contextProvider?.clientFor();

		if (!client || !client.isConnected) {
			return;
		}

		this.rememberOwnLine(client, line);

		if (asked) {
			client.send(line);
			return;
		}

		this.sendPaced(client, line);
	}

	private sendPaced(client: IrcClient, line: string): void {
		if (client.background.count((key) => key.startsWith(QUEUE_KEY)) >= MAX_QUEUED_LINES) {
			this.print(
				`[Lua error] Not sent: ${MAX_QUEUED_LINES} script lines are already waiting to go out`
			);
			return;
		}

		client.background.add({
			key: `${QUEUE_KEY}${++this.queueSeq}`,
			cost: client.fakeLag.cost(line),
			run: () => void client.send(line),
		});
	}

	private rememberOwnLine(client: IrcClient, line: string): void {
		const spoken = spokenLine(line);

		if (!spoken) {
			return;
		}

		if (this.ownLines.size >= ECHO_MEMORY_SIZE) {
			const now = Date.now();

			for (const [key, until] of this.ownLines) {
				if (until <= now || this.ownLines.size >= ECHO_MEMORY_SIZE) {
					this.ownLines.delete(key);
				}
			}
		}

		this.ownLines.set(
			echoKey(client.name, spoken.target, spoken.text),
			Date.now() + ECHO_MEMORY_MS
		);
	}

	public print(text: string): void {
		if (this.activeContextOverride?.client && this.activeContextOverride.chan) {
			this.activeContextOverride.client.pushMessage(this.activeContextOverride.chan, {
				type: MessageType.MESSAGE,
				text,
				from: {
					nick: "lua",
					mode: "",
				},
			});
			return;
		}

		if (contextProvider) {
			contextProvider.print(text);
		} else {
			// eslint-disable-next-line no-console
			console.log("[scripting print]", text);
		}
	}

	public getCurrentContext(): {channel: string; network: string; nick: string} {
		if (this.activeContextOverride) {
			return {
				channel: this.activeContextOverride.channel,
				network: this.activeContextOverride.network,
				nick: this.activeContextOverride.nick,
			};
		}

		if (contextProvider) {
			return contextProvider.getContext();
		}

		return {
			channel: "",
			network: "",
			nick: "",
		};
	}

	public onError(error: string, scriptId?: string): void {
		if (scriptId) {
			const script = getScript(scriptId);

			if (script) {
				storeLastError(script, error);
			}
		}

		this.print(`[Lua error] ${error}`);
		// eslint-disable-next-line no-console
		console.error("[scripting error]", error);
	}
}

export const scriptManager = new ScriptManager();

// The General → Enable Scripting switch (settings.ts writes the flag):
// turning it on loads Fengari and the enabled scripts; turning it off
// closes the Lua state at once, so no handler or command can fire again.
onScriptingEnabledChange((enabled) => {
	if (enabled) {
		// Deferred: at boot this fires from settings applyAll, before boot
		// has installed the context provider the scripts print/send through.
		queueMicrotask(() => void scriptManager.init());
	} else {
		scriptManager.teardown();
	}
});
