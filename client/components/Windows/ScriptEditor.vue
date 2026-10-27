<template>
	<div id="script-editor" class="window" role="tabpanel" aria-label="Script editor">
		<div class="header">
			<SidebarToggle />
			<h1 class="title">Scripts</h1>
			<span v-if="statusMsg" class="script-editor-status" role="status">{{ statusMsg }}</span>
			<button class="btn script-editor-done" type="button" @click="close">Done</button>
		</div>

		<div v-if="!store.state.settings.enableScripting" class="container">
			<p>
				Scripting is off. Turn on
				<router-link to="/settings">Settings → General → Enable Scripting</router-link>
				to run or edit scripts — while it is off the Lua interpreter is not loaded.
			</p>
		</div>

		<div v-else class="script-editor-body">
			<aside class="script-library" aria-label="Script library">
				<div class="script-library-tools">
					<input
						v-model="query"
						class="input script-search"
						type="search"
						placeholder="Search name, folder, text…"
						aria-label="Search scripts"
						spellcheck="false"
					/>
					<select
						v-model="statusFilter"
						class="input script-filter"
						aria-label="Filter by status"
					>
						<option value="all">All scripts</option>
						<option value="enabled">Active</option>
						<option value="disabled">Disabled</option>
						<option value="error">With errors</option>
					</select>
				</div>

				<nav class="script-folders" aria-label="Folders">
					<button
						type="button"
						class="script-folder"
						:class="{active: folderFilter === null}"
						@click="folderFilter = null"
					>
						All folders <span class="script-count">{{ scripts.length }}</span>
					</button>
					<button
						v-for="folder in folders"
						:key="folder"
						type="button"
						class="script-folder"
						:class="{active: folderFilter === folder}"
						@click="folderFilter = folder"
					>
						{{ folder }}
						<span class="script-count">{{ countInFolder(folder) }}</span>
					</button>
				</nav>

				<div class="script-library-actions">
					<button class="btn" type="button" @click="addNew">New Script</button>
					<button class="btn" type="button" @click="pickImport">Import .lua…</button>
					<input
						ref="importInput"
						type="file"
						class="sr-only"
						accept=".lua,text/plain"
						aria-label="Lua file to import"
						@change="onImportChosen"
					/>
				</div>
				<div class="script-library-actions">
					<button class="btn btn-sm" type="button" @click="addTemplate('responder')">
						Template: Auto-Responder
					</button>
					<button class="btn btn-sm" type="button" @click="addTemplate('slap')">
						Template: /slap
					</button>
				</div>

				<div class="script-list" role="listbox" aria-label="Scripts">
					<template v-for="group in grouped" :key="group.folder">
						<h2 class="script-group-title">{{ group.folder }}</h2>
						<button
							v-for="script in group.scripts"
							:key="script.id"
							type="button"
							role="option"
							class="script-row"
							:class="{
								active: selectedId === script.id,
								'has-error': !!script.lastError,
							}"
							:aria-selected="selectedId === script.id"
							@click="selectedId = script.id"
						>
							<span
								class="script-dot"
								:class="{on: script.enabled, error: !!script.lastError}"
								aria-hidden="true"
							></span>
							<span class="script-row-text">
								<span class="script-row-name">{{ script.name }}</span>
								<span v-if="script.description" class="script-row-desc">{{
									script.description
								}}</span>
								<span class="script-row-state">{{
									script.lastError
										? "Error"
										: script.enabled
										? "Active"
										: "Disabled"
								}}</span>
							</span>
						</button>
					</template>
					<p v-if="grouped.length === 0" class="script-empty">
						No scripts match. Create one or clear the search.
					</p>
				</div>
			</aside>

			<main v-if="selected" class="script-main" aria-label="Editor">
				<div class="script-main-head">
					<input
						v-model.trim="selected.name"
						class="input script-name-input"
						type="text"
						placeholder="script_name"
						maxlength="32"
						aria-label="Script name"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						@input="schedulePersist"
						@change="flushPersist"
					/>
					<label class="script-enable-label">
						<input
							v-model="selected.enabled"
							v-switch
							type="checkbox"
							:aria-label="'Enable script ' + selected.name"
							@change="flushPersist"
						/>
						<span>{{ selected.enabled ? "Active" : "Disabled" }}</span>
					</label>
				</div>

				<div class="script-main-meta">
					<label>
						Folder
						<input
							v-model="selected.folder"
							class="input"
							type="text"
							list="script-folder-list"
							maxlength="40"
							placeholder="Unsorted"
							aria-label="Folder"
							spellcheck="false"
							@input="schedulePersist"
							@change="flushPersist"
						/>
						<datalist id="script-folder-list">
							<option v-for="folder in folders" :key="folder" :value="folder" />
						</datalist>
					</label>
					<label class="script-desc-field">
						Description
						<input
							v-model="selected.description"
							class="input"
							type="text"
							maxlength="120"
							placeholder="What does this script do?"
							aria-label="Description"
							@input="schedulePersist"
							@change="flushPersist"
						/>
					</label>
				</div>

				<div class="script-main-tools">
					<button class="btn btn-sm" type="button" @click="testScript(selected)">
						Check syntax
					</button>
					<button class="btn btn-sm" type="button" @click="duplicate(selected)">
						Duplicate
					</button>
					<button class="btn btn-sm" type="button" @click="exportScript(selected)">
						Export .lua
					</button>
					<button
						class="btn btn-sm script-remove-btn"
						type="button"
						@click="remove(selected)"
					>
						Delete
					</button>
				</div>

				<div v-if="saveError" class="script-error-banner" role="alert">
					<strong>Not saved:</strong> {{ saveError }}
				</div>

				<div v-if="selected.lastError" class="script-error-banner" role="alert">
					<strong>Error:</strong> {{ selected.lastError }}
				</div>

				<div class="script-code-wrap">
					<div ref="gutter" class="script-gutter" aria-hidden="true">
						<span v-for="n in lineCount" :key="n">{{ n }}</span>
					</div>
					<textarea
						ref="codeArea"
						v-model="selected.code"
						:maxlength="maxCodeLength"
						class="input script-code-area"
						aria-label="Lua code"
						placeholder="-- Write your Lua code here"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						wrap="off"
						@input="schedulePersist"
						@change="flushPersist"
						@keydown.tab.prevent="onTab"
						@scroll="syncGutter"
					/>
				</div>
				<p class="script-code-foot">
					{{ lineCount }} lines · {{ selected.code.length }} characters · saved
					automatically
				</p>

				<details class="script-api-ref">
					<summary>Lua API reference</summary>
					<dl>
						<dt><code>seance.on("message", function(msg) ... end)</code></dt>
						<dd>
							Incoming messages. <code>msg</code> has <code>.from</code>,
							<code>.target</code>, <code>.text</code>, <code>.type</code> and
							<code>.self</code>.
						</dd>
						<dt>
							<code
								>seance.register_command("name", function(args, rest) ... end)</code
							>
						</dt>
						<dd>Registers a custom slash command <code>/name</code>.</dd>
						<dt>
							<code>seance.reply(msg, "text")</code> ·
							<code>seance.send("RAW LINE")</code>
						</dt>
						<dd>Reply to a message, or send a raw IRC line on the current network.</dd>
						<dt><code>seance.print("text")</code></dt>
						<dd>Show a local line in the active conversation.</dd>
						<dt><code>seance.storage.get("k") / seance.storage.set("k", "v")</code></dt>
						<dd>Persistent per-script data across restarts.</dd>
						<dt>
							<code
								>seance.current_channel / seance.current_network / seance.nick</code
							>
						</dt>
						<dd>Context of the currently active chat tab.</dd>
					</dl>
				</details>
			</main>

			<main v-else class="script-main script-main-empty">
				<p v-if="scripts.length === 0">
					No scripts yet. Create one, start from a template, or import a
					<code>.lua</code> file.
				</p>
				<p v-else>Select a script in the library to edit it here.</p>
			</main>
		</div>
	</div>
</template>

<style>
#script-editor {
	display: flex;
	flex-direction: column;
	height: 100%;
}

#script-editor .header {
	display: flex;
	align-items: center;
	gap: 0.75rem;
}

/* The toggle is fixed-position elsewhere; in this header it sits in flow. */
#script-editor .header .lt {
	position: relative;
}

#script-editor .header .title {
	flex: 0 0 auto;
	margin: 0;
}

.script-editor-status {
	color: var(--body-color-muted);
	font-size: 0.9rem;
}

.script-editor-done {
	margin-left: auto;
}

.script-editor-body {
	display: flex;
	flex: 1 1 auto;
	min-height: 0;
	gap: 1rem;
	padding: 0 1rem 1rem;
}

.script-library {
	display: flex;
	flex-direction: column;
	gap: 0.6rem;
	width: 19rem;
	flex: 0 0 19rem;
	min-height: 0;
}

.script-library-tools {
	display: flex;
	flex-direction: column;
	gap: 0.4rem;
}

.script-folders {
	display: flex;
	flex-wrap: wrap;
	gap: 0.3rem;
}

.script-folder {
	border: 1px solid var(--window-border-color, rgb(128 128 128 / 30%));
	border-radius: 999px;
	padding: 0.15rem 0.55rem;
	font-size: 0.85rem;
	color: var(--body-color-muted);
	background: transparent;
	cursor: pointer;
}

.script-folder.active {
	color: var(--body-color);
	border-color: var(--button-color);
	font-weight: 600;
}

.script-count {
	opacity: 0.7;
	font-size: 0.8em;
}

.script-library-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.4rem;
}

.script-list {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
}

.script-group-title {
	font-size: 0.8rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--body-color-muted);
	margin: 0.6rem 0 0.2rem;
}

.script-row {
	display: flex;
	gap: 0.5rem;
	align-items: flex-start;
	text-align: left;
	width: 100%;
	padding: 0.45rem 0.55rem;
	border: 1px solid transparent;
	border-radius: 6px;
	background: transparent;
	color: var(--body-color);
	cursor: pointer;
}

.script-row:hover {
	background: var(--window-bg-color);
}

.script-row.active {
	border-color: var(--button-color);
	background: var(--window-bg-color);
}

.script-dot {
	flex: 0 0 auto;
	width: 0.55rem;
	height: 0.55rem;
	border-radius: 50%;
	margin-top: 0.35rem;
	background: var(--body-color-muted);
	opacity: 0.45;
}

.script-dot.on {
	background: var(--button-color);
	opacity: 1;
}

.script-dot.error {
	background: var(--error-color, #e05252);
	opacity: 1;
}

.script-row-text {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.script-row-name {
	font-family: monospace;
	font-weight: 600;
	overflow-wrap: anywhere;
}

.script-row-desc {
	color: var(--body-color-muted);
	font-size: 0.85rem;
	overflow-wrap: anywhere;
}

.script-row-state {
	color: var(--body-color-muted);
	font-size: 0.78rem;
}

.script-row.has-error .script-row-state {
	color: var(--error-color, #e05252);
}

.script-main {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-width: 0;
	min-height: 0;
	gap: 0.55rem;
}

.script-main-empty {
	align-items: center;
	justify-content: center;
	color: var(--body-color-muted);
}

.script-main-head,
.script-main-meta,
.script-main-tools {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}

.script-main-meta label {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	font-size: 0.9rem;
	color: var(--body-color-muted);
}

.script-desc-field {
	flex: 1 1 16rem;
}

.script-desc-field .input {
	flex: 1 1 auto;
}

.script-name-input {
	font-family: monospace;
	font-weight: 600;
	width: 14rem;
}

.script-enable-label {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	cursor: pointer;
}

.script-remove-btn {
	color: var(--error-color, #e05252);
}

.script-error-banner {
	background: rgb(224 82 82 / 12%);
	color: var(--error-color, #e05252);
	padding: 0.4rem 0.6rem;
	border-radius: 4px;
	font-family: monospace;
	font-size: 0.85rem;
}

.script-code-wrap {
	display: flex;
	flex: 1 1 auto;
	min-height: 12rem;
	border: 1px solid var(--window-border-color, rgb(128 128 128 / 30%));
	border-radius: 6px;
	overflow: hidden;
	background: var(--window-bg-color);
}

.script-gutter {
	flex: 0 0 3rem;
	overflow: hidden;
	padding: 0.5rem 0.4rem;
	text-align: right;
	font-family: monospace;
	font-size: 0.9rem;
	line-height: 1.45;
	color: var(--body-color-muted);
	background: rgb(128 128 128 / 8%);
	user-select: none;
}

.script-gutter span {
	display: block;
}

.script-code-area {
	flex: 1 1 auto;
	min-width: 0;
	height: 100%;
	border: 0;
	padding: 0.5rem;
	font-family: monospace;
	font-size: 0.92rem;
	line-height: 1.45;
	tab-size: 4;
	white-space: pre;
	resize: none;
	background: transparent;
	color: inherit;
}

.script-code-foot {
	margin: 0;
	color: var(--body-color-muted);
	font-size: 0.85rem;
}

.script-api-ref summary {
	cursor: pointer;
	font-weight: 600;
}

.script-api-ref dt {
	font-family: monospace;
	font-weight: bold;
	margin-top: 0.5rem;
}

.script-api-ref dd {
	margin-left: 1rem;
	color: var(--body-color-muted);
}

.script-empty {
	color: var(--body-color-muted);
}

@media (max-width: 768px) {
	.script-editor-body {
		flex-direction: column;
		overflow-y: auto;
	}

	.script-library {
		width: 100%;
		flex: 0 0 auto;
	}

	.script-list {
		max-height: 16rem;
	}

	.script-code-wrap {
		min-height: 55vh;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, onUnmounted, ref} from "vue";
import SidebarToggle from "../SidebarToggle.vue";
import {useStore} from "../../js/store";
import {leavePage} from "../../js/router";
import eventbus from "../../js/eventbus";
import {
	compareScripts,
	deleteScript as deleteStoredScript,
	isValidScriptName,
	loadScripts,
	normalizeFolder,
	saveScripts,
	scriptFolders,
	DEFAULT_FOLDER,
	MAX_CODE_LENGTH,
	ScriptStorageError,
} from "../../js/irc/scripting/storage";
import type {Script} from "../../js/irc/scripting/types";
import {scriptManager} from "../../js/irc/scripting/manager";

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function newId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default defineComponent({
	name: "ScriptEditor",
	components: {SidebarToggle},
	setup() {
		const store = useStore();
		const scripts = ref<Script[]>(loadScripts().sort(compareScripts));
		const selectedId = ref<string | undefined>(scripts.value[0]?.id);
		const query = ref("");
		const statusFilter = ref<"all" | "enabled" | "disabled" | "error">("all");
		const folderFilter = ref<string | null>(null);
		const statusMsg = ref("");
		const saveError = ref("");
		const importInput = ref<HTMLInputElement>();
		const codeArea = ref<HTMLTextAreaElement>();
		const gutter = ref<HTMLElement>();

		const selected = computed(() => scripts.value.find((s) => s.id === selectedId.value));
		const folders = computed(() => scriptFolders(scripts.value));
		const lineCount = computed(() =>
			selected.value ? selected.value.code.split("\n").length : 1
		);

		const grouped = computed(() => {
			const q = query.value.trim().toLowerCase();
			const visible = scripts.value.filter((script) => {
				if (
					folderFilter.value &&
					normalizeFolder(script.folder).toLowerCase() !==
						folderFilter.value.toLowerCase()
				) {
					return false;
				}

				if (statusFilter.value === "enabled" && !script.enabled) {
					return false;
				}

				if (statusFilter.value === "disabled" && script.enabled) {
					return false;
				}

				if (statusFilter.value === "error" && !script.lastError) {
					return false;
				}

				if (!q) {
					return true;
				}

				return [script.name, script.folder, script.description ?? "", script.code]
					.join("\n")
					.toLowerCase()
					.includes(q);
			});
			const groups: {folder: string; scripts: Script[]}[] = [];

			for (const folder of scriptFolders(visible)) {
				groups.push({
					folder,
					scripts: visible
						.filter(
							(s) => normalizeFolder(s.folder).toLowerCase() === folder.toLowerCase()
						)
						.sort(compareScripts),
				});
			}

			return groups;
		});

		const countInFolder = (folder: string) =>
			scripts.value.filter(
				(s) => normalizeFolder(s.folder).toLowerCase() === folder.toLowerCase()
			).length;

		const flash = (msg: string) => {
			statusMsg.value = msg;
			setTimeout(() => {
				if (statusMsg.value === msg) {
					statusMsg.value = "";
				}
			}, 2500);
		};

		const persistNow = () => {
			for (const script of scripts.value) {
				script.folder = normalizeFolder(script.folder);
				script.updatedAt = Date.now();
			}

			scripts.value.sort(compareScripts);

			try {
				saveScripts(scripts.value);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				saveError.value = err.message;
				return false;
			}

			saveError.value = "";
			void scriptManager.reload();
			return true;
		};

		const schedulePersist = () => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				if (persistNow()) {
					flash("Saved");
				}
			}, 600);
		};

		const flushPersist = () => {
			clearTimeout(saveTimer);

			if (persistNow()) {
				flash("Saved");
			}
		};

		onUnmounted(() => {
			if (saveTimer) {
				clearTimeout(saveTimer);
				persistNow();
			}
		});

		const uniqueName = (base: string) => {
			let name = base;
			let n = 2;

			while (scripts.value.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
				name = `${base}_${n++}`;
			}

			return name;
		};

		const push = (script: Script) => {
			scripts.value.push(script);
			selectedId.value = script.id;
			folderFilter.value = null;
			statusFilter.value = "all";
			query.value = "";
			flushPersist();
		};

		const addNew = () => {
			let num = scripts.value.length + 1;
			let name = `script_${num}`;

			while (scripts.value.some((s) => s.name === name)) {
				name = `script_${++num}`;
			}

			push({
				id: newId(),
				name,
				folder: folderFilter.value ?? DEFAULT_FOLDER,
				code: `-- ${name}\nseance.print('Loaded ${name}!')\n`,
				enabled: true,
				createdAt: Date.now(),
			});
		};

		const addTemplate = (kind: "responder" | "slap") => {
			if (kind === "responder") {
				push({
					id: newId(),
					name: uniqueName("auto_ping"),
					folder: "Automation",
					description: "Replies pong! to !ping",
					code: `-- Auto-responder example\nseance.on("message", function(msg)\n    if msg.text == "!ping" and not msg.self then\n        seance.reply(msg, "pong! " .. seance.nick)\n    end\nend)`,
					enabled: true,
					createdAt: Date.now(),
				});
			} else {
				push({
					id: newId(),
					name: uniqueName("slap_cmd"),
					folder: "Commands",
					description: "Adds a /slap command",
					code: `-- Custom /slap command\nseance.register_command("slap", function(args, rest)\n    local target = rest ~= "" and rest or "themselves"\n    local chan = seance.current_channel\n    if chan ~= "" then\n        seance.send("PRIVMSG " .. chan .. " :\\001ACTION slaps " .. target .. " with a large trout\\001")\n    end\nend)`,
					enabled: true,
					createdAt: Date.now(),
				});
			}
		};

		const duplicate = (script: Script) => {
			push({
				...script,
				id: newId(),
				name: uniqueName(`${script.name}_copy`.slice(0, 32)),
				createdAt: Date.now(),
				lastError: undefined,
			});
		};

		const remove = (script: Script) => {
			eventbus.emit(
				"confirm-dialog",
				{
					title: `Delete script “${script.name}”?`,
					text: "This deletes the script and its saved data. This cannot be undone.",
					button: "Delete",
				},
				(confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					deleteStoredScript(script.id);
					scripts.value = scripts.value.filter((s) => s.id !== script.id);

					if (selectedId.value === script.id) {
						selectedId.value = scripts.value[0]?.id;
					}

					void scriptManager.reload();
					flash("Deleted");
				}
			);
		};

		const testScript = async (script: Script) => {
			flushPersist();
			flash("Checking…");

			if (!isValidScriptName(script.name)) {
				script.lastError = "Invalid script name (letters, digits, _ and -, max 32).";
				persistNow();
				flash("Invalid name");
				return;
			}

			const res = await scriptManager.evalSnippet(script.code);

			if (res.success) {
				script.lastError = undefined;
				flash("Syntax OK!");
			} else {
				script.lastError = res.error;
				flash("Syntax error");
			}

			// Not flushPersist: that would flash "Saved" over the verdict.
			persistNow();
		};

		const exportScript = (script: Script) => {
			const blob = new Blob([script.code], {type: "text/plain"});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${script.name}.lua`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		};

		const pickImport = () => importInput.value?.click();

		const onImportChosen = async (event: Event) => {
			const input = event.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = "";

			if (!file) {
				return;
			}

			// Characters are at most four bytes: refuse before reading a huge file.
			if (file.size > MAX_CODE_LENGTH * 4) {
				flash(`${file.name} is too long to import`);
				return;
			}

			const code = await file.text();

			if (code.length > MAX_CODE_LENGTH) {
				flash(`${file.name} is over ${MAX_CODE_LENGTH.toLocaleString("en")} characters`);
				return;
			}

			const base =
				file.name
					.replace(/\.lua$/i, "")
					.toLowerCase()
					.replace(/[^a-z0-9_-]+/g, "_")
					.replace(/^[^a-z0-9]+/, "")
					.slice(0, 32) || "imported_script";
			push({
				id: newId(),
				name: uniqueName(base),
				folder: folderFilter.value ?? DEFAULT_FOLDER,
				code,
				enabled: true,
				createdAt: Date.now(),
			});
			flash(`Imported ${file.name}`);
		};

		const onTab = (event: KeyboardEvent) => {
			const area = codeArea.value;

			if (!area || !selected.value) {
				return;
			}

			const {selectionStart, selectionEnd, value} = area;
			selected.value.code =
				value.slice(0, selectionStart) + "    " + value.slice(selectionEnd);
			requestAnimationFrame(() => {
				area.selectionStart = area.selectionEnd = selectionStart + 4;
			});
			schedulePersist();
		};

		const syncGutter = () => {
			if (gutter.value && codeArea.value) {
				gutter.value.scrollTop = codeArea.value.scrollTop;
			}
		};

		const close = () => {
			flushPersist();
			leavePage();
		};

		return {
			store,
			scripts,
			selected,
			selectedId,
			query,
			statusFilter,
			folderFilter,
			folders,
			grouped,
			countInFolder,
			lineCount,
			statusMsg,
			saveError,
			maxCodeLength: MAX_CODE_LENGTH,
			importInput,
			codeArea,
			gutter,
			schedulePersist,
			flushPersist,
			addNew,
			addTemplate,
			duplicate,
			remove,
			testScript,
			exportScript,
			pickImport,
			onImportChosen,
			onTab,
			syncGutter,
			close,
		};
	},
});
</script>
