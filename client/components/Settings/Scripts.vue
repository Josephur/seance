<template>
	<div class="settings-scripts" role="group" aria-label="Lua scripts">
		<h2>Lua Scripts</h2>
		<p class="script-intro">
			Write custom client automation and slash commands using Lua. Scripts run safely in a
			sandboxed runtime.
		</p>

		<div v-if="scripts.length" class="script-list">
			<div
				v-for="(script, index) in scripts"
				:key="script.id"
				class="script-card"
				:class="{'script-card-error': !!script.lastError}"
			>
				<div class="script-card-header">
					<div class="script-card-meta">
						<label class="script-enable-label">
							<input
								v-model="script.enabled"
								v-switch
								type="checkbox"
								:aria-label="'Enable script ' + script.name"
								@change="onToggle(script)"
							/>
							<span class="script-status-badge" :class="{enabled: script.enabled}">
								{{ script.enabled ? "Active" : "Disabled" }}
							</span>
						</label>
						<input
							v-model.trim="script.name"
							class="input script-name-input"
							type="text"
							placeholder="script_name"
							maxlength="32"
							spellcheck="false"
							autocapitalize="off"
							autocomplete="off"
							@change="persist"
						/>
					</div>

					<div class="script-card-tools">
						<button
							class="btn btn-sm"
							type="button"
							title="Test syntax"
							@click="testScript(script)"
						>
							Check
						</button>
						<button
							class="btn btn-sm script-remove-btn"
							type="button"
							:aria-label="'Delete script ' + script.name"
							@click="remove(index)"
						>
							Delete
						</button>
					</div>
				</div>

				<div v-if="script.lastError" class="script-error-banner" role="alert">
					<strong>Error:</strong> {{ script.lastError }}
				</div>

				<div class="script-editor-wrap">
					<textarea
						v-model="script.code"
						class="input script-code-area"
						rows="6"
						placeholder="-- Write your Lua code here&#10;seance.on('message', function(msg)&#10;    -- ...&#10;end)"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						@change="persist"
					/>
				</div>
			</div>
		</div>
		<p v-else class="script-empty">No Lua scripts configured yet.</p>

		<div class="script-actions">
			<button class="btn" type="button" @click="addNew">New Script</button>
			<button class="btn" type="button" @click="addTemplate('responder')">
				+ Template: Auto-Responder
			</button>
			<button class="btn" type="button" @click="addTemplate('slap')">
				+ Template: /slap Command
			</button>
			<span v-if="statusMsg" class="script-status-text" role="status">{{ statusMsg }}</span>
		</div>

		<h2>Lua API Reference</h2>
		<dl class="script-api-ref">
			<dt><code>seance.on("message", function(msg) ... end)</code></dt>
			<dd>
				Called on incoming messages. <code>msg</code> has <code>.from</code>,
				<code>.target</code>, <code>.text</code>, <code>.type</code> ("message", "notice",
				"action"), and <code>.self</code>.
			</dd>

			<dt><code>seance.register_command("name", function(args, rest) ... end)</code></dt>
			<dd>
				Registers a custom slash command <code>/name</code>. Available in chat
				autocompletion.
			</dd>

			<dt><code>seance.reply(msg, "response text")</code></dt>
			<dd>Quickly replies back to the channel or person who sent <code>msg</code>.</dd>

			<dt><code>seance.send("RAW IRC LINE")</code></dt>
			<dd>Sends a raw line to the IRC server on the current network.</dd>

			<dt><code>seance.print("Local message text")</code></dt>
			<dd>Displays a local message line in the active conversation window.</dd>

			<dt><code>seance.storage.get("key") / seance.storage.set("key", "val")</code></dt>
			<dd>Saves and retrieves persistent data for this script across restarts.</dd>

			<dt><code>seance.current_channel / seance.current_network / seance.nick</code></dt>
			<dd>Context properties for the currently active chat tab.</dd>
		</dl>
	</div>
</template>

<style>
.settings-scripts .script-intro,
.settings-scripts .script-empty {
	color: var(--body-color-muted);
}

.settings-scripts .script-list {
	display: flex;
	flex-direction: column;
	gap: 1rem;
	margin-bottom: 1.25rem;
}

.settings-scripts .script-card {
	background: var(--window-bg-color);
	border: 1px solid var(--window-border-color, rgb(128 128 128 / 25%));
	border-radius: 6px;
	padding: 0.75rem;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.settings-scripts .script-card-error {
	border-color: var(--error-color, #e05252);
}

.settings-scripts .script-card-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.5rem;
}

.settings-scripts .script-card-meta {
	display: flex;
	align-items: center;
	gap: 0.75rem;
}

.settings-scripts .script-enable-label {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	cursor: pointer;
}

.settings-scripts .script-status-badge {
	font-size: 0.8rem;
	color: var(--body-color-muted);
}

.settings-scripts .script-status-badge.enabled {
	color: var(--button-color);
	font-weight: bold;
}

.settings-scripts .script-name-input {
	font-family: monospace;
	font-weight: 600;
	padding: 0.25rem 0.5rem;
	width: 12rem;
}

.settings-scripts .script-card-tools {
	display: flex;
	gap: 0.4rem;
}

.settings-scripts .script-remove-btn {
	color: var(--error-color, #e05252);
}

.settings-scripts .script-error-banner {
	background: rgb(224 82 82 / 12%);
	color: var(--error-color, #e05252);
	padding: 0.4rem 0.6rem;
	border-radius: 4px;
	font-size: 0.85rem;
	font-family: monospace;
}

.settings-scripts .script-code-area {
	font-family: monospace;
	font-size: 0.9rem;
	line-height: 1.4;
	tab-size: 4;
	white-space: pre;
	width: 100%;
	resize: vertical;
}

.settings-scripts .script-actions {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	flex-wrap: wrap;
	margin-bottom: 1.5rem;
}

.settings-scripts .script-status-text {
	font-size: 0.9rem;
	color: var(--body-color-muted);
	margin-left: 0.5rem;
}

.settings-scripts .script-api-ref dt {
	font-family: monospace;
	font-weight: bold;
	margin-top: 0.5rem;
}

.settings-scripts .script-api-ref dd {
	margin-left: 1rem;
	color: var(--body-color-muted);
}
</style>

<script lang="ts">
import {defineComponent, ref} from "vue";
import {
	loadScripts,
	saveScripts,
	deleteScript,
	isValidScriptName,
	type Script,
} from "../../js/irc/scripting/storage";
import {scriptManager} from "../../js/irc/scripting/manager";

export default defineComponent({
	name: "ScriptSettings",
	setup() {
		const scripts = ref<Script[]>(loadScripts());
		const statusMsg = ref<string>("");

		const persist = () => {
			saveScripts(scripts.value);
			void scriptManager.reload();
			statusMsg.value = "Saved";
			setTimeout(() => {
				if (statusMsg.value === "Saved") {
					statusMsg.value = "";
				}
			}, 2000);
		};

		const onToggle = (script: Script) => {
			persist();
		};

		const remove = (index: number) => {
			const target = scripts.value[index];

			if (target) {
				deleteScript(target.id);
				scripts.value.splice(index, 1);
				void scriptManager.reload();
			}
		};

		const addNew = () => {
			const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			let num = scripts.value.length + 1;
			let name = `script_${num}`;

			while (scripts.value.some((s) => s.name === name)) {
				num++;
				name = `script_${num}`;
			}

			const newScript: Script = {
				id,
				name,
				code: "-- " + name + "\nseance.print('Loaded " + name + "!')\n",
				enabled: true,
				createdAt: Date.now(),
			};
			scripts.value.push(newScript);
			persist();
		};

		const addTemplate = (kind: "responder" | "slap") => {
			const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

			if (kind === "responder") {
				scripts.value.push({
					id,
					name: "auto_ping",
					code: `-- Auto-responder example
seance.on("message", function(msg)
    if msg.text == "!ping" and not msg.self then
        seance.reply(msg, "pong! " .. seance.nick)
    end
end)`,
					enabled: true,
					createdAt: Date.now(),
				});
			} else if (kind === "slap") {
				scripts.value.push({
					id,
					name: "slap_cmd",
					code: `-- Custom /slap command
seance.register_command("slap", function(args, rest)
    local target = rest ~= "" and rest or "themselves"
    local chan = seance.current_channel
    if chan ~= "" then
        seance.send("PRIVMSG " .. chan .. " :\\001ACTION slaps " .. target .. " with a large trout\\001")
    end
end)`,
					enabled: true,
					createdAt: Date.now(),
				});
			}

			persist();
		};

		const testScript = async (script: Script) => {
			statusMsg.value = "Checking...";

			try {
				const res = await scriptManager.evalSnippet(script.code);

				if (res.success) {
					script.lastError = undefined;
					statusMsg.value = "Syntax OK!";
				} else {
					script.lastError = res.error;
					statusMsg.value = "Syntax error";
				}

				persist();
			} catch (err: any) {
				script.lastError = err?.message ?? String(err);
				statusMsg.value = "Error";
				persist();
			}
		};

		return {
			scripts,
			statusMsg,
			persist,
			onToggle,
			remove,
			addNew,
			addTemplate,
			testScript,
		};
	},
});
</script>
