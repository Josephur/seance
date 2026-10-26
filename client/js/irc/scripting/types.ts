/**
 * Type definitions for Seance's Lua scripting subsystem.
 */

import type {Channel} from "../channel";
import type {IrcClient} from "../client";

export interface Script {
	id: string;
	name: string;
	code: string;
	enabled: boolean;
	lastError?: string;
	createdAt?: number;
}

export interface ScriptMessageEvent {
	network: string;
	target: string;
	from: string;
	text: string;
	type: "message" | "notice" | "action";
	self: boolean;
	tags?: Record<string, string>;
}

export interface ScriptCommandContext {
	client: IrcClient;
	chan: Channel;
	command: string;
	args: string[];
	rest: string;
}

export interface ScriptStorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}
