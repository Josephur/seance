/**
 * The services feed (docs/projects/oper-tools.md, "Services support"):
 * what a network's services write into their channels, kept the way server
 * notices are. A snoop line in the snoop channel (a connect, a join, a
 * kill) and an audit line in the report channel (a command somebody made
 * services run) are parsed by the services profile and appended to the
 * notice log as `snoop` / `audit` entries — for the Opers rollup, credited
 * to the person who typed the command rather than to the bot, and for the
 * kept feed. Nothing is routed and nothing is re-rendered: the channel
 * shows the lines as the ordinary channel messages they are.
 *
 * Only lines from the configured bots count, in the configured channels;
 * a user chatting in the snoop channel is chat. Kept free of store/DOM
 * imports (mocha, test/irc/services.ts).
 */

import {ChanType} from "../../../shared/types/chan";
import type {ServicesConfig} from "../../../shared/types/network";
import type {SnoticeInfo} from "../../../shared/types/oper";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";
import type {LoggedNotice} from "./noticelog";
import {servicesProfileFor} from "./services/index";
import type {ServicesProfile} from "./services/types";
import {cleanIrcMessage as stripFormatting} from "../../../shared/irc";

/** The category every services entry carries (its badge reads "services"). */
export const SERVICES_CATEGORY = "SERVICES";

function fromConfiguredBot(
	client: IrcClient,
	msg: IrcMessage,
	bots: ServicesConfig["bots"]
): boolean {
	const from = msg.source?.name;

	if (!from || msg.source?.user === undefined) {
		return false;
	}

	return [bots.oper, bots.account, bots.channel].some(
		(bot) => bot !== "" && client.namesEqual(bot, from)
	);
}

function inChannel(client: IrcClient, target: string, wanted: string): boolean {
	return wanted !== "" && client.namesEqual(target, wanted);
}

/** The log entry a snoop or audit line becomes, or undefined when it is neither. */
export function servicesEntry(
	profile: ServicesProfile,
	where: {inSnoop: boolean; inReport: boolean},
	text: string,
	time: number
): LoggedNotice | undefined {
	if (where.inSnoop) {
		const snoop = profile.parseSnoop(text);

		if (snoop) {
			const info: SnoticeInfo = {
				kind: `${profile.id}.snoop.${snoop.keyword}`,
				category: SERVICES_CATEGORY,
				fields: snoop.fields,
				route: "network",
			};
			return {time, type: "snoop", text, snotice: info};
		}
	}

	if (where.inReport) {
		const audit = profile.parseAudit(text);

		if (audit) {
			const fields: Record<string, string> = {
				nick: audit.nick,
				ident: audit.ident,
				host: audit.host,
				command: audit.command,
				args: audit.args,
			};

			if (audit.channel) {
				fields.channel = audit.channel;
			}

			if (audit.account) {
				fields.account = audit.account;
			}

			return {
				time,
				type: "audit",
				text,
				from: audit.nick,
				snotice: {
					kind: `${profile.id}.audit.${audit.coarse}`,
					category: SERVICES_CATEGORY,
					fields,
					route: "network",
				},
			};
		}

		const log = profile.parseModuleLog(text);

		if (log) {
			return {
				time,
				type: "audit",
				text,
				snotice: {
					kind: `${profile.id}.log.${log.severity}`,
					category: SERVICES_CATEGORY,
					fields: {facility: log.facility, severity: log.severity, message: log.message},
					route: "network",
				},
			};
		}
	}

	return undefined;
}

/**
 * Called from the PRIVMSG handler for every live channel message, before
 * it is shown: keeps the line when it is a services line in a configured
 * channel. Never changes the message.
 */
export function noteServicesLine(client: IrcClient, msg: IrcMessage): void {
	const services = client.services;
	const profile = servicesProfileFor(services);

	if (!services || !profile || client.replaying || msg.command !== "PRIVMSG") {
		return;
	}

	const target = msg.params[0] ?? "";
	const where = {
		inSnoop: inChannel(client, target, services.bots.snoop),
		inReport: inChannel(client, target, services.bots.report),
	};

	if (!where.inSnoop && !where.inReport) {
		return;
	}

	const chan = client.findChannel(target);

	if (!chan || chan.type !== ChanType.CHANNEL || !fromConfiguredBot(client, msg, services.bots)) {
		return;
	}

	const text = stripFormatting(msg.params[msg.params.length - 1] ?? "");
	const entry = servicesEntry(profile, where, text, client.timeOf(msg).getTime());

	if (entry) {
		client.noticeLog.append(entry);
	}
}
