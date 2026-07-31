# Keyboard shortcuts

Piloti can be driven from the keyboard: open the command palette, jump between
sections, and work the composer without reaching for the mouse. Press **?**
anywhere in the app to see the full set — the cheatsheet is generated from the
same registry the app binds, so it is never out of date with what actually works.

## Two gates

Shortcuts are only active when both of these allow it:

1. **The organization flag.** The `keyboard-shortcuts` WorkOS feature flag turns
   the whole feature on for an organization. Without it the client code is never
   mounted and no key listener exists.
2. **Your own preference.** Profile → *Keyboard shortcuts* is a per-device toggle,
   default on. Turned off, the app registers zero key listeners and renders
   neither the palette nor the cheatsheet — the feature is fully inert, not just
   hidden.

Plain-key shortcuts never fire while you are typing (in a text field, a text
area, a select, or any editable region) and never while a modifier is held, so
they cannot swallow what you meant to type. ⌘K is the one exception — the palette
convention — and works everywhere.

## General

| Shortcut | What it does |
|---|---|
| **⌘K** / **Ctrl+K** | Open (or close) the command palette |
| **?** | Show the shortcuts cheatsheet |
| **Esc** | Close a dialog, panel or menu |

The modifier is shown as **⌘** on Apple platforms and **Ctrl** everywhere else;
the cheatsheet resolves it for the machine you are on.

## Jumping around (`g` then a key)

Press **G**, release it, then press the destination key within a second and a
half. The available destinations are exactly the sections you can reach in the
navigation rail, so what you see in the rail is what you can jump to:

| Sequence | Destination |
|---|---|
| **G** then **P** | All projects |
| **G** then **O** | Organization |
| **G** then **C** | Ask Piloti (chat) |
| **G** then **W** | Workflows |
| **G** then **F** | Files |
| **G** then **K** | Knowledge |
| **G** then **H** | History |
| **G** then **A** | Archiv |
| **G** then **I** | Inbox |
| **G** then **S** | Project settings |

Rows for sections your organization has not enabled do not appear in the
cheatsheet and their keys do nothing — the sheet always shows your set, not a
generic one.

Section jumps open that section of the project you are currently in. Outside a
project there is nothing for them to open, so they do nothing rather than
guessing a project for you. *All projects*, *Organization*, *Archiv* and *Inbox*
are org-wide doorways and work from anywhere.

A second key that is not bound simply cancels the sequence. Nothing navigates
unless you asked for it.

## In the chat

| Shortcut | What it does |
|---|---|
| **Enter** or **⌘Enter** | Send the message |
| **Shift+Enter** | New line |
| **@** | Mention a colleague (where collaboration is enabled) |
| **1**–**9** | Pick a numbered option when Piloti asks you to choose |

While the mention picker is open it owns the navigation keys: ↑/↓ move the
selection, Tab or Enter inserts the name, and Escape dismisses the picker without
closing the chat around it. Enter never sends a message while the picker is open.

## The command palette

⌘K opens a searchable list of everything the UI can already do: jump to one of
your projects, jump to a section of the project you are in, start a new project,
open the organization or profile page, toggle the theme, or sign out. It adds no
capabilities of its own — it is a faster route to the ones you have.

## For maintainers

The bindings and the cheatsheet share one source of truth,
`frontends/ui/src/components/shell/shortcuts.ts`. Its navigation half is derived
from `project-sections.ts` — the same module the rail and the palette render — via
each section's `shortcutKey`. Adding a section with a `shortcutKey` therefore
gives it a working jump and a cheatsheet row (with the rail's own label and icon)
in one step, and a flag-gated section disappears from the sheet exactly when it
disappears from the rail. Shortcuts implemented elsewhere (the composer's, the
choice prompt's, Radix's Escape) are declared in the registry with an `owner`, so
the sheet can document them honestly without the shell pretending to bind them.
