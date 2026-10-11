/**
 * Services profiles: what a network's services package (X3 today; others
 * by contribution, like the server profiles in `../profiles/`) writes into
 * its channels and answers to its commands, as data and pure functions
 * over text, so mocha covers them with fixtures taken from the wire
 * reference (docs/resources/x3-services.md). Which package a network runs,
 * and its bots' nicks, is the oper's setting (`ServicesConfig`), never
 * detected — nothing about a network's services is standard.
 *
 * Adding a package: implement {@link ServicesProfile} in a new directory
 * here and list it in `./index.ts`.
 */

import type {ServicesConfig} from "../../../../shared/types/network";
import type {CoarseKind} from "../../helpers/operActivity";

/** One line of the snoop feed (a connect, a join, a kill…), parsed. */
export interface SnoopEvent {
	/** The keyword, lowercased (`connect`, `nick`, `join`, `kill`, `oper`, `mode`…). */
	keyword: string;
	fields: Record<string, string>;
}

/** One audit line: a command somebody made services run. */
export interface AuditEvent {
	/** The channel the command was about, or "" (the usual case for O3). */
	channel: string;
	nick: string;
	ident: string;
	host: string;
	/** The services account, when the person was authed. */
	account?: string;
	/** The first word, lowercased. */
	command: string;
	/** The rest of the line as typed. */
	args: string;
	/** What kind of oper action it was, for the Opers rollup. */
	coarse: CoarseKind;
}

/** A module's own log line sent to a channel (`OpServ info: …`). */
export interface ModuleLogEvent {
	facility: string;
	severity: string;
	message: string;
}

/** The services' answer to a ban command, classified. */
export interface BanReply {
	ok: boolean;
	/** The mask the reply names, when it names one. */
	mask?: string;
	/** The reply in the services' own words, formatting stripped. */
	text: string;
}

export type ServicesBanType = "gline" | "shun";

export interface ServicesBanRequest {
	type: ServicesBanType;
	mask: string;
	seconds: number;
	reason: string;
}

export interface ServicesProfile {
	id: ServicesConfig["package"];
	/** Display name (`X3`). */
	name: string;
	/** The package's conventional bot nicks and channels, prefilled when picked. */
	defaults: ServicesConfig["bots"];
	/** A snoop channel line (formatting stripped), or undefined when it is not one. */
	parseSnoop(text: string): SnoopEvent | undefined;
	/** An audit line (formatting stripped), or undefined when it is not one. */
	parseAudit(text: string): AuditEvent | undefined;
	/** A module log line (formatting stripped), or undefined when it is not one. */
	parseModuleLog(text: string): ModuleLogEvent | undefined;
	/** The line that asks the oper service for a ban. */
	banCommand(bot: string, ban: ServicesBanRequest): string;
	/** The oper service's answer to a ban command; undefined when the notice is about something else. */
	parseBanReply(text: string): BanReply | undefined;
	/** Whether `nick` is one of the configured bots. */
	isServiceNick(nick: string, bots: ServicesConfig["bots"]): boolean;
}
