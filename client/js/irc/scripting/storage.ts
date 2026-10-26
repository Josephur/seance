/**
 * Storage and validation for user-defined Lua scripts and script-specific key/value data.
 */

import storage from "../../localStorage";
import type {Script, ScriptStorageBackend} from "./types";

export const STORAGE_KEY = "thelounge.scripts";
export const STORAGE_PREFIX = "thelounge.script_storage.";

export const MAX_SCRIPTS = 50;
export const MAX_NAME_LENGTH = 32;
export const MAX_CODE_LENGTH = 50000;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

let backend: ScriptStorageBackend = storage;

export function useStorageBackend(next: ScriptStorageBackend | null): void {
	backend = next ?? storage;
}

export function isValidScriptName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name);
}

export function isValidScript(entry: unknown): entry is Script {
	if (typeof entry !== "object" || entry === null) {
		return false;
	}

	const {id, name, code, enabled} = entry as Record<string, unknown>;

	return (
		typeof id === "string" &&
		id.length > 0 &&
		typeof name === "string" &&
		isValidScriptName(name) &&
		typeof code === "string" &&
		code.length <= MAX_CODE_LENGTH &&
		typeof enabled === "boolean"
	);
}

export function loadScripts(): Script[] {
	const raw = backend.get(STORAGE_KEY);

	if (!raw) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(raw);

		if (!Array.isArray(parsed)) {
			throw new Error("not a list");
		}

		const list: Script[] = [];
		const seen = new Set<string>();

		for (const item of parsed) {
			if (!isValidScript(item) || seen.has(item.name.toLowerCase())) {
				continue;
			}

			seen.add(item.name.toLowerCase());
			list.push({
				id: item.id,
				name: item.name,
				code: item.code,
				enabled: item.enabled,
				lastError: typeof item.lastError === "string" ? item.lastError : undefined,
				createdAt: typeof item.createdAt === "number" ? item.createdAt : undefined,
			});

			if (list.length >= MAX_SCRIPTS) {
				break;
			}
		}

		return list;
	} catch {
		backend.remove(STORAGE_KEY);
		return [];
	}
}

export function saveScripts(list: Script[]): void {
	if (list.length === 0) {
		backend.remove(STORAGE_KEY);
		return;
	}

	backend.set(STORAGE_KEY, JSON.stringify(list));
}

export function getScript(id: string): Script | undefined {
	return loadScripts().find((s) => s.id === id);
}

export function saveScript(script: Script): void {
	const scripts = loadScripts();
	const index = scripts.findIndex((s) => s.id === script.id);

	if (index >= 0) {
		scripts[index] = script;
	} else {
		scripts.push(script);
	}

	saveScripts(scripts);
}

export function deleteScript(id: string): void {
	const scripts = loadScripts().filter((s) => s.id !== id);
	saveScripts(scripts);
	backend.remove(`${STORAGE_PREFIX}${id}`);
}

export function loadScriptData(scriptId: string): Record<string, string> {
	const raw = backend.get(`${STORAGE_PREFIX}${scriptId}`);

	if (!raw) {
		return {};
	}

	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}

export function saveScriptData(scriptId: string, data: Record<string, string>): void {
	const keys = Object.keys(data);

	if (keys.length === 0) {
		backend.remove(`${STORAGE_PREFIX}${scriptId}`);
		return;
	}

	backend.set(`${STORAGE_PREFIX}${scriptId}`, JSON.stringify(data));
}
