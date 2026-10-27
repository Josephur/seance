# Lua Scripting

Seance includes an embedded, sandboxed Lua scripting runtime powered by [Fengari](https://fengari.io/) (Lua 5.3 in pure JavaScript). It allows users to write custom client-side automation, slash commands, auto-responders, and event hooks directly inside the browser.

---

## Architecture & Sandboxing

### Off Unless Enabled (the master switch)

Scripting is gated by **Settings → General → Enable Scripting** (setting
`enableScripting`, default off). The flag lives in
`client/js/irc/scripting/enabled.ts`; `settings.ts` writes it and the script
manager subscribes to it.

While it is off:

- Fengari is packaged into an asynchronous chunk (`js/fengari.js`) and is
  **never downloaded** — the manager never creates its sandbox (not at boot,
  not for `/lua`, not for a syntax check), so there is 0 byte impact.
- No script handler fires, no script command is known, `/lua` answers that
  scripting is disabled, and the sidebar shows no scripting icon.
- Scripts and their data are kept; turning the switch back on reloads the
  enabled scripts.

Turning it off closes the Lua state at once (`scriptManager.teardown()`), so
nothing a script registered can fire again. Turning it on loads Fengari and
the enabled scripts on demand.

### Strict Security Sandbox

To ensure malicious scripts cannot access sensitive credentials (such as SASL passwords, bouncer tokens, or private conversation logs in `localStorage`), the Lua VM is strictly isolated:

- Dangerous standard Lua globals (`io`, `os`, `package`, `debug`, `dofile`, `loadfile`) are deleted and set to `nil`.
- Direct browser access (`window`, `document`, `fetch`, `localStorage`) is inaccessible from Lua.
- Scripts can only interact with Seance through the curated, safe `seance.*` bridge table.

### Infinite Loop Protection

To protect against accidental infinite loops (`while true do end`) freezing the browser tab:

- Every execution hook and script callback is monitored by a `lua_sethook` instruction counter.
- If a script exceeds 100,000 instructions in a single call, execution is immediately aborted with an error:
  `Instruction limit exceeded (possible infinite loop)`.

---

## The `seance` API

Every script has access to the global `seance` table:

### Events & Callbacks

#### `seance.on(event, callback)`

Subscribes to client events.

```lua
seance.on("message", function(msg)
    -- msg.network: Network name (e.g. "SeanceDev")
    -- msg.target:  Channel or nickname (e.g. "#channel")
    -- msg.from:    Sender nick
    -- msg.text:    Message content
    -- msg.type:    "message", "notice", or "action"
    -- msg.self:    boolean (true if sent by own client)
    -- msg.tags:    IRCv3 tags table

    if msg.text == "!ping" and not msg.self then
        seance.reply(msg, "pong!")
    end
end)
```

```lua
seance.on("send", function(data)
    -- data.line:   Raw or outgoing line
    -- data.target: Target channel or nick
end)
```

```lua
seance.on("join", function(data)
    -- data.network: Network name
    -- data.channel: Channel name
    -- data.nick:    Joined nick
    -- data.account: Optional account name (if extended-join)
    -- data.ident:   Username
    -- data.host:    Hostname
    -- data.self:    boolean (true if own client joined)
end)
```

```lua
seance.on("part", function(data)
    -- data.network: Network name
    -- data.channel: Channel name
    -- data.nick:    Parting nick
    -- data.message: Optional part message
    -- data.self:    boolean (true if own client parted)
end)
```

```lua
seance.on("quit", function(data)
    -- data.network: Network name
    -- data.nick:    Quit nick
    -- data.message: Optional quit message
end)
```

```lua
seance.on("kick", function(data)
    -- data.network: Network name
    -- data.channel: Channel name
    -- data.nick:    Kicker nick
    -- data.kicked:  Kicked nick
    -- data.reason:  Optional kick reason
    -- data.self:    boolean (true if own client was kicked)
end)
```

```lua
seance.on("nick", function(data)
    -- data.network: Network name
    -- data.oldNick: Previous nickname
    -- data.newNick: New nickname
    -- data.self:    boolean (true if own client renamed)
end)
```

```lua
seance.on("topic", function(data)
    -- data.network: Network name
    -- data.channel: Channel name
    -- data.topic:   New topic text
    -- data.nick:    Setter nickname
end)
```

```lua
seance.on("mode", function(data)
    -- data.network: Network name
    -- data.target:  Channel or nickname
    -- data.mode:    Mode string (e.g. "+o", "-b")
    -- data.params:  Array of mode parameters
    -- data.from:    Setter nickname
end)
```

### Slash Commands

#### `seance.register_command(name, callback)`

Registers a custom client slash command. Registered commands automatically participate in chat autocompletion.

```lua
seance.register_command("slap", function(args, rest)
    local target = rest ~= "" and rest or "themselves"
    local chan = seance.current_channel
    if chan ~= "" then
        seance.send("PRIVMSG " .. chan .. " :\001ACTION slaps " .. target .. " with a large trout\001")
    end
end)
```

### Messaging Helpers

- `seance.reply(msg, text)`: Replies to the sender or channel of an incoming message event.
- `seance.send(rawLine, networkUuid?)`: Sends a raw IRC line on the current or specified network.
- `seance.print(text)`: Displays a local client message in the active conversation window.

### Persistent Key-Value Storage

Scripts can persist state across browser sessions and page reloads:

- `seance.storage.get(key)`: Returns stored string, or `nil` if not found.
- `seance.storage.set(key, value)`: Saves `value` (string) for `key`, or deletes `key` if `value` is `nil`.

```lua
local seen = seance.storage.get("last_seen") or "never"
seance.print("Last run: " .. seen)
seance.storage.set("last_seen", os and os.date and os.date() or "now")
```

### Context Properties

- `seance.current_channel`: Name of active channel / query tab.
- `seance.current_network`: Name of active network.
- `seance.nick`: Nickname on active network.

---

## User Interface & Commands

1. **The script editor** (full-screen window at `/scripts`):

   - Opened from the scripting icon at the bottom of the sidebar, next to
     Settings and Help — it only appears while Enable Scripting is on. The
     old Settings → Scripts tab is gone (`/settings/scripts` redirects here).
   - **Library organization**: every script is filed under a _folder_ (free
     text, `Unsorted` when unset; scripts written before folders land there)
     with an optional one-line description. The library pane groups scripts
     by folder, offers folder chips with counts, a status filter
     (All / Active / Disabled / With errors) and a search over name, folder,
     description and code. Scripts sort by folder, then name.
   - Create, edit (full-height editor with line numbers), duplicate, delete,
     toggle active, export/import as `.lua` files, starter templates
     (Auto-Responder files under _Automation_, /slap under _Commands_),
     "Check syntax", and live error reporting. Edits save automatically.

2. **`/lua <code>` Command**:

   - Executes a Lua expression or statement directly in chat.
   - Example: `/lua return 2 + 2`
   - Example: `/lua seance.print("Current channel: " .. seance.current_channel)`

3. **Backup & Restore**:
   - Stored under `thelounge.scripts` and `thelounge.script_storage.*`.
   - Automatically included in Seance Settings Backup (`.seance-settings` files).
