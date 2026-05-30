> ⚠️ **This is a vibe-coded plugin.** It was built quickly and iteratively with an AI coding assistant, for personal use. It works, but it has not been rigorously tested or audited — use at your own risk.

# Workspace Explorer

An alternate, PKMS-friendly file explorer sidebar for **VS Code / Cursor**, with folder coloring, per-folder sorting, pinning, and a MindChuk-style **collection preview** board for your notes.

Built for note-taking / personal-knowledge-management workflows (Markdown vaults), but works in any workspace.

<img width="1582" height="1034" alt="image" src="https://github.com/user-attachments/assets/e871a756-a2a5-44eb-939a-f1547177f1d8" />

## Features

### Explorer sidebar
- **Folder coloring** — assign a swatch color (red, orange, yellow, green, blue, purple, gray) to a folder's icon, and an inherited text color that cascades to its contents.
- **Per-folder sorting** — each folder remembers its own sort (name ↑/↓ or last-edited ↑/↓).
- **Pinning** — pin files to the top of their folder or to the top of the whole tree.
- **Hidden files** — hide noise and toggle visibility on demand.
- **Open/closed folder icons**, persisted expansion state, and drag-and-drop moving.
- **Tags**, **orphans**, and **recent files** views for navigating a Markdown vault.
- **Tag sorting** — sort the Tags view by name (A→Z / Z→A) or by count (high→low / low→high).

### Collection Preview (MindChuk-style board)
Click a **folder** or a **tag** to open a scrollable card board of its notes in the editor area. Toggle it in settings via `workspaceExplorer.collectionPreview.enabled`.

- **True masonry layout** — cards pack top-to-bottom in responsive columns with no row gaps.
- **Matches your sort** — cards follow the source folder's sort mode (or the current tag sort).
- **Live search** — filter the board as you type by note title **and** content. Available for both folders and tags.
- **Quick add note** (folders only) — an "Add note" button opens an inline title + text form to create a new `.md` in that folder. No title falls back to a date/time name.
- **Expand / Compress toggle** — view cards at their natural height, or truncate them all to a uniform size. Compressed cards stay individually scrollable.
- **Rendered Markdown previews** — notes render as (smaller-scale) preview Markdown, with **interactive task checkboxes** that write back to the source file.
- **Images** — shown as a centered slice at a fixed height when expanded, shrunk to fit when compressed.
- **PDFs and other files** — shown as a compact file thumbnail.
- **Cards are colored** by their nearest colored ancestor folder.
- **Card titles** show the filename (with extension), middle-truncated when long.
- **Pinned notes** float to the top of the board with a pin badge, mirroring the explorer's pinning.
- **Auto-refresh** — the board updates on filesystem changes (create/rename/move/delete), sort changes, and pin changes.
- **Right-click a card** for the same actions as right-clicking the file in the explorer — open to side, pin/unpin, hide/unhide, rename, move, duplicate, delete, reveal in OS, open in terminal, and copy (relative) path.

## Install

This is distributed as a packaged `.vsix` rather than via the Marketplace.

```bash
# Build from source
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository

# Install the resulting .vsix
code   --install-extension workspace-explorer-1.1.0.vsix --force   # VS Code
cursor --install-extension workspace-explorer-1.1.0.vsix --force   # Cursor
```

Then reload the window. Open the **Workspace Explorer** view in the sidebar.

## Development

- Source is a single file: [`src/extension.ts`](src/extension.ts).
- `npm run compile` — type-check and build to `out/`.
- `npm run watch` — incremental rebuilds.
- `npx @vscode/vsce package --allow-missing-repository` — produce a `.vsix`.

## License

[MIT](LICENSE) © 2026 jpmoore
