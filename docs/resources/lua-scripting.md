# Lua Scripting

Seance includes an embedded, sandboxed Lua scripting runtime powered by [Fengari](https://fengari.io/) (Lua 5.3 in pure JavaScript). It allows users to write custom client-side automation, slash commands, auto-responders, and event hooks directly inside the browser.

---

## Architecture & Sandboxing

### Zero Initial Overhead (Lazy Loaded)

Fengari is packaged into an asynchronous chunk (`js/fengari.js`). If a user has no active scripts and does not open the Scripts settings, Fengari is **never downloaded** (0 byte impact on normal app boot).

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

1. **Settings → Scripts**:

   - Manage Lua scripts (create, edit, delete, toggle active).
   - Starter templates for common tasks (Auto-Responder, Custom Command).
   - Syntax validation button ("Check").
   - Live error reporting if a script has an issue.

2. **`/lua <code>` Command**:

   - Executes a Lua expression or statement directly in chat.
   - Example: `/lua return 2 + 2`
   - Example: `/lua seance.print("Current channel: " .. seance.current_channel)`

3. **Backup & Restore**:
   - Stored under `thelounge.scripts` and `thelounge.script_storage.*`.
   - Automatically included in Seance Settings Backup (`.seance-settings` files).
