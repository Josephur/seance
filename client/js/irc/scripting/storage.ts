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
export const MAX_FOLDER_LENGTH = 40;
export const MAX_DESCRIPTION_LENGTH = 120;
export const DEFAULT_FOLDER = "Unsorted";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * A folder is a short free-text label (letters, digits, spaces and a few
 * marks). Anything else — empty, over-long, path-like — files the script
 * under {@link DEFAULT_FOLDER}, so a damaged entry can never invent a
 * folder the library cannot render.
 */
export function normalizeFolder(folder: unknown): string {
	if (typeof folder !== "string") {
		return DEFAULT_FOLDER;
	}

	const trimmed = folder.trim().replace(/\s+/g, " ");

	if (trimmed.length === 0 || trimmed.length > MAX_FOLDER_LENGTH || /[/\\]/.test(trimmed)) {
		return DEFAULT_FOLDER;
	}

	return trimmed;
}

export function normalizeDescription(description: unknown): string | undefined {
	if (typeof description !== "string") {
		return undefined;
	}

	const trimmed = description.trim().replace(/\s+/g, " ");
	return trimmed.length > 0 && trimmed.length <= MAX_DESCRIPTION_LENGTH ? trimmed : undefined;
}

/** Distinct folders in use, in library order (case-insensitive, Unsorted last). */
export function scriptFolders(scripts: Script[]): string[] {
	const seen = new Map<string, string>();

	for (const script of scripts) {
		const folder = normalizeFolder(script.folder);

		if (!seen.has(folder.toLowerCase())) {
			seen.set(folder.toLowerCase(), folder);
		}
	}

	return [...seen.values()].sort((a, b) => {
		if (a === DEFAULT_FOLDER) {
			return 1;
		}

		if (b === DEFAULT_FOLDER) {
			return -1;
		}

		return a.localeCompare(b);
	});
}

/** Library order: by folder (Unsorted last), then by name. */
export function compareScripts(a: Script, b: Script): number {
	const folderA = normalizeFolder(a.folder);
	const folderB = normalizeFolder(b.folder);

	if (folderA.toLowerCase() !== folderB.toLowerCase()) {
		if (folderA === DEFAULT_FOLDER) {
			return 1;
		}

		if (folderB === DEFAULT_FOLDER) {
			return -1;
		}

		return folderA.toLowerCase().localeCompare(folderB.toLowerCase());
	}

	return a.name.localeCompare(b.name);
}

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
			// Entries written before folders existed have no folder: they
			// land in Unsorted rather than being dropped.
			const entry = item as unknown as Record<string, unknown>;
			list.push({
				id: item.id,
				name: item.name,
				code: item.code,
				enabled: item.enabled,
				folder: normalizeFolder(entry.folder),
				description: normalizeDescription(entry.description),
				lastError: typeof item.lastError === "string" ? item.lastError : undefined,
				createdAt: typeof item.createdAt === "number" ? item.createdAt : undefined,
				updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : undefined,
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
