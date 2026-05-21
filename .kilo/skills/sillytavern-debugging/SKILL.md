---
name: sillytavern-debugging
description: How to navigate SillyTavern's UI for testing and debugging extensions. Covers group chats, extension panels, Presence mode, console debugging, and testing best practices.
---

# SillyTavern UI Navigation & Debugging

This skill covers how to navigate SillyTavern's web UI for testing and debugging extensions (Summaryception, Presence). SillyTavern runs at `http://127.0.0.1:8000/` by default.

---

## Browser Setup for Testing

To interact with SillyTavern programmatically (click elements, read DOM, take screenshots), you need a Chrome instance with **remote debugging** enabled. Launch Chrome with the `--remote-debugging-port` flag:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile
```

This exposes the CDP (Chrome DevTools Protocol) on port 9222, which allows external tools to navigate, click, inspect, and control the browser. Any CDP-compatible tool or library can connect to this port.

**Tip:** Use a separate profile (`--user-data-dir`) to avoid interfering with your main browser session. If SillyTavern has a login password, you'll need to enter it in the debug Chrome window.

---

## SillyTavern Top Bar Layout

The top bar (`#top-settings-holder`) contains drawer icons that toggle panels. The core SillyTavern drawers (left to right) are:

| Icon | Selector | Purpose |
|---|---|---|
| Sliders | `#ai-config-button` / `#leftNavDrawerIcon` | AI Response Configuration |
| Plug | `#sys-settings-button` | API Connections |
| Font | `#advanced-formatting-button` | AI Response Formatting |
| Book-atlas | `#WI-SP-button` | World Info |
| User-cog | `#user-settings-button` | User Settings |
| Panorama | `#backgrounds-button` | Backgrounds |
| Cubes | `#extensions-settings-button` | Extensions |
| Smiley | `#persona-management-button` | Persona Management |
| Address-card | `#rightNavHolder` / `#rightNavDrawerIcon` | Character Management |

Third-party extensions may add additional drawers (e.g., DeepLore, text line editors). Each drawer is a `.drawer` element inside `#top-settings-holder`. Clicking any icon toggles its drawer open/closed. Only one unpinned drawer opens at a time.

---

## Opening a Group Chat

### Via the Right Nav Panel (Character Sidebar)

1. Click `#rightNavDrawerIcon` (address card icon) in the top bar to open the right panel.
2. The **HotSwap bar** (`#right-nav-panel .hotswap`) shows up to 25 favorited characters and groups as small avatars.
   - Characters have `data-chid` attributes.
   - Groups have `data-grid` attributes.
   - Hover to see the title: `[Group] Group: <Name>` for groups, `[Character] <Name>` for characters.
3. Click any avatar to open that chat.

### Group Naming Pattern

Groups appear in the character list as `.group_select` elements. The display name format is:

```
Group: <Name> (<dedup_index>)
```

The `(<N>)` suffix is a **deduplication index** added by SillyTavern when multiple groups share the same base name. For example:
- `Group: CollegeRPG (1)` and `Group: CollegeRPG (2)` — two distinct groups both named "CollegeRPG"
- The `(1)` does NOT mean "1 member" — it simply means it's the first group with that name

Groups in the full character list have `data-grid` containing the group ID (a timestamp string).

### Via the Full Character List

If the group isn't favorited:

1. Open the right nav panel (`#rightNavDrawerIcon`).
2. Click `#rm_button_characters` (list icon) to open the character list.
3. Groups appear as `.group_select` entries in `#rm_print_characters_block`.
4. Click the group entry to open it.

### Verifying Which Chat Is Open

```javascript
// In the browser console:
const ctx = SillyTavern.getContext();
ctx.groupId;    // Group ID string if a group chat, null otherwise
ctx.characterId; // Character index if a solo chat
ctx.chat?.length; // Number of messages in current chat
```

The selected tab header shows the current chat name:
```javascript
document.querySelector('#rm_button_selected_ch h2')?.textContent;
```

---

## Opening Extension Settings

### Extensions Panel (Left Drawer)

1. Click `#extensions-settings-button` (cubes icon) in the top bar. This opens the extensions drawer.
2. The drawer has two columns:
   - `#extensions_settings` — left column (Presence, expressions, TTS, etc.)
   - `#extensions_settings2` — right column (Summaryception, translation, regex, etc.)
3. Each extension is an `.inline-drawer` — click the header row to expand/collapse it.

### ⚠️ Critical: Two-Step Opening via CDP

Extension panels are **collapsed by default**. You must open the extensions drawer first, then expand the target extension.

**Use `element.click()` via `js()` as the primary interaction method.** SillyTavern is a static SPA — all DOM elements exist after the initial load, so `.click()` works regardless of scroll position, viewport size, or visibility. Reserve `click_at_xy()` as a fallback for canvas elements or edge cases where synthetic clicks don't register.

```python
# browser-harness snippet — open a specific extension's settings panel
import json, time

# Step 1: Open the extensions drawer
js("document.querySelector('#extensions-settings-button').click()")
time.sleep(1)

# Step 2: Expand a specific extension by matching header text
# Replace 'summaryception' with the target extension name (case-insensitive)
js("""
    (function() {
        var toggles = document.querySelectorAll('.inline-drawer-toggle');
        for (var t of toggles) {
            if (t.textContent.toLowerCase().includes('summaryception')) {
                t.click();
                return 'clicked';
            }
        }
        return 'not found';
    })();
""")
time.sleep(0.5)

# Step 3: Now interact with elements inside the extension panel via .click()
# e.g., click the Force Summarize button:
js("document.querySelector('#sc_force_summarize').click()")
```

Key points:
- **Always prefer `.click()` via `js()`** over `click_at_xy()` — it's faster, more reliable, and doesn't depend on viewport geometry
- Open `#extensions-settings-button` **first** — the parent drawer must be open before extension toggles respond to clicks
- Then click `.inline-drawer-toggle` elements matching the extension's header text
- The toggle text often includes emoji prefixes (e.g., "🧠 Summaryception") — use case-insensitive `.includes()` matching
- Use `click_at_xy()` only as a fallback when `.click()` doesn't work (e.g., canvas, complex overlay elements)

### Finding Summaryception Settings

- **Container:** `.sc-settings` (inside `#extensions_settings2`)
- **Header text:** "🧠 Summaryception"
- Click the header to expand. The panel contains:
  - Enable/Pause toggles
  - Force Summarize / Stop / Repair Orphans buttons
  - Member Selection dropdown (only visible in Presence group chats)
  - Snippet Browser
  - Injection Preview
  - Layer Stats
  - Advanced Settings drawer (connection config, turn settings, prompts, debug mode)

### Finding Presence Settings

- **Container:** `#presence-settings` (inside `#extensions_settings`)
- **Header text:** "Presence"
- Settings include: enable/disable, tracker location, debug mode, configuration check

### Common CDP Workflow: Open Group Chat → Open Extension Panel

The most common debugging workflow combines group chat navigation with extension panel interaction. Use `.click()` for everything — no coordinate clicks needed:

```python
# browser-harness snippet — full workflow
import json, time

# 1. Open a group chat by group ID (if it's in the hotswap bar)
js("""
    (function() {
        var el = document.querySelector('.hotswap [data-grid="GROUP_ID_HERE"]');
        if (el) { el.click(); return 'clicked'; }
        return 'not found';
    })();
""")
time.sleep(2)

# 2. Verify the correct chat is open
chat_info = js("""
    (function() {
        var ctx = SillyTavern.getContext();
        return JSON.stringify({groupId: ctx.groupId, chatLength: ctx.chat?.length});
    })();
""")
print(chat_info)

# 3. Open extensions drawer and expand target extension
js("document.querySelector('#extensions-settings-button').click()")
time.sleep(1)
js("""
    (function() {
        var toggles = document.querySelectorAll('.inline-drawer-toggle');
        for (var t of toggles) {
            if (t.textContent.toLowerCase().includes('summaryception')) {
                t.click(); return 'clicked';
            }
        }
        return 'not found';
    })();
""")
time.sleep(0.5)

# 4. Interact with extension buttons/controls
js("document.querySelector('#sc_force_summarize').click()")
```

For groups not in the hotswap bar, open the right nav panel and search the full character list:

```python
# Open right nav panel, then click the group by name
js("document.querySelector('#rightNavDrawerIcon').click()")
time.sleep(1)
js("""
    (function() {
        var groups = document.querySelectorAll('.group_select');
        for (var g of groups) {
            var name = g.querySelector('.ch_name');
            if (name && name.textContent.includes('GROUP_NAME_HERE')) {
                g.click(); return 'clicked: ' + name.textContent;
            }
        }
        return 'not found';
    })();
""")
```

### Wand Menu (Quick Actions)

- `#extensionsMenuButton` (magic wand icon, bottom-left of chat area) opens `#extensionsMenu`.
- Only visible when at least one extension has registered a wand button.
- Summaryception does NOT add a wand button. The wand menu is for quick-access extension actions, not settings.

---

## Presence Mode & Group Members

### Understanding Presence

When Presence is enabled and a group chat is open:
- Each message gets a **presence tracker** (`.mes_presence_tracker`) showing which members were "present"
- Messages from members who are NOT present are hidden from LLM context
- The tracker appears at the top or bottom of each message (configurable in Presence settings)

### Ignoring a Member from Presence Tracking

In the **group edit panel** (`#rm_group_chats_block`), each member row (`.group_member`) has action buttons. Presence adds an **eye-slash icon** (`.ignore_presence_toggle`) that toggles a member's exclusion from presence tracking:

- **Selector:** `.ignore_presence_toggle` on each `.group_member`
- **Active state:** `.ignore_presence_toggle.active` — the member is excluded
- **Icon:** `fa-solid fa-eye-slash`
- **Data storage:** `chat_metadata.ignore_presence` — array of avatar filenames

```javascript
// Check which members are ignored in console:
SillyTavern.getContext().chatMetadata.ignore_presence;
// e.g. ["Students (NPCs).png"]
```

### Member Selection in Summaryception

When **Presence Group Chat Memory** is enabled in Summaryception settings:

1. The `#sc_member_select_wrap` div becomes visible.
2. Use `#sc_preview_member_select` dropdown to select a group member.
3. The Snippet Browser (`#sc_snippet_browser`) updates to show that member's per-character memory data.
4. The Injection Preview (`#sc_preview`) shows the assembled injection for that member.

---

## Console Debugging

The browser console (F12) is the most powerful debugging tool. Access SillyTavern internals via:

```javascript
const ctx = SillyTavern.getContext();
```

### Key Context Properties

| Property | Type | Description |
|---|---|---|
| `ctx.chat` | Array | All chat messages |
| `ctx.chat.length` | Number | Total message count |
| `ctx.chatMetadata` | Object | Chat-level metadata (presence, summaryception data) |
| `ctx.groupId` | String\|null | Current group ID |
| `ctx.characterId` | Number\|null | Current character index |
| `ctx.groups` | Array | All group objects |
| `ctx.characters` | Array | All character objects |
| `ctx.extensionSettings` | Object | All extension settings |
| `ctx.extensionSettings.summaryception` | Object | Summaryception settings |
| `ctx.eventSource` | Object | Event system for hooks |
| `ctx.maxContext` | Number | Max context tokens |

### Useful Console Commands

```javascript
// Current chat info
const ctx = SillyTavern.getContext();
console.log('Group:', ctx.groupId);
console.log('Messages:', ctx.chat.length);
console.log('Current group:', ctx.groups.find(g => g.id === ctx.groupId));

// Summaryception settings
console.log('SC Settings:', ctx.extensionSettings.summaryception);

// Chat metadata (presence ignores, SC data)
console.log('Metadata:', ctx.chatMetadata);
console.log('Presence ignores:', ctx.chatMetadata.ignore_presence);
console.log('SC metadata:', ctx.chatMetadata.summaryception);

// Inspect a specific message
const msg = ctx.chat[50];
console.log('Msg 50:', { name: msg.name, isUser: msg.is_user, isSystem: msg.is_system, present: msg.present });

// Check which messages are hidden (is_system = true in Presence)
const hidden = ctx.chat.filter(m => m.is_system);
console.log('Hidden messages:', hidden.length, 'of', ctx.chat.length);

// Reload current chat
ctx.reloadCurrentChat();

// Save chat manually
ctx.saveChat();
```

### Enabling Debug Logging

Summaryception has two debug modes in Advanced Settings:
- **Debug Mode** (`#sc_debug_mode`) — verbose console logs with `[Summaryception]` prefix
- **Trace Mode** (`#sc_trace_mode`) — detailed flow logging (requires Debug Mode)

Presence has a debug checkbox (`#presence-debug`) that enables `[Presence]` prefixed logs.

---

## Testing Best Practices

### Use Small Chats for Debugging

Large chats (100+ messages) make debugging slow and hard to follow. For testing:

1. **Create a test group** with 2-3 members.
2. **Create a fresh chat** — click the group, then start a new chat to get a clean state.
3. **Keep it small** — test with ~20 messages total.
4. **Use small batch sizes** — set Summaryception's "Turns per Summary Batch" to 3 (default is higher).
5. **Low verbatim turns** — set "Verbatim Assistant Turns to Keep" to a low value (e.g., 4-6) so summarization triggers sooner.

This makes each summarization cycle fast and easy to inspect.

### Inspecting Summarization Results

1. Enable Debug Mode in Summaryception Advanced Settings.
2. Send a few messages to trigger a summarization cycle.
3. Open browser console (F12) to see `[Summaryception]` logs.
4. Check the **Snippet Browser** (`#sc_snippet_browser`) for created snippets and their turn ranges.
5. Check the **Injection Preview** (`#sc_preview`) for the assembled injection text.
6. Use the **Refresh** button (`#sc_refresh_preview`) after changes.

### Force Summarization

Instead of waiting for automatic triggers, use:
- **Force Summarize Now** button (`#sc_force_summarize`) in Summaryception settings
- Or via console: trigger the extension's cycle manually

### Message Visibility

When Summaryception hides summarized messages, they get `is_system: true` in the chat array but remain visible in the UI (unless "Disable Message Hiding" is unchecked). Use:

```javascript
// Count hidden vs visible messages
const ctx = SillyTavern.getContext();
const hidden = ctx.chat.filter(m => m.is_system).length;
const visible = ctx.chat.filter(m => !m.is_system).length;
console.log(`Hidden: ${hidden}, Visible: ${visible}`);
```

---

## Key Element IDs and Selectors

### Top Bar & Drawers

| Element | Selector | Purpose |
|---|---|---|
| AI Config drawer | `#ai-config-button` | AI Response Configuration |
| API Connections drawer | `#sys-settings-button` | API connection settings |
| Formatting drawer | `#advanced-formatting-button` | AI Response Formatting |
| World Info drawer | `#WI-SP-button` | World Info / Lorebooks |
| User Settings drawer | `#user-settings-button` | User settings |
| Backgrounds drawer | `#backgrounds-button` | Background images |
| Extensions drawer | `#extensions-settings-button` | Extensions settings |
| Persona drawer | `#persona-management-button` | Persona Management |
| Character drawer | `#rightNavHolder` | Character Management |
| Extensions panel | `#rm_extensions_block` | The extensions drawer content |
| Extensions left column | `#extensions_settings` | Built-in + some third-party extensions |
| Extensions right column | `#extensions_settings2` | More third-party extensions |

### Character & Group Navigation

| Element | Selector | Purpose |
|---|---|---|
| HotSwap bar | `#right-nav-panel .hotswap` | Favorited characters/groups (max 25) |
| HotSwap group entry | `.hotswap [data-grid]` | A favorited group |
| HotSwap character entry | `.hotswap [data-chid]` | A favorited character |
| Character list | `#rm_print_characters_block` | Full character/group list |
| Group entry in list | `.group_select` | A group in the character list |
| Group name in entry | `.group_select .ch_name` | The group display name |
| Group ID attribute | `.group_select[data-grid]` | `data-grid` holds the group ID |
| Selected chat tab | `#rm_button_selected_ch h2` | Shows current chat name |

### Group Edit Panel

| Element | Selector | Purpose |
|---|---|---|
| Group edit panel | `#rm_group_chats_block` | Group management panel |
| Group name input | `#rm_group_chat_name` | Edit group name |
| Group members list | `#rm_group_members` | Current members container |
| Group member entry | `.group_member` | Individual member |
| Member name | `.group_member .ch_name` | Member display name |
| Member disabled | `.group_member.disabled` | Muted member |
| Back from group | `#rm_button_back_from_group` | Return to character list |

### Presence

| Element | Selector | Purpose |
|---|---|---|
| Presence settings | `#presence-settings` | Presence extension panel |
| Enable Presence | `#presence-enabled` | Toggle Presence on/off |
| Tracker on message | `.mes_presence_tracker` | Presence tracker per message |
| Present member icon | `.presence_icon.present` | Member marked as present |
| Ignore toggle (group panel) | `.ignore_presence_toggle` | Eye-slash icon per member |
| Ignore active state | `.ignore_presence_toggle.active` | Member excluded from tracking |
| Universal tracker toggle | `#presence-universal-tracer-on` | Universal tracker for new msgs |

### Summaryception

| Element | Selector | Purpose |
|---|---|---|
| Settings container | `.sc-settings` | Summaryception's settings panel |
| Enable toggle | `#sc_enabled` | Enable/disable Summaryception |
| Pause toggle | `#sc_pause_summarization` | Pause processing |
| Force Summarize | `#sc_force_summarize` | Trigger manual summarization |
| Stop | `#sc_stop_summarize` | Stop current summarization |
| Member select wrapper | `#sc_member_select_wrap` | Presence member section |
| Member select dropdown | `#sc_preview_member_select` | Choose which member to inspect |
| Snippet browser | `#sc_snippet_browser` | Snippets with turn ranges |
| Injection preview | `#sc_preview` | Full injection text |
| Refresh preview | `#sc_refresh_preview` | Refresh preview |
| Debug mode | `#sc_debug_mode` | Verbose console logging |
| Trace mode | `#sc_trace_mode` | Detailed flow logging |
| Presence group memory | `#sc_presence_group_memory` | Per-member memory banks |
| Advanced settings | `.sc-settings .inline-drawer .inline-drawer` | Nested drawer for advanced opts |

---

## Notes

- SillyTavern stores extension settings in `SillyTavern.getContext().extensionSettings`.
- Chat metadata (Presence ignores, Summaryception data) lives in `SillyTavern.getContext().chatMetadata`.
- The extension settings panel is **context-sensitive** — member selection only appears when a group chat with Presence is active.
- In Presence mode with Summaryception's "Presence Group Chat Memory" enabled, each group member gets their own independent memory store. The snippet browser shows per-member data.
