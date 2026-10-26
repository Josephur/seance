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
import {loadScripts, saveScript, getScript} from "./storage";
import type {Script, ScriptMessageEvent} from "./types";

export interface ActiveContextProvider {
	getContext(): {channel: string; network: string; nick: string};
	print(text: string): void;
	send(line: string, networkUuid?: string): void;
	reply(msg: ScriptMessageEvent, text: string): void;
}

let contextProvider: ActiveContextProvider | null = null;

export function setContextProvider(provider: ActiveContextProvider | null): void {
	contextProvider = provider;
}

class ScriptManager implements SandboxHost {
	private sandbox: LuaSandbox | null = null;
	private initPromise: Promise<void> | null = null;
	private activeContextOverride?: {
		client?: IrcClient;
		chan?: Channel;
		channel: string;
		network: string;
		nick: string;
	};

	public async init(): Promise<void> {
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
		if (!this.sandbox) {
			this.sandbox = await LuaSandbox.create(this);
		}

		return this.sandbox;
	}

	public async reload(): Promise<void> {
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
				script.lastError = res.error;
				saveScript(script);
				// eslint-disable-next-line no-console
				console.error(`[scripting] Error loading script "${script.name}":`, res.error);
			} else if (script.lastError) {
				script.lastError = undefined;
				saveScript(script);
			}
		}
	}

	public async evalSnippet(
		code: string,
		ctx?: {chan?: Channel; client?: IrcClient}
	): Promise<{success: boolean; result?: string; error?: string}> {
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
		if (this.activeContextOverride?.client && this.activeContextOverride.client.isConnected) {
			this.activeContextOverride.client.send(line);
			return;
		}

		if (contextProvider) {
			contextProvider.send(line, networkUuid);
		} else {
			// eslint-disable-next-line no-console
			console.warn("[scripting] seance.send dropped; no active network connection");
		}
	}

	public reply(msg: ScriptMessageEvent, text: string): void {
		const target =
			msg.target.startsWith("#") || msg.target.startsWith("&") ? msg.target : msg.from;

		if (!target || !text) {
			return;
		}

		if (this.activeContextOverride?.client && this.activeContextOverride.client.isConnected) {
			this.activeContextOverride.client.send(`PRIVMSG ${target} :${text}`);
			return;
		}

		if (contextProvider) {
			contextProvider.reply(msg, text);
		}
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
				script.lastError = error;
				saveScript(script);
			}
		}

		this.print(`[Lua error] ${error}`);
		// eslint-disable-next-line no-console
		console.error("[scripting error]", error);
	}
}

export const scriptManager = new ScriptManager();
