<template>
	<div class="settings-script-edit" role="group" aria-label="Edit script">
		<div class="script-top">
			<router-link class="script-back" to="/settings/scripts">← Scripts</router-link>
			<span class="script-status" role="status">{{ statusMsg }}</span>
			<div v-if="script" class="script-tools">
				<button class="btn btn-sm" type="button" @click="checkSyntax">Check syntax</button>
				<button class="btn btn-sm" type="button" @click="duplicate">Duplicate</button>
				<button class="btn btn-sm" type="button" @click="exportScript">Export .lua</button>
				<button class="btn btn-sm script-delete" type="button" @click="remove">
					Delete
				</button>
			</div>
		</div>

		<p v-if="!script" class="script-missing">
			This script is gone — deleted here or in another tab.
		</p>

		<template v-else>
			<div class="script-head">
				<label class="script-field script-name-field">
					<span>Name</span>
					<input
						v-model.trim="nameDraft"
						class="input script-name"
						:class="{invalid: nameError !== null}"
						type="text"
						placeholder="script_name"
						:maxlength="maxNameLength"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						:aria-invalid="nameError !== null"
						@input="onNameInput"
						@change="commit"
					/>
				</label>
				<label class="opt script-run">
					<input
						v-model="script.enabled"
						v-switch
						type="checkbox"
						@change="onRunChange"
					/>
					Run this script
				</label>
			</div>
			<p v-if="nameError" class="script-error-line" role="alert">{{ nameError }}</p>

			<div class="script-meta">
				<label class="script-field">
					<span>Folder</span>
					<input
						v-model="script.folder"
						class="input"
						type="text"
						list="script-folder-list"
						:maxlength="maxFolderLength"
						:placeholder="defaultFolder"
						spellcheck="false"
						@input="schedulePersist"
						@change="commit"
					/>
					<datalist id="script-folder-list">
						<option v-for="folder in folders" :key="folder" :value="folder" />
					</datalist>
				</label>
				<label class="script-field script-desc-field">
					<span>Description</span>
					<input
						v-model="script.description"
						class="input"
						type="text"
						:maxlength="maxDescriptionLength"
						placeholder="What does this script do?"
						@input="schedulePersist"
						@change="commit"
					/>
				</label>
			</div>

			<div v-if="saveError" class="script-banner" role="alert">
				<strong>Not saved:</strong> {{ saveError }}
			</div>
			<div v-if="script.lastError" class="script-banner" role="alert">
				<strong>Error:</strong> {{ script.lastError }}
			</div>

			<div class="script-code-wrap">
				<div ref="gutter" class="script-gutter" aria-hidden="true">
					<span v-for="n in lineCount" :key="n">{{ n }}</span>
				</div>
				<textarea
					ref="codeArea"
					v-model="script.code"
					:maxlength="maxCodeLength"
					class="script-code"
					aria-label="Lua code"
					aria-describedby="script-code-foot"
					placeholder="-- Write your Lua code here"
					spellcheck="false"
					autocapitalize="off"
					autocomplete="off"
					wrap="off"
					@input="schedulePersist"
					@change="commit"
					@keydown.tab.exact="onTab"
					@scroll="syncGutter"
				/>
			</div>
			<p id="script-code-foot" class="script-foot">
				{{ lineCount }} lines · {{ script.code.length }} characters
			</p>

			<details class="script-api">
				<summary>Lua API reference</summary>
				<dl>
					<dt><code>seance.on("message", function(msg) ... end)</code></dt>
					<dd>
						Incoming messages. <code>msg</code> has <code>.from</code>,
						<code>.target</code>, <code>.text</code>, <code>.type</code> and
						<code>.self</code>.
					</dd>
					<dt>
						<code>seance.register_command("name", function(args, rest) ... end)</code>
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
						<code>seance.current_channel / seance.current_network / seance.nick</code>
					</dt>
					<dd>Context of the currently active chat tab.</dd>
				</dl>
			</details>
		</template>
	</div>
</template>

<style>
/* Settings.vue widens the column for this page: code wants the room. */
.settings-script-edit .script-top {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
	margin: 20px 0 0.75rem;
}

.settings-script-edit .script-missing {
	color: var(--body-color-muted);
}

.settings-script-edit .script-head,
.settings-script-edit .script-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: 0 1rem;
}

.settings-script-edit .script-field {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.settings-script-edit .script-field .input {
	font-size: 1rem;
	margin-bottom: 0.75rem;
}

.settings-script-edit .script-name-field,
.settings-script-edit .script-desc-field {
	flex: 1 1 14rem;
}

.settings-script-edit .script-name {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-weight: bold;
}

.settings-script-edit .script-name.invalid {
	border-color: #e74c3c;
}

.settings-script-edit .script-run {
	padding-bottom: 1.1rem;
}

.settings-script-edit .script-error-line {
	color: #e74c3c;
	font-size: 0.875em;
	margin-top: -0.5rem;
}

.settings-script-edit .script-banner {
	margin-bottom: 0.5rem;
	padding: 0.4rem 0.6rem;
	border-radius: 4px;
	background: rgb(231 76 60 / 12%);
	color: #e74c3c;
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-size: 0.875em;
	overflow-wrap: anywhere;
}

/* A fixed height the user can drag taller: the settings body scrolls, so
 * the editor must not try to fill it. */
.settings-script-edit .script-code-wrap {
	display: flex;
	height: 20rem;
	min-height: 8rem;
	resize: vertical;
	overflow: hidden;
	border: 1px solid rgb(128 128 128 / 30%);
	border-radius: 4px;
	background: var(--window-bg-color);
}

.settings-script-edit .script-code-wrap:focus-within {
	box-shadow: 0 0 0 3px rgb(132 206 136 / 50%);
}

.settings-script-edit .script-gutter,
.settings-script-edit .script-code {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-size: 0.875rem;
	line-height: 1.45;
	padding: 0.5rem;
}

.settings-script-edit .script-gutter {
	flex: 0 0 auto;
	min-width: 3ch;
	overflow: hidden;
	text-align: right;
	color: var(--body-color-muted);
	background: rgb(128 128 128 / 8%);
	user-select: none;
}

.settings-script-edit .script-gutter span {
	display: block;
}

.settings-script-edit .script-code {
	flex: 1 1 auto;
	min-width: 0;
	border: 0;
	outline: 0;
	resize: none;
	tab-size: 4;
	white-space: pre;
	background: transparent;
	color: inherit;
}

.settings-script-edit .script-foot {
	margin: 0.25rem 0 0;
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.settings-script-edit .script-tools {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}

.settings-script-edit .script-status {
	margin-left: auto;
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.settings-script-edit .script-tools .btn {
	margin: 0;
}

.settings-script-edit .script-tools .script-delete {
	border-color: #e74c3c;
	color: #e74c3c;
}

.settings-script-edit .script-tools .script-delete:hover,
.settings-script-edit .script-tools .script-delete:focus {
	background: #e74c3c;
	color: #fff;
}

.settings-script-edit .script-api {
	margin-top: 1.25rem;
}

.settings-script-edit .script-api summary {
	cursor: pointer;
	font-weight: bold;
}

.settings-script-edit .script-api dt {
	margin-top: 0.5rem;
}

.settings-script-edit .script-api dd {
	margin-left: 1rem;
	color: var(--body-color-muted);
}
</style>

<script lang="ts">
import {computed, defineComponent, onUnmounted, ref} from "vue";
import {useRoute} from "vue-router";
import eventbus from "../../js/eventbus";
import {navigate} from "../../js/router";
import {
	deleteScript,
	getScript,
	loadScripts,
	normalizeFolder,
	saveScript,
	scriptFolders,
	DEFAULT_FOLDER,
	MAX_CODE_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_FOLDER_LENGTH,
	MAX_NAME_LENGTH,
	ScriptStorageError,
} from "../../js/irc/scripting/storage";
import {newScriptId, scriptNameError, uniqueScriptName} from "../../js/irc/scripting/library";
import type {Script} from "../../js/irc/scripting/types";
import {scriptManager} from "../../js/irc/scripting/manager";

/**
 * One script, edited in place and saved as it is typed (600 ms after the
 * last key). The sandbox reloads only when an edit is committed — the field
 * loses the caret, the switch flips, the page is left — so a script's
 * top-level code does not run again at every pause in the typing.
 */
export default defineComponent({
	name: "ScriptEdit",
	setup() {
		const route = useRoute();
		const id = String(route.params.id);
		const script = ref<Script | undefined>(getScript(id));
		const nameDraft = ref(script.value?.name ?? "");
		const statusMsg = ref("");
		const saveError = ref("");
		const codeArea = ref<HTMLTextAreaElement>();
		const gutter = ref<HTMLElement>();
		let saveTimer: ReturnType<typeof setTimeout> | undefined;
		let flashTimer: ReturnType<typeof setTimeout> | undefined;
		let dirty = false;

		const folders = computed(() => scriptFolders(loadScripts()));
		const lineCount = computed(() => (script.value ? script.value.code.split("\n").length : 1));
		const nameError = computed(() =>
			script.value ? scriptNameError(loadScripts(), nameDraft.value, id) : null
		);

		const flash = (msg: string) => {
			statusMsg.value = msg;
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => (statusMsg.value = ""), 2500);
		};

		// The manager records load and run errors in storage; the banner
		// follows what it last wrote.
		const refreshError = () => {
			if (script.value) {
				script.value.lastError = getScript(id)?.lastError;
			}
		};

		const write = (next: Script): boolean => {
			try {
				saveScript(next);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				saveError.value = err.message;
				return false;
			}

			saveError.value = "";
			return true;
		};

		const persistNow = (): boolean => {
			clearTimeout(saveTimer);
			saveTimer = undefined;

			if (!script.value) {
				return false;
			}

			refreshError();
			const ok = write({
				...script.value,
				folder: normalizeFolder(script.value.folder),
				description: script.value.description?.trim() || undefined,
				updatedAt: Date.now(),
			});

			if (ok) {
				dirty = true;
				flash("Saved");
			}

			return ok;
		};

		const schedulePersist = () => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(persistNow, 600);
		};

		// Save what is pending and run the library again with it.
		const commit = async () => {
			if (saveTimer !== undefined) {
				persistNow();
			}

			if (!dirty) {
				return;
			}

			dirty = false;
			await scriptManager.reload();
			refreshError();
		};

		const onRunChange = () => {
			persistNow();
			void commit();
		};

		const onNameInput = () => {
			if (script.value && nameError.value === null && nameDraft.value !== script.value.name) {
				script.value.name = nameDraft.value;
				schedulePersist();
			}
		};

		onUnmounted(() => {
			clearTimeout(flashTimer);

			if (saveTimer !== undefined || dirty) {
				void commit();
			}
		});

		const checkSyntax = async () => {
			if (!script.value) {
				return;
			}

			persistNow();
			flash("Checking…");
			// Compiled, never run: running it would fire its top-level code
			// and register its handlers a second time.
			const error = await scriptManager.checkSyntax(script.value.code);

			if (!script.value) {
				return;
			}

			script.value.lastError = error;
			write({...script.value});
			flash(error === undefined ? "Syntax OK" : "Syntax error");
		};

		const duplicate = () => {
			if (!script.value || !persistNow()) {
				return;
			}

			const copy: Script = {
				...script.value,
				id: newScriptId(),
				name: uniqueScriptName(loadScripts(), `${script.value.name}_copy`),
				enabled: false,
				lastError: undefined,
				createdAt: Date.now(),
				updatedAt: undefined,
			};

			if (write(copy)) {
				void navigate("ScriptEdit", {id: copy.id});
			}
		};

		const remove = () => {
			if (!script.value) {
				return;
			}

			eventbus.emit(
				"confirm-dialog",
				{
					title: `Delete script “${script.value.name}”?`,
					text: "This deletes the script and its saved data. This cannot be undone.",
					button: "Delete",
				},
				(confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					clearTimeout(saveTimer);
					saveTimer = undefined;
					dirty = false;
					deleteScript(id);
					script.value = undefined;
					void scriptManager.reload();
					void navigate("Scripts");
				}
			);
		};

		const exportScript = () => {
			if (!script.value) {
				return;
			}

			const blob = new Blob([script.value.code], {type: "text/plain"});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${script.value.name}.lua`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		};

		// Tab indents; Shift+Tab still leaves the field, so the keyboard is
		// never trapped in it.
		const onTab = (event: KeyboardEvent) => {
			const area = codeArea.value;

			if (!area || !script.value) {
				return;
			}

			event.preventDefault();
			const {selectionStart, selectionEnd, value} = area;
			script.value.code = value.slice(0, selectionStart) + "    " + value.slice(selectionEnd);
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

		return {
			script,
			nameDraft,
			nameError,
			statusMsg,
			saveError,
			folders,
			lineCount,
			codeArea,
			gutter,
			defaultFolder: DEFAULT_FOLDER,
			maxNameLength: MAX_NAME_LENGTH,
			maxFolderLength: MAX_FOLDER_LENGTH,
			maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
			maxCodeLength: MAX_CODE_LENGTH,
			schedulePersist,
			commit,
			onRunChange,
			onNameInput,
			checkSyntax,
			duplicate,
			remove,
			exportScript,
			onTab,
			syncGutter,
		};
	},
});
</script>
