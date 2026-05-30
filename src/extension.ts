import * as vscode from 'vscode';
import * as path from 'path';
import MarkdownIt = require('markdown-it');

type SortMode = 'nameAsc' | 'nameDesc' | 'editedAsc' | 'editedDesc';
type TagSortMode = 'nameAsc' | 'nameDesc' | 'countDesc' | 'countAsc';
type Swatch = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';
const SWATCHES: Swatch[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

const THEME_COLOR_BY_SWATCH: Record<Swatch, string> = {
    red: 'charts.red',
    orange: 'charts.orange',
    yellow: 'charts.yellow',
    green: 'charts.green',
    blue: 'charts.blue',
    purple: 'charts.purple',
    gray: 'descriptionForeground',
};

// Concrete CSS colors for webview rendering (ThemeColor objects can't be used in HTML/CSS).
const CSS_COLOR_BY_SWATCH: Record<Swatch, string> = {
    red: '#e05561',
    orange: '#d18f52',
    yellow: '#e0c050',
    green: '#5bbf6a',
    blue: '#4e9bd6',
    purple: '#a06fd0',
    gray: '#8a8a8a',
};

const DEFAULT_SORT: SortMode = 'nameAsc';
const SORTS_KEY = 'workspaceExplorer.sorts';
const TAG_SORT_KEY = 'workspaceExplorer.tagSort';
const DEFAULT_TAG_SORT: TagSortMode = 'nameAsc';

// Compare two basenames per the name direction of a SortMode. Shared so the
// collection preview orders cards exactly like the explorer's directory listing.
function compareByName(aName: string, bName: string, mode: SortMode): number {
    return mode === 'nameDesc' ? bName.localeCompare(aName) : aName.localeCompare(bName);
}

// Sort a flat list of file paths by SortMode, statting files for the edited
// modes (via vscode.workspace.fs, matching readDir's mtime source). Mirrors the
// explorer's per-file comparison so preview cards match the folder ordering.
async function sortFilePaths(files: string[], mode: SortMode): Promise<string[]> {
    if (mode === 'nameAsc' || mode === 'nameDesc') {
        return [...files].sort((a, b) => compareByName(path.basename(a), path.basename(b), mode));
    }
    const withMtime = await Promise.all(files.map(async (f) => {
        let mtime = 0;
        try { mtime = (await vscode.workspace.fs.stat(vscode.Uri.file(f))).mtime; } catch { mtime = 0; }
        return { f, mtime };
    }));
    withMtime.sort((a, b) => mode === 'editedAsc' ? a.mtime - b.mtime : b.mtime - a.mtime);
    return withMtime.map((x) => x.f);
}
const PINNED_FOLDER_KEY = 'workspaceExplorer.pinnedInFolder';
const PINNED_TOP_KEY = 'workspaceExplorer.pinnedTop';
const HIDDEN_KEY = 'workspaceExplorer.hidden';
const SHOW_HIDDEN_KEY = 'workspaceExplorer.showHidden';
const EXPAND_ALL_KEY = 'workspaceExplorer.expandAll';
const ICON_COLOR_KEY = 'workspaceExplorer.iconColor';   // folderPath -> Swatch
const TEXT_COLOR_KEY = 'workspaceExplorer.textColor';   // folderPath -> Swatch (inherited)
const FOLDER_ORDER_KEY = 'workspaceExplorer.folderOrder'; // parentPath -> ordered child folder names
const EXPANDED_FOLDERS_KEY = 'workspaceExplorer.expandedFolders'; // string[] of expanded folder paths
const COLLECTION_LAYOUT_KEY = 'workspaceExplorer.collectionPreview.layout'; // 'expanded' | 'compressed'
const DND_MIME = 'application/vnd.code.tree.workspaceexplorer';

function isHiddenAncestry(filePath: string, hiddenSet: Set<string>, rootPath: string | undefined): boolean {
    let cur = filePath;
    while (true) {
        const base = path.basename(cur);
        if (base.startsWith('.')) return true;
        if (hiddenSet.has(cur)) return true;
        if (!rootPath || cur === rootPath) return false;
        const parent = path.dirname(cur);
        if (parent === cur) return false;
        cur = parent;
    }
}

function combineExcludeGlob(patterns: string[]): string | undefined {
    if (!patterns || patterns.length === 0) return undefined;
    if (patterns.length === 1) return patterns[0];
    return `{${patterns.join(',')}}`;
}

function combineIncludeGlob(patterns: string[], fallback: string): string {
    if (!patterns || patterns.length === 0) return fallback;
    if (patterns.length === 1) return patterns[0];
    return `{${patterns.join(',')}}`;
}

// VS Code's TreeView throws "Element with id <x> is already registered" if two
// materialized siblings share a TreeItem.id (we set id = uri.fsPath). Guarantee
// uniqueness by dropping any later node whose fsPath was already emitted, while
// preserving the intended ordering (first occurrence wins, e.g. a pinned node
// kept ahead of its would-be duplicate in the normal listing).
function dedupeByPath(nodes: FileNode[]): FileNode[] {
    const seen = new Set<string>();
    const out: FileNode[] = [];
    for (const n of nodes) {
        if (seen.has(n.uri.fsPath)) continue;
        seen.add(n.uri.fsPath);
        out.push(n);
    }
    return out;
}

class FileNode extends vscode.TreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly isDirectory: boolean,
        public readonly parentDir: string | undefined,
        pinned: 'folder' | 'top' | null,
        hidden: boolean,
        expandByDefault: boolean,
        iconColor: Swatch | undefined,
        mediaRoot: vscode.Uri,
        isExpanded: boolean = false,
    ) {
        super(
            uri,
            isDirectory
                ? ((expandByDefault || isExpanded)
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed)
                : vscode.TreeItemCollapsibleState.None,
        );
        this.resourceUri = uri;
        this.label = path.basename(uri.fsPath);
        // Stable id so VSCode can persist expand/collapse state across sessions.
        this.id = uri.fsPath;
        if (isDirectory) {
            this.contextValue = hidden ? 'hiddenFolder' : 'folder';
            // Always use our own folder icons (closed/open variants), so all folders
            // get the open-state visual feedback even when no color is set.
            const base = iconColor ?? 'default';
            const variant = isExpanded ? `${base}-open.svg` : `${base}.svg`;
            this.iconPath = vscode.Uri.joinPath(mediaRoot, 'folders', variant);
            // Wire a single-click command to open the Collection Preview. Folders remain
            // expandable; in VS Code a command on an expandable TreeItem fires on click while
            // the twistie still toggles expand/collapse, so this preserves existing behavior.
            // The handler itself is a no-op when the collectionPreview.enabled setting is off.
            this.command = {
                command: 'workspaceExplorer.openFolder',
                title: 'Open Collection Preview',
                arguments: [uri],
            };
        } else {
            this.contextValue = hidden ? 'hiddenFile' : (pinned ? 'pinnedFile' : 'file');
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [uri],
            };
        }
        const bits: string[] = [];
        if (pinned) bits.push(pinned === 'top' ? '📌 top' : '📌');
        if (hidden) bits.push('hidden');
        if (bits.length) this.description = bits.join(' · ');
    }
}

// Webview preview-card context menus pass a `data-vscode-context` object
// ({ filePath, webviewSection, ... }) as the command argument instead of a FileNode.
// This coerces either form into a FileNode so the explorer handlers work for both.
// Preview cards are always files (isDirectory=false).
function coerceToFileNode(arg: unknown): FileNode | undefined {
    if (arg instanceof FileNode) return arg;
    if (arg && typeof arg === 'object' && typeof (arg as any).filePath === 'string') {
        const fp = (arg as any).filePath as string;
        const uri = vscode.Uri.file(fp);
        return new FileNode(uri, false, path.dirname(fp), null, false, false, undefined, uri);
    }
    return undefined;
}

// Move a file/folder into destDir, refusing to overwrite. Uses a WorkspaceEdit so
// open editors follow the move. Returns true on success.
async function moveEntry(src: vscode.Uri, destDir: vscode.Uri): Promise<boolean> {
    const dest = vscode.Uri.joinPath(destDir, path.basename(src.fsPath));
    if (await pathExists(dest)) {
        vscode.window.showErrorMessage(`'${path.basename(src.fsPath)}' already exists in the destination.`);
        return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(src, dest, { overwrite: false });
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) vscode.window.showErrorMessage(`Move failed: ${path.basename(src.fsPath)}`);
    return ok;
}

class WorkspaceExplorerProvider implements vscode.TreeDataProvider<FileNode>, vscode.FileDecorationProvider, vscode.TreeDragAndDropController<FileNode> {
    // Accept our internal drags (files + folders) plus `text/uri-list`, which is
    // what VS Code's built-in explorer and the OS use when dragging files in.
    readonly dragMimeTypes = [DND_MIME, 'text/uri-list'];
    readonly dropMimeTypes = [DND_MIME, 'text/uri-list'];

    handleDrag(source: readonly FileNode[], data: vscode.DataTransfer): void {
        // Carry the dir flag so the drop side knows folders without statting.
        const items = source.map((n) => ({ p: n.uri.fsPath, d: n.isDirectory }));
        if (items.length === 0) return;
        data.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(items)));
        // Expose a uri-list too so items can be dragged into other views/apps.
        data.set('text/uri-list', new vscode.DataTransferItem(source.map((n) => n.uri.toString()).join('\r\n')));
    }

    async handleDrop(target: FileNode | undefined, data: vscode.DataTransfer): Promise<void> {
        const destDir = this.resolveDropDir(target);
        if (!destDir) return;

        // Internal drag: move items within the workspace. If everything is already
        // in the destination AND we're dropping onto a sibling folder, treat it as
        // a reorder instead (preserves the custom folder-ordering feature).
        const internal = data.get(DND_MIME);
        if (internal) {
            let payload: { p: string; d: boolean }[];
            try { payload = JSON.parse(await internal.asString()); } catch { return; }
            if (!Array.isArray(payload) || payload.length === 0) return;

            const allInDest = payload.every((it) => path.dirname(it.p) === destDir.fsPath);
            if (allInDest) {
                if (target && target.isDirectory && payload.every((it) => it.d)) {
                    await this.reorderFolders(destDir.fsPath, payload.map((it) => path.basename(it.p)), path.basename(target.uri.fsPath));
                }
                return;
            }

            let moved = false;
            for (const it of payload) {
                if (this.isInvalidMove(it.p, destDir)) continue;
                if (await moveEntry(vscode.Uri.file(it.p), destDir)) moved = true;
            }
            if (moved) this.refresh();
            return;
        }

        // External drag (from VS Code's file explorer or the OS): move items that
        // already live in the workspace, copy in ones from outside.
        const uriList = await data.get('text/uri-list')?.asString();
        if (!uriList) return;
        const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        const isInsideWorkspace = (p: string) => roots.some((r) => p === r || p.startsWith(r + path.sep));

        let changed = false;
        for (const line of uriList.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            let src: vscode.Uri;
            try { src = vscode.Uri.parse(trimmed, true); } catch { continue; }
            if (src.scheme !== 'file' || this.isInvalidMove(src.fsPath, destDir)) continue;

            if (isInsideWorkspace(src.fsPath)) {
                if (await moveEntry(src, destDir)) changed = true;
            } else {
                const dest = vscode.Uri.joinPath(destDir, path.basename(src.fsPath));
                if (await pathExists(dest)) {
                    vscode.window.showErrorMessage(`'${path.basename(src.fsPath)}' already exists in the destination.`);
                    continue;
                }
                try { await vscode.workspace.fs.copy(src, dest, { overwrite: false }); changed = true; }
                catch (e: any) { vscode.window.showErrorMessage(`Copy failed: ${e?.message ?? e}`); }
            }
        }
        if (changed) this.refresh();
    }

    // Drop onto a folder targets that folder; onto a file targets its parent;
    // onto empty space targets the workspace root.
    private resolveDropDir(target: FileNode | undefined): vscode.Uri | undefined {
        if (!target) return vscode.workspace.workspaceFolders?.[0]?.uri;
        if (target.isDirectory) return target.uri;
        return vscode.Uri.file(path.dirname(target.uri.fsPath));
    }

    // Reject no-op moves (already in destDir) and moving a folder into itself/a descendant.
    private isInvalidMove(srcPath: string, destDir: vscode.Uri): boolean {
        if (path.dirname(srcPath) === destDir.fsPath) return true;
        const d = destDir.fsPath;
        return d === srcPath || d.startsWith(srcPath + path.sep);
    }

    private async reorderFolders(parent: string, movingNames: string[], beforeName: string | undefined): Promise<void> {
        // Build current ordering of all child folder names on disk.
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parent)); } catch { return; }
        const dirNames = entries.filter(([_, t]) => t === vscode.FileType.Directory).map(([n]) => n);

        const all = this.context.workspaceState.get<Record<string, string[]>>(FOLDER_ORDER_KEY, {});
        const saved = all[parent] ?? [];
        // Start from saved order, then append any on-disk dirs not yet recorded, in default sort order.
        const recorded = new Set(saved);
        const seenOnDisk = new Set(dirNames);
        let current = saved.filter((n) => seenOnDisk.has(n));
        const newcomers = dirNames.filter((n) => !recorded.has(n));
        newcomers.sort((a, b) => a.localeCompare(b));
        current = [...current, ...newcomers];

        // Remove moving names from current.
        const movingSet = new Set(movingNames);
        current = current.filter((n) => !movingSet.has(n));

        // Insert moving names at the right spot.
        if (beforeName) {
            const idx = current.indexOf(beforeName);
            if (idx >= 0) current.splice(idx, 0, ...movingNames);
            else current.push(...movingNames);
        } else {
            current.push(...movingNames);
        }

        all[parent] = current;
        await this.context.workspaceState.update(FOLDER_ORDER_KEY, all);
        this.refresh();
    }

    getFolderOrder(parent: string): string[] | undefined {
        const all = this.context.workspaceState.get<Record<string, string[]>>(FOLDER_ORDER_KEY, {});
        return all[parent];
    }


    private _onDidChangeTreeData = new vscode.EventEmitter<FileNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    private get mediaRoot(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.extensionUri, 'media');
    }

    // Full refresh including decorations — use after color changes or explicit refresh.
    refresh(): void {
        this._onDidChangeTreeData.fire();
        this._onDidChangeFileDecorations.fire(undefined);
    }

    // Tree-only refresh — use for filesystem changes so text-color decorations don't flash.
    refreshTree(): void {
        this._onDidChangeTreeData.fire();
    }

    refreshDecorations(): void {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    refreshNode(node: FileNode): void {
        this._onDidChangeTreeData.fire(node);
    }

    getTreeItem(element: FileNode): vscode.TreeItem {
        return element;
    }

    getParent(element: FileNode): FileNode | undefined {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root || !element.parentDir || element.parentDir === root) return undefined;
        const parentUri = vscode.Uri.file(element.parentDir);
        return new FileNode(
            parentUri,
            true,
            path.dirname(element.parentDir),
            null,
            false,
            false,
            undefined,
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        );
    }

    // -------- FileDecorationProvider: text color inherited from nearest ancestor folder --------
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const swatch = this.resolveTextColor(uri.fsPath);
        if (!swatch) return undefined;
        return {
            color: new vscode.ThemeColor(THEME_COLOR_BY_SWATCH[swatch]),
        };
    }

    private resolveTextColor(filePath: string): Swatch | undefined {
        const map = this.context.workspaceState.get<Record<string, Swatch>>(TEXT_COLOR_KEY, {});
        let cur = filePath;
        // Walk up to workspace root.
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // Check the path itself first (folder may be the colored one), then ancestors.
        while (true) {
            if (map[cur]) return map[cur];
            if (root && cur === root) return undefined;
            const parent = path.dirname(cur);
            if (parent === cur) return undefined;
            cur = parent;
        }
    }

    async getChildren(element?: FileNode): Promise<FileNode[]> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return [];

        if (!element) {
            const root = folders[0].uri;
            const children = await this.readDir(root);
            const topPins = this.getPinnedTop();
            const showHidden = this.getShowHidden();
            const hidden = new Set(this.getHidden());
            const iconColors = this.context.workspaceState.get<Record<string, Swatch>>(ICON_COLOR_KEY, {});

            const pinnedFileNodes: FileNode[] = [];
            for (const pinPath of topPins) {
                if (!showHidden && (hidden.has(pinPath) || path.basename(pinPath).startsWith('.'))) continue;
                try {
                    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(pinPath));
                    if (stat.type === vscode.FileType.File) {
                        pinnedFileNodes.push(
                            new FileNode(
                                vscode.Uri.file(pinPath),
                                false,
                                path.dirname(pinPath),
                                'top',
                                hidden.has(pinPath) || path.basename(pinPath).startsWith('.'),
                                this.getExpandAll(),
                                undefined,
                                this.mediaRoot,
                            ),
                        );
                    }
                } catch { /* missing */ }
            }
            const filtered = children.filter(
                (c) => !(!c.isDirectory && topPins.includes(c.uri.fsPath)),
            );
            return dedupeByPath([...pinnedFileNodes, ...filtered]);
        }

        if (element.isDirectory) return dedupeByPath(await this.readDir(element.uri));
        return [];
    }

    private async readDir(dir: vscode.Uri): Promise<FileNode[]> {
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { return []; }

        const sortMode = this.getSortMode(dir.fsPath);
        const topPins = new Set(this.getPinnedTop());
        const folderPins = new Set(this.getPinnedInFolder(dir.fsPath));
        const hidden = new Set(this.getHidden());
        const showHidden = this.getShowHidden();
        const expandAll = this.getExpandAll();
        const iconColors = this.context.workspaceState.get<Record<string, Swatch>>(ICON_COLOR_KEY, {});

        const items = await Promise.all(
            entries.map(async ([name, type]) => {
                const childUri = vscode.Uri.joinPath(dir, name);
                let mtime = 0;
                if (sortMode === 'editedAsc' || sortMode === 'editedDesc') {
                    try { mtime = (await vscode.workspace.fs.stat(childUri)).mtime; } catch { mtime = 0; }
                }
                return { name, type, uri: childUri, mtime };
            }),
        );

        const visibleItems = showHidden
            ? items
            : items.filter((i) => !i.name.startsWith('.') && !hidden.has(i.uri.fsPath));

        const dirs = visibleItems.filter((i) => i.type === vscode.FileType.Directory);
        const files = visibleItems.filter((i) => i.type !== vscode.FileType.Directory);

        const cmp = (a: typeof items[number], b: typeof items[number]) => {
            switch (sortMode) {
                case 'nameDesc':   return b.name.localeCompare(a.name);
                case 'editedAsc':  return a.mtime - b.mtime;
                case 'editedDesc': return b.mtime - a.mtime;
                default:           return a.name.localeCompare(b.name);
            }
        };
        files.sort(cmp);

        // Folders: custom order (if any) overrides sort, with newcomers appended in default sort.
        const customOrder = this.getFolderOrder(dir.fsPath);
        if (customOrder) {
            const idx = new Map(customOrder.map((n, i) => [n, i]));
            dirs.sort((a, b) => {
                const ai = idx.has(a.name) ? idx.get(a.name)! : Number.MAX_SAFE_INTEGER;
                const bi = idx.has(b.name) ? idx.get(b.name)! : Number.MAX_SAFE_INTEGER;
                if (ai !== bi) return ai - bi;
                return cmp(a, b);
            });
        } else {
            dirs.sort(cmp);
        }

        const folderPinned: typeof files = [];
        const regular: typeof files = [];
        for (const f of files) {
            if (topPins.has(f.uri.fsPath)) continue;
            if (folderPins.has(f.uri.fsPath)) folderPinned.push(f);
            else regular.push(f);
        }

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const expandedSet = this.getExpandedFolders();
        const toNode = (i: typeof items[number]): FileNode => {
            const isDir = i.type === vscode.FileType.Directory;
            const isHidden = isHiddenAncestry(i.uri.fsPath, hidden, rootPath);
            const pinned: 'folder' | 'top' | null = isDir
                ? null
                : topPins.has(i.uri.fsPath)
                    ? 'top'
                    : folderPins.has(i.uri.fsPath)
                        ? 'folder'
                        : null;
            const iconColor = isDir ? iconColors[i.uri.fsPath] : undefined;
            const wasExpanded = isDir && expandedSet.has(i.uri.fsPath);
            return new FileNode(i.uri, isDir, dir.fsPath, pinned, isHidden, expandAll, iconColor, this.mediaRoot, wasExpanded);
        };

        return dedupeByPath([...folderPinned.map(toNode), ...dirs.map(toNode), ...regular.map(toNode)]);
    }

    // ---- persistence: sort ----
    getSortMode(folderPath: string): SortMode {
        return (this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {}))[folderPath] ?? DEFAULT_SORT;
    }
    // True only if some folder sorts by mtime, so a content edit can change ordering.
    // Used to skip tree refreshes (and the decoration repaint flash) while typing
    // when nothing is actually mtime-sorted.
    hasEditedSort(): boolean {
        if (DEFAULT_SORT === 'editedAsc' || DEFAULT_SORT === 'editedDesc') return true;
        const sorts = this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {});
        return Object.values(sorts).some(m => m === 'editedAsc' || m === 'editedDesc');
    }
    async setSortMode(folderPath: string, mode: SortMode): Promise<void> {
        const sorts = this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {});
        sorts[folderPath] = mode;
        await this.context.workspaceState.update(SORTS_KEY, sorts);
        this.refresh();
        // Re-order any open collection board to match the new sort.
        void CollectionPreviewPanel.refresh();
    }

    // ---- pins ----
    getPinnedInFolder(folderPath: string): string[] {
        return (this.context.workspaceState.get<Record<string, string[]>>(PINNED_FOLDER_KEY, {}))[folderPath] ?? [];
    }
    async pinInFolder(filePath: string): Promise<void> {
        const folderPath = path.dirname(filePath);
        const all = this.context.workspaceState.get<Record<string, string[]>>(PINNED_FOLDER_KEY, {});
        const list = new Set(all[folderPath] ?? []);
        list.add(filePath);
        all[folderPath] = [...list];
        await this.context.workspaceState.update(PINNED_FOLDER_KEY, all);
        await this.removeFromTopPins(filePath);
        this.refresh();
    }
    getPinnedTop(): string[] { return this.context.workspaceState.get<string[]>(PINNED_TOP_KEY, []); }
    async pinToTop(filePath: string): Promise<void> {
        const list = new Set(this.getPinnedTop());
        list.add(filePath);
        await this.context.workspaceState.update(PINNED_TOP_KEY, [...list]);
        await this.removeFromFolderPins(filePath);
        this.refresh();
    }
    async unpin(filePath: string): Promise<void> {
        await this.removeFromTopPins(filePath);
        await this.removeFromFolderPins(filePath);
        this.refresh();
    }
    private async removeFromTopPins(filePath: string): Promise<void> {
        await this.context.workspaceState.update(PINNED_TOP_KEY, this.getPinnedTop().filter((p) => p !== filePath));
    }
    private async removeFromFolderPins(filePath: string): Promise<void> {
        const folderPath = path.dirname(filePath);
        const all = this.context.workspaceState.get<Record<string, string[]>>(PINNED_FOLDER_KEY, {});
        if (all[folderPath]) {
            all[folderPath] = all[folderPath].filter((p) => p !== filePath);
            if (all[folderPath].length === 0) delete all[folderPath];
            await this.context.workspaceState.update(PINNED_FOLDER_KEY, all);
        }
    }

    // ---- hidden ----
    getHidden(): string[] { return this.context.workspaceState.get<string[]>(HIDDEN_KEY, []); }
    async hide(filePath: string): Promise<void> {
        const list = new Set(this.getHidden());
        list.add(filePath);
        await this.context.workspaceState.update(HIDDEN_KEY, [...list]);
        this.refresh();
    }
    async unhide(filePath: string): Promise<void> {
        await this.context.workspaceState.update(HIDDEN_KEY, this.getHidden().filter((p) => p !== filePath));
        this.refresh();
    }
    getShowHidden(): boolean { return this.context.workspaceState.get<boolean>(SHOW_HIDDEN_KEY, false); }
    async setShowHidden(show: boolean): Promise<void> {
        await this.context.workspaceState.update(SHOW_HIDDEN_KEY, show);
        await vscode.commands.executeCommand('setContext', 'workspaceExplorer.showHidden', show);
        this.refresh();
    }

    // ---- expand/collapse ----
    // ---- per-folder expansion persistence ----
    getExpandedFolders(): Set<string> {
        return new Set(this.context.workspaceState.get<string[]>(EXPANDED_FOLDERS_KEY, []));
    }
    async markExpanded(folderPath: string): Promise<void> {
        const set = this.getExpandedFolders();
        set.add(folderPath);
        await this.context.workspaceState.update(EXPANDED_FOLDERS_KEY, [...set]);
    }
    async markCollapsed(folderPath: string): Promise<void> {
        const set = this.getExpandedFolders();
        set.delete(folderPath);
        await this.context.workspaceState.update(EXPANDED_FOLDERS_KEY, [...set]);
    }

    getExpandAll(): boolean { return this.context.workspaceState.get<boolean>(EXPAND_ALL_KEY, false); }
    async setExpandAll(expand: boolean): Promise<void> {
        await this.context.workspaceState.update(EXPAND_ALL_KEY, expand);
        await vscode.commands.executeCommand('setContext', 'workspaceExplorer.expandAll', expand);
        this.refresh();
    }

    // ---- colors ----
    async setIconColor(folderPath: string, swatch: Swatch | undefined): Promise<void> {
        const all = this.context.workspaceState.get<Record<string, Swatch>>(ICON_COLOR_KEY, {});
        if (swatch) all[folderPath] = swatch; else delete all[folderPath];
        await this.context.workspaceState.update(ICON_COLOR_KEY, all);
        this.refresh();
    }
    async setTextColor(folderPath: string, swatch: Swatch | undefined): Promise<void> {
        const all = this.context.workspaceState.get<Record<string, Swatch>>(TEXT_COLOR_KEY, {});
        if (swatch) all[folderPath] = swatch; else delete all[folderPath];
        await this.context.workspaceState.update(TEXT_COLOR_KEY, all);
        this.refreshTree();
        this.refreshDecorations();
    }
}

// ---------- helpers for file ops ----------

async function pathExists(p: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(p); return true; } catch { return false; }
}

async function findFreeDuplicateName(original: vscode.Uri): Promise<vscode.Uri> {
    const dir = vscode.Uri.joinPath(original, '..');
    const base = path.basename(original.fsPath);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 1; i < 1000; i++) {
        const candidate = vscode.Uri.joinPath(dir, `${stem} copy${i === 1 ? '' : ' ' + i}${ext}`);
        if (!(await pathExists(candidate))) return candidate;
    }
    throw new Error('Could not find a free name for duplicate.');
}

// ---------- Tags view ----------

class TagItem extends vscode.TreeItem {
    constructor(public readonly tag: string, count: number) {
        super(tag, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${count}`;
        this.iconPath = new vscode.ThemeIcon('tag');
        this.contextValue = 'tag';
        // Single-click opens the Collection Preview (handler no-ops when feature disabled).
        this.command = {
            command: 'workspaceExplorer.openTag',
            title: 'Open Collection Preview',
            arguments: [tag],
        };
    }
}

class TagFileItem extends vscode.TreeItem {
    constructor(uri: vscode.Uri) {
        super(uri, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = uri;
        this.label = path.basename(uri.fsPath);
        this.description = vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'), false);
        this.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
        this.contextValue = 'tagFile';
    }
}

type TagNode = TagItem | TagFileItem;

class TagsProvider implements vscode.TreeDataProvider<TagNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TagNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private tagMap: Map<string, vscode.Uri[]> = new Map();
    private view: vscode.TreeView<TagNode> | undefined;
    filter = '';

    constructor(private readonly context: vscode.ExtensionContext) {}

    setView(view: vscode.TreeView<TagNode>): void { this.view = view; this.updateCount(); }

    private updateCount(): void {
        if (!this.view) return;
        const needle = this.filter.trim().toLowerCase();
        const visible = needle
            ? [...this.tagMap.keys()].filter((t) => t.toLowerCase().includes(needle)).length
            : this.tagMap.size;
        const next = needle
            ? `Tags (${visible} / ${this.tagMap.size})`
            : `Tags (${this.tagMap.size})`;
        if (this.view.title !== next) this.view.title = next;
    }

    refresh(): void {
        this.scan().then(() => { this.updateCount(); this._onDidChangeTreeData.fire(); });
    }

    fireChange(): void { this.updateCount(); this._onDidChangeTreeData.fire(); }

    getTreeItem(e: TagNode): vscode.TreeItem { return e; }

    filesForTag(tag: string): string[] {
        return (this.tagMap.get(tag) ?? []).map((u) => u.fsPath);
    }

    getTagSort(): TagSortMode {
        return this.context.workspaceState.get<TagSortMode>(TAG_SORT_KEY, DEFAULT_TAG_SORT);
    }

    setTagSort(mode: TagSortMode): void {
        this.context.workspaceState.update(TAG_SORT_KEY, mode);
        this._onDidChangeTreeData.fire();
        // Re-order any open tag collection board to match the new sort.
        void CollectionPreviewPanel.refresh();
    }

    async getChildren(e?: TagNode): Promise<TagNode[]> {
        if (!e) {
            if (this.tagMap.size === 0) await this.scan();
            const needle = this.filter.trim().toLowerCase();
            const tagSort = this.getTagSort();
            return [...this.tagMap.entries()]
                .filter(([tag]) => !needle || tag.toLowerCase().includes(needle))
                .sort((a, b) => {
                    switch (tagSort) {
                        case 'nameDesc':   return b[0].localeCompare(a[0]);
                        case 'countDesc':  return b[1].length - a[1].length || a[0].localeCompare(b[0]);
                        case 'countAsc':   return a[1].length - b[1].length || a[0].localeCompare(b[0]);
                        default:           return a[0].localeCompare(b[0]);
                    }
                })
                .map(([tag, files]) => new TagItem(tag, files.length));
        }
        if (e instanceof TagItem) {
            const files = this.tagMap.get(e.tag) ?? [];
            return files
                .slice()
                .sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)))
                .map((u) => new TagFileItem(u));
        }
        return [];
    }

    private async scan(): Promise<void> {
        this.tagMap = new Map();
        const cfg = vscode.workspace.getConfiguration('workspaceExplorer');
        const included = cfg.get<string[]>('tagIncludedFolders', ['**/*.md']);
        const include = combineIncludeGlob(included, '**/*.md');
        const files = await vscode.workspace.findFiles(include, '**/node_modules/**');
        await Promise.all(files.map(async (uri) => {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                const tags = extractTags(text);
                for (const t of tags) {
                    if (!this.tagMap.has(t)) this.tagMap.set(t, []);
                    this.tagMap.get(t)!.push(uri);
                }
            } catch { /* skip */ }
        }));
    }
}

function extractTags(text: string): Set<string> {
    const tags = new Set<string>();

    // Frontmatter.
    const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fm) {
        const fmBody = fm[1];
        for (const key of ['tags', 'tag', 'keywords']) {
            // List form first so the inline/CSV regex doesn't accidentally cross newlines.
            const list = fmBody.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*\\n((?:[ \\t]*-[ \\t]*.+\\n?)+)`, 'm'));
            if (list) {
                for (const line of list[1].split('\n')) {
                    const m = line.match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/);
                    if (m) tags.add(m[1].replace(/^["']|["']$/g, '').replace(/^#/, ''));
                }
                continue;
            }
            const inline = fmBody.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*\\[(.*?)\\]`, 'm'));
            if (inline) {
                for (const raw of inline[1].split(',')) {
                    const t = raw.trim().replace(/^["']|["']$/g, '').replace(/^#/, '');
                    if (t) tags.add(t);
                }
                continue;
            }
            // CSV form: `tags: a, b, c` — restrict to same line (no newline in whitespace).
            const csv = fmBody.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]+([^\\[\\n][^\\n]*)$`, 'm'));
            if (csv) {
                for (const raw of csv[1].split(',')) {
                    const t = raw.trim().replace(/^["']|["']$/g, '').replace(/^#/, '');
                    if (t) tags.add(t);
                }
            }
        }
    }

    // Strip frontmatter, fenced code blocks, and inline code spans before inline-tag scan.
    let body = fm ? text.slice(fm[0].length) : text;
    body = body.replace(/```[\s\S]*?```/g, ' ');
    body = body.replace(/~~~[\s\S]*?~~~/g, ' ');
    body = body.replace(/`[^`\n]*`/g, ' ');
    // Strip markdown link/image targets so `](#anchor)` and `](url#frag)` don't match.
    body = body.replace(/\]\([^)]*\)/g, ']');

    // Obsidian-style multi-word tag: #[[Some Tag]]
    const multi = /(^|[^\w])#\[\[([^\]]+)\]\]/gu;
    let mm: RegExpExecArray | null;
    while ((mm = multi.exec(body))) {
        const t = mm[2].trim();
        if (t) tags.add(t);
    }

    // Plain inline tags: #tag, #tag/subtag, #2024-q1 (must contain at least one letter).
    const re = /(^|[^#\w/`])#([A-Za-z0-9_][\w/\-]*)/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
        const tag = m[2];
        if (!/[A-Za-z]/.test(tag)) continue; // require at least one letter
        tags.add(tag);
    }
    return tags;
}

// ---------- Orphans view ----------

class OrphanItem extends vscode.TreeItem {
    constructor(uri: vscode.Uri) {
        super(uri, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = uri;
        this.label = path.basename(uri.fsPath);
        this.description = vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'), false);
        this.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
        this.contextValue = 'orphanFile';
    }
}

class OrphansProvider implements vscode.TreeDataProvider<OrphanItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<OrphanItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private orphans: vscode.Uri[] = [];
    private view: vscode.TreeView<OrphanItem> | undefined;

    constructor(private readonly main: WorkspaceExplorerProvider) {}

    setView(view: vscode.TreeView<OrphanItem>): void { this.view = view; this.updateCount(); }
    private updateCount(): void {
        if (!this.view) return;
        const next = `Orphans (${this.orphans.length})`;
        if (this.view.title !== next) this.view.title = next;
    }

    refresh(): void {
        this.scan().then(() => { this.updateCount(); this._onDidChangeTreeData.fire(); });
    }

    getTreeItem(e: OrphanItem): vscode.TreeItem { return e; }

    async getChildren(e?: OrphanItem): Promise<OrphanItem[]> {
        if (e) return [];
        if (this.orphans.length === 0) await this.scan();
        return this.orphans
            .slice()
            .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
            .map((u) => new OrphanItem(u));
    }

    private async scan(): Promise<void> {
        this.orphans = [];
        const cfg = vscode.workspace.getConfiguration('workspaceExplorer');
        const included = cfg.get<string[]>('orphanIncludedFolders', ['**/*']);
        const excluded = cfg.get<string[]>('orphanExcludedFolders', []);
        const include = combineIncludeGlob(included, '**/*');
        const exclude = combineExcludeGlob(excluded);

        // Candidates: files we CHECK for being orphans (respects watched/ignored).
        const candidateFiles = await vscode.workspace.findFiles(include, exclude);
        const hidden = new Set(this.main.getHidden());
        const showHidden = this.main.getShowHidden();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const candidates = showHidden
            ? candidateFiles
            : candidateFiles.filter((u) => !isHiddenAncestry(u.fsPath, hidden, root));

        // Reference corpus: ALL workspace text files (minus heavy excludes), so links
        // from notes outside the watched folders still count.
        const corpusFiles = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**}',
        );

        const MAX = 1_000_000;
        const loadText = async (uri: vscode.Uri): Promise<string | undefined> => {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > MAX) return undefined;
                const bytes = await vscode.workspace.fs.readFile(uri);
                for (let i = 0; i < Math.min(bytes.length, 512); i++) {
                    if (bytes[i] === 0) return undefined; // binary
                }
                return Buffer.from(bytes).toString('utf8');
            } catch { return undefined; }
        };

        const candidatePaths = new Set(candidates.map((u) => u.fsPath));
        const corpus = await Promise.all(corpusFiles.map(async (uri) => {
            const text = await loadText(uri);
            return text === undefined ? undefined : { uri, text };
        }));
        const corpusItems = corpus.filter((c): c is { uri: vscode.Uri; text: string } => !!c);

        // Build per-candidate "other text" = all corpus content EXCEPT the candidate's own file.
        const corpusByPath = new Map(corpusItems.map((c) => [c.uri.fsPath, c.text]));
        const fullCorpusText = corpusItems.map((c) => c.text).join('\n\n');

        for (const f of candidates) {
            const base = path.basename(f.fsPath);
            const ext = path.extname(base);
            const stem = ext ? base.slice(0, -ext.length) : base;
            const selfText = corpusByPath.get(f.fsPath) ?? '';
            const otherText = selfText ? fullCorpusText.replace(selfText, '') : fullCorpusText;
            const referenced =
                otherText.includes(base) ||
                (stem && stem.length >= 3 && otherText.includes(stem));
            if (!referenced) this.orphans.push(f);
        }
    }
}

// ---------- Recent Files view ----------

class RecentItem extends vscode.TreeItem {
    constructor(uri: vscode.Uri, mtime: number) {
        super(uri, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = uri;
        this.label = path.basename(uri.fsPath);
        const rel = vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'), false);
        const when = new Date(mtime).toLocaleString();
        this.description = rel ? `${rel} · ${when}` : when;
        this.tooltip = `${uri.fsPath}\nModified: ${when}`;
        this.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
        this.contextValue = 'recentFile';
    }
}

class RecentFilesProvider implements vscode.TreeDataProvider<RecentItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RecentItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private items: { uri: vscode.Uri; mtime: number }[] = [];
    private view: vscode.TreeView<RecentItem> | undefined;

    constructor(private readonly main: WorkspaceExplorerProvider) {}

    setView(view: vscode.TreeView<RecentItem>): void { this.view = view; this.updateCount(); }
    private updateCount(): void {
        if (!this.view) return;
        const next = `Recent Files (${this.items.length})`;
        if (this.view.title !== next) this.view.title = next;
    }

    refresh(): void { this.scan().then(() => { this.updateCount(); this._onDidChangeTreeData.fire(); }); }

    getTreeItem(e: RecentItem): vscode.TreeItem { return e; }

    async getChildren(e?: RecentItem): Promise<RecentItem[]> {
        if (e) return [];
        if (this.items.length === 0) await this.scan();
        return this.items.map((i) => new RecentItem(i.uri, i.mtime));
    }

    private async scan(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('workspaceExplorer');
        const count = Math.max(1, cfg.get<number>('recentFilesCount', 15));
        const included = cfg.get<string[]>('recentIncludedFolders', ['**/*']);
        const excluded = cfg.get<string[]>('recentExcludedFolders', []);
        const include = combineIncludeGlob(included, '**/*');
        const exclude = combineExcludeGlob(excluded);
        const files = await vscode.workspace.findFiles(include, exclude);
        const hidden = new Set(this.main.getHidden());
        const showHidden = this.main.getShowHidden();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const visible = showHidden ? files : files.filter((u) => !isHiddenAncestry(u.fsPath, hidden, root));
        const stats = await Promise.all(visible.map(async (uri) => {
            try {
                const s = await vscode.workspace.fs.stat(uri);
                if (s.type !== vscode.FileType.File) return undefined;
                return { uri, mtime: s.mtime };
            } catch { return undefined; }
        }));
        this.items = stats
            .filter((s): s is { uri: vscode.Uri; mtime: number } => !!s)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, count);
    }
}

// ---------- activate ----------

// ---------------------------------------------------------------------------
// Collection Preview (MindChuk-style note board)
// ---------------------------------------------------------------------------

function collectionPreviewEnabled(): boolean {
    return vscode.workspace.getConfiguration('workspaceExplorer').get<boolean>('collectionPreview.enabled', true);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

// Recursively collect ALL files under a directory, skipping dotfiles/dotdirs and node_modules.
async function collectMarkdownFiles(dir: string, acc: string[], limit: number): Promise<void> {
    if (acc.length >= limit) return;
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
        return;
    }
    for (const [name, type] of entries) {
        if (acc.length >= limit) return;
        if (name.startsWith('.') || name === 'node_modules') continue;
        const full = path.join(dir, name);
        if (type === vscode.FileType.Directory) {
            await collectMarkdownFiles(full, acc, limit);
        } else if (type === vscode.FileType.File) {
            acc.push(full);
        }
    }
}

// Shared markdown-it instance. html:false disallows raw HTML from notes (safer);
// linkify + typographer for nicer rendering.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);

type CardKind = 'markdown' | 'image' | 'file';

// Same task-item regex used at render time AND edit time so indices line up.
const TASK_LINE_RE = /^(\s*[-*+]\s+\[)( |x|X)(\])/;

interface NoteCard {
    path: string;
    title: string;
    kind: CardKind;
    html: string;       // rendered markdown HTML (markdown kind only)
    color: string | undefined;
}

// Walk ancestors of a file to find the nearest folder with an assigned ICON color (folder color).
function resolveFolderColor(filePath: string, iconColors: Record<string, Swatch>): string | undefined {
    let cur = path.dirname(filePath);
    while (true) {
        const sw = iconColors[cur];
        if (sw) return CSS_COLOR_BY_SWATCH[sw];
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return undefined;
}

// Middle-truncate a filename, always preserving the extension.
function truncateFilename(name: string, max = 40): string {
    if (name.length <= max) return name;
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const keep = Math.max(1, max - ext.length - 1);
    return stem.slice(0, keep).trimEnd() + '…' + ext;
}

// Strip leading YAML frontmatter from a markdown body.
function stripFrontmatter(body: string): string {
    return body.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// Post-process markdown-it output so task-list items become interactive checkboxes.
// Plain markdown-it renders `- [ ]`/`- [x]` as a literal "[ ] text" inside an <li>;
// it does NOT emit <input> elements. We detect those <li> items (in document order,
// which matches source order) and replace the leading "[ ]"/"[x]" marker with an
// ENABLED checkbox carrying a 0-based data-task-index matching the Nth task line in
// the source (counted with the same TASK_LINE_RE used when editing the file).
function makeTaskCheckboxesInteractive(html: string): string {
    let idx = 0;
    return html.replace(/<li>(\s*)\[([ xX])\]\s?/g, (_m, lead, mark) => {
        const checked = mark === 'x' || mark === 'X';
        const out = `<li class="task-list-item">${lead}<input type="checkbox" class="task-checkbox" data-task-index="${idx}"${checked ? ' checked' : ''}> `;
        idx++;
        return out;
    });
}

async function buildNoteCard(filePath: string, iconColors: Record<string, Swatch>): Promise<NoteCard> {
    const ext = path.extname(filePath).toLowerCase();
    const color = resolveFolderColor(filePath, iconColors);
    const filename = path.basename(filePath);

    if (IMAGE_EXTS.has(ext)) {
        return { path: filePath, title: filename, kind: 'image', html: '', color };
    }
    if (!MARKDOWN_EXTS.has(ext)) {
        return { path: filePath, title: filename, kind: 'file', html: '', color };
    }

    // Markdown: read, strip frontmatter, render to HTML, derive title.
    let body = '';
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        body = Buffer.from(bytes).toString('utf8');
    } catch {
        body = '';
    }
    body = stripFrontmatter(body);
    const rendered = makeTaskCheckboxesInteractive(md.render(body));
    return { path: filePath, title: filename, kind: 'markdown', html: rendered, color };
}

// Flip the Nth (0-based) task-list checkbox in a markdown file's source to `checked`.
// Counts task lines in source order using the SAME regex as the renderer.
async function toggleTaskInFile(filePath: string, index: number, checked: boolean): Promise<void> {
    let body: string;
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        body = Buffer.from(bytes).toString('utf8');
    } catch {
        return;
    }
    const lines = body.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_LINE_RE);
        if (!m) continue;
        if (count === index) {
            lines[i] = lines[i].replace(TASK_LINE_RE, `$1${checked ? 'x' : ' '}$3`);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(lines.join('\n'), 'utf8'));
            return;
        }
        count++;
    }
}

// Inline SVG glyphs used for non-markdown, non-image cards.
function fileGlyphSvg(ext: string): string {
    if (ext === '.pdf') {
        return `<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/>
            <text x="12" y="18" font-size="6" text-anchor="middle" fill="currentColor" stroke="none">PDF</text></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/></svg>`;
}

class CollectionPreviewPanel {
    private static panel: vscode.WebviewPanel | undefined;
    // How to re-gather + re-render the currently shown collection. Set by the
    // open commands; cleared when the panel is disposed.
    private static reload: (() => Promise<void>) | undefined;

    private static getLayout(context: vscode.ExtensionContext): 'expanded' | 'compressed' {
        return context.workspaceState.get<'expanded' | 'compressed'>(COLLECTION_LAYOUT_KEY, 'expanded');
    }

    // Remember how to rebuild the current collection so a filesystem change
    // (rename/delete/move/new from a context menu, drag-drop, or external tool)
    // can refresh the board in place.
    static setSource(reload: () => Promise<void>): void {
        this.reload = reload;
    }

    // Re-render the open panel from its source. No-op if no panel is open, so a
    // file change never pops the board back up after the user closed it.
    static async refresh(): Promise<void> {
        if (this.panel && this.reload) await this.reload();
    }

    static async show(context: vscode.ExtensionContext, heading: string, files: string[]): Promise<void> {
        const iconColors = context.workspaceState.get<Record<string, Swatch>>(ICON_COLOR_KEY, {});
        const MAX = 500;
        const total = files.length;
        const capped = files.slice(0, MAX);
        const cards = await Promise.all(capped.map((f) => buildNoteCard(f, iconColors)));

        // localResourceRoots must include workspace folders so images load via asWebviewUri.
        const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'workspaceExplorerCollectionPreview',
                heading,
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: roots,
                },
            );
            this.panel.onDidDispose(() => { this.panel = undefined; this.reload = undefined; });
            this.panel.webview.onDidReceiveMessage(async (msg) => {
                if (!msg || typeof msg.type !== 'string') return;
                if (msg.type === 'open' && typeof msg.path === 'string') {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
                } else if (msg.type === 'setLayout' && (msg.layout === 'expanded' || msg.layout === 'compressed')) {
                    await context.workspaceState.update(COLLECTION_LAYOUT_KEY, msg.layout);
                } else if (msg.type === 'toggleTask'
                    && typeof msg.path === 'string'
                    && typeof msg.index === 'number'
                    && typeof msg.checked === 'boolean') {
                    await toggleTaskInFile(msg.path, msg.index, msg.checked);
                }
            });
        }
        this.panel.title = heading;
        this.panel.webview.html = this.render(this.panel.webview, heading, cards, total, MAX, this.getLayout(context));
        this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
    }

    private static render(
        webview: vscode.Webview,
        heading: string,
        cards: NoteCard[],
        total: number,
        max: number,
        layout: 'expanded' | 'compressed',
    ): string {
        const nonce = makeNonce();
        const truncated = total > max
            ? `<div class="note">Showing ${max} of ${total} items</div>`
            : '';
        const cardHtml = cards.map((c) => {
            const accent = c.color ?? 'var(--vscode-panel-border)';
            const ctx = JSON.stringify({
                webviewSection: 'previewCard',
                filePath: c.path,
                preventDefaultContextMenuItems: true,
            }).replace(/"/g, '&quot;');
            let inner: string;
            if (c.kind === 'image') {
                const src = webview.asWebviewUri(vscode.Uri.file(c.path)).toString();
                inner = `<div class="card-title" title="${escapeHtml(c.title)}">${escapeHtml(truncateFilename(c.title))}</div>
                    <div class="card-body img-body"><img class="card-img" src="${src}" alt="${escapeHtml(c.title)}"></div>`;
            } else if (c.kind === 'file') {
                const ext = path.extname(c.path).toLowerCase();
                // Title above shows the filename; the body is just the glyph.
                inner = `<div class="card-title" title="${escapeHtml(c.title)}">${escapeHtml(truncateFilename(c.title))}</div>
                    <div class="card-body file-body">
                        <div class="file-glyph">${fileGlyphSvg(ext)}</div>
                    </div>`;
            } else {
                // markdown
                inner = `<div class="card-title" title="${escapeHtml(c.title)}">${escapeHtml(truncateFilename(c.title))}</div>
                    <div class="card-body md-body">${c.html}</div>`;
            }
            // file-kind cards never expand: always rendered at compressed size.
            const kindClass = `card card-${c.kind}`;
            return `<div class="${kindClass}" data-path="${escapeHtml(c.path)}" data-vscode-context="${ctx}" style="border-left-color: ${accent};">
                ${inner}
            </div>`;
        }).join('\n');
        const empty = cards.length === 0 ? `<div class="note">No items in this collection.</div>` : '';
        const containerClass = layout === 'compressed' ? 'grid compressed' : 'grid';
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body {
        margin: 0;
        padding: 16px;
        background: var(--vscode-editor-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
    }
    h1 { font-size: 1.2em; margin: 0 0 12px 0; font-weight: 600; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .header h1 { margin: 0; }
    .layout-toggle {
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        padding: 4px 10px;
        cursor: pointer;
        font-size: 0.85em;
    }
    .layout-toggle:hover { opacity: 0.85; }
    .note { opacity: 0.7; margin-bottom: 12px; font-size: 0.9em; }
    /* True masonry via CSS multi-column flow: cards pack top-to-bottom within
       each column with no row-height gaps (a CSS grid aligns rows, leaving the
       gaps the user saw). column-width drives the responsive column count. */
    .grid {
        column-width: 240px;
        column-gap: 14px;
    }
    .card {
        position: relative;
        break-inside: avoid;
        -webkit-column-break-inside: avoid;
        margin: 0 0 14px 0;
        background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
        border: 1px solid var(--vscode-panel-border);
        border-left-width: 4px;
        border-left-color: var(--vscode-panel-border);
        border-radius: 10px;
        padding: 12px 14px;
        cursor: pointer;
        overflow: hidden;
        transition: transform 0.08s ease, box-shadow 0.08s ease;
    }
    .card:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    }
    .card-title {
        /* Small uppercase label so the filename reads as a header, not body text. */
        font-size: 0.7em;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
        /* Filename is already middle-truncated; keep it to a single line and never
           let the flex column crush it (fixes the title vanishing in compress mode). */
        flex: 0 0 auto;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .card-body { position: relative; }

    /* ---- Markdown body: shrunken rendered-preview look ---- */
    .md-body { font-size: 0.8em; line-height: 1.45; opacity: 0.92; word-break: break-word; }
    .md-body h1 { font-size: 1.25em; margin: 0.4em 0 0.3em; }
    .md-body h2 { font-size: 1.15em; margin: 0.4em 0 0.3em; }
    .md-body h3, .md-body h4, .md-body h5, .md-body h6 { font-size: 1.05em; margin: 0.35em 0 0.25em; }
    .md-body p { margin: 0.4em 0; }
    .md-body ul, .md-body ol { margin: 0.3em 0; padding-left: 1.3em; }
    .md-body pre {
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
        padding: 6px 8px; border-radius: 6px; overflow-x: auto; font-size: 0.95em;
    }
    .md-body code { font-family: var(--vscode-editor-font-family, monospace); }
    .md-body blockquote {
        margin: 0.4em 0; padding-left: 8px; opacity: 0.85;
        border-left: 3px solid var(--vscode-panel-border);
    }
    .md-body img { max-width: 100%; max-height: 160px; object-fit: contain; }
    .md-body a { color: var(--vscode-textLink-foreground); }
    .md-body ul.contains-task-list, .md-body li.task-list-item { list-style: none; }
    .md-body li.task-list-item { margin-left: -1.1em; }
    .task-checkbox { cursor: pointer; vertical-align: middle; margin-right: 4px; }

    /* ---- Image cards ---- */
    /* Expanded mode: fixed-height band showing a centered horizontal slice. */
    .img-body { height: 180px; width: 100%; overflow: hidden; border-radius: 6px; }
    .card-img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }

    /* ---- Generic file cards (pdf/other): always compressed, never expand. ---- */
    .card-file .file-body {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; height: 128px; opacity: 0.85;
    }
    .file-glyph { color: var(--vscode-foreground); opacity: 0.7; }

    /* ---- Compressed mode: EVERY card is the exact same total size. ----
       Fix the height on the .card itself (not just the body) and lay it out as a
       flex column: the title takes its natural height and the body fills the rest.
       This keeps all cards identical regardless of content — including image and
       file cards, whose media fills the remaining space and crops to fill. */
    .grid.compressed .card {
        height: 200px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    .grid.compressed .card .card-body {
        flex: 1 1 auto;
        min-height: 0;          /* allow the flex child to shrink so overflow works */
        max-height: none;
        overflow-y: auto;
        overflow-x: hidden;
        position: relative;
    }
    /* Media fills the leftover space (MindChuk-style filled thumbnails). */
    .grid.compressed .card-image .img-body,
    .grid.compressed .card-file .file-body { height: 100%; }
    .grid.compressed .card-markdown .card-body::after {
        content: "";
        position: absolute; left: 0; right: 0; bottom: 0; height: 36px;
        background: linear-gradient(to bottom, transparent, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
        pointer-events: none;
    }
</style>
</head>
<body>
    <div class="header">
        <h1>${escapeHtml(heading)}</h1>
        <button class="layout-toggle" id="layoutToggle"></button>
    </div>
    ${truncated}
    ${empty}
    <div class="${containerClass}" id="grid">
        ${cardHtml}
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const grid = document.getElementById('grid');
        const toggleBtn = document.getElementById('layoutToggle');

        // Restore layout from webview state if present, else fall back to server-provided value.
        const prev = vscode.getState();
        let layout = (prev && prev.layout) ? prev.layout : '${layout}';
        function applyLayout() {
            if (layout === 'compressed') grid.classList.add('compressed');
            else grid.classList.remove('compressed');
            toggleBtn.textContent = layout === 'compressed' ? 'Expand ⇕' : 'Compress ⇕';
            vscode.setState({ layout });
        }
        applyLayout();

        toggleBtn.addEventListener('click', () => {
            layout = layout === 'compressed' ? 'expanded' : 'compressed';
            applyLayout();
            vscode.postMessage({ type: 'setLayout', layout });
        });

        document.querySelectorAll('.card').forEach((el) => {
            el.addEventListener('click', (e) => {
                // Don't open when interacting with a checkbox.
                if (e.target && e.target.classList && e.target.classList.contains('task-checkbox')) return;
                vscode.postMessage({ type: 'open', path: el.getAttribute('data-path') });
            });
        });

        document.querySelectorAll('.task-checkbox').forEach((cb) => {
            cb.addEventListener('click', (e) => { e.stopPropagation(); });
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const card = cb.closest('.card');
                vscode.postMessage({
                    type: 'toggleTask',
                    path: card.getAttribute('data-path'),
                    index: parseInt(cb.getAttribute('data-task-index'), 10),
                    checked: cb.checked,
                });
            });
        });
    </script>
</body>
</html>`;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new WorkspaceExplorerProvider(context);
    const view = vscode.window.createTreeView('workspaceExplorer.tree', {
        treeDataProvider: provider,
        dragAndDropController: provider,
        canSelectMany: true,
    });
    context.subscriptions.push(view);
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const swapFolderIcon = (node: FileNode, open: boolean) => {
        if (!node.isDirectory) return;
        // Mirror the same logic FileNode uses on construction.
        const iconColors = context.workspaceState.get<Record<string, Swatch>>(ICON_COLOR_KEY, {});
        const base = iconColors[node.uri.fsPath] ?? 'default';
        const variant = open ? `${base}-open.svg` : `${base}.svg`;
        node.iconPath = vscode.Uri.joinPath(mediaRoot, 'folders', variant);
    };
    context.subscriptions.push(view.onDidExpandElement(async (e) => {
        await provider.markExpanded(e.element.uri.fsPath);
        swapFolderIcon(e.element, true);
        provider.refreshNode(e.element);
    }));
    context.subscriptions.push(view.onDidCollapseElement(async (e) => {
        await provider.markCollapsed(e.element.uri.fsPath);
        swapFolderIcon(e.element, false);
        provider.refreshNode(e.element);
    }));

    const tagsProvider = new TagsProvider(context);
    const orphansProvider = new OrphansProvider(provider);
    const recentProvider = new RecentFilesProvider(provider);
    const tagsView = vscode.window.createTreeView('workspaceExplorer.tags', { treeDataProvider: tagsProvider });
    const orphansView = vscode.window.createTreeView('workspaceExplorer.orphans', { treeDataProvider: orphansProvider });
    const recentView = vscode.window.createTreeView('workspaceExplorer.recent', { treeDataProvider: recentProvider });
    tagsProvider.setView(tagsView);
    orphansProvider.setView(orphansView);
    recentProvider.setView(recentView);
    // Populate counts up front so titles show numbers even before the user expands the views.
    tagsProvider.refresh();
    orphansProvider.refresh();
    recentProvider.refresh();
    context.subscriptions.push(
        tagsView,
        orphansView,
        recentView,
        vscode.commands.registerCommand('workspaceExplorer.openFolder', async (uri?: vscode.Uri) => {
            // No-op when the feature is disabled, preserving plain expand/collapse behavior.
            if (!collectionPreviewEnabled() || !uri) return;
            const run = async () => {
                const files: string[] = [];
                await collectMarkdownFiles(uri.fsPath, files, 500);
                // Order preview cards using the folder's own sort mode (Feature 1).
                const sorted = await sortFilePaths(files, provider.getSortMode(uri.fsPath));
                await CollectionPreviewPanel.show(context, `Collection: ${path.basename(uri.fsPath)}`, sorted);
            };
            CollectionPreviewPanel.setSource(run);
            await run();
        }),
        vscode.commands.registerCommand('workspaceExplorer.openTag', async (tag?: string) => {
            if (!collectionPreviewEnabled() || !tag) return;
            const run = async () => {
                const files = tagsProvider.filesForTag(tag);
                // Order tag preview cards by basename. TagSortMode's count modes have
                // no per-file meaning here, so they fall back to ascending name; name
                // modes honor the chosen direction.
                const tagSort = tagsProvider.getTagSort();
                const dir: SortMode = tagSort === 'nameDesc' ? 'nameDesc' : 'nameAsc';
                const sorted = await sortFilePaths(files, dir);
                await CollectionPreviewPanel.show(context, `Tag: #${tag}`, sorted);
            };
            CollectionPreviewPanel.setSource(run);
            await run();
        }),
        vscode.commands.registerCommand('workspaceExplorer.tags.sortNameAsc', () => tagsProvider.setTagSort('nameAsc')),
        vscode.commands.registerCommand('workspaceExplorer.tags.sortNameDesc', () => tagsProvider.setTagSort('nameDesc')),
        vscode.commands.registerCommand('workspaceExplorer.tags.sortCountDesc', () => tagsProvider.setTagSort('countDesc')),
        vscode.commands.registerCommand('workspaceExplorer.tags.sortCountAsc', () => tagsProvider.setTagSort('countAsc')),
        vscode.commands.registerCommand('workspaceExplorer.tags.refresh', () => tagsProvider.refresh()),
        vscode.commands.registerCommand('workspaceExplorer.tags.filter', () => {
            const input = vscode.window.createInputBox();
            input.placeholder = 'Filter tags as you type… (Enter to apply, Esc to cancel)';
            input.value = tagsProvider.filter;
            const original = tagsProvider.filter;
            let accepted = false;
            input.onDidChangeValue((value) => {
                tagsProvider.filter = value;
                vscode.commands.executeCommand('setContext', 'workspaceExplorer.tagFilterActive', !!value);
                tagsProvider.fireChange();
            });
            input.onDidAccept(() => { accepted = true; input.hide(); });
            input.onDidHide(() => {
                if (!accepted) {
                    tagsProvider.filter = original;
                    vscode.commands.executeCommand('setContext', 'workspaceExplorer.tagFilterActive', !!original);
                    tagsProvider.fireChange();
                }
                input.dispose();
            });
            input.show();
        }),
        vscode.commands.registerCommand('workspaceExplorer.tags.clearFilter', () => {
            tagsProvider.filter = '';
            vscode.commands.executeCommand('setContext', 'workspaceExplorer.tagFilterActive', false);
            tagsProvider.fireChange();
        }),
        vscode.commands.registerCommand('workspaceExplorer.orphans.refresh', () => orphansProvider.refresh()),
        vscode.commands.registerCommand('workspaceExplorer.recent.refresh', () => recentProvider.refresh()),
    );

    // Refresh recent files when settings change.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workspaceExplorer.recentFilesCount')
            || e.affectsConfiguration('workspaceExplorer.recentIncludedFolders')
            || e.affectsConfiguration('workspaceExplorer.recentExcludedFolders')) {
            recentProvider.refresh();
        }
        if (e.affectsConfiguration('workspaceExplorer.orphanIncludedFolders')
            || e.affectsConfiguration('workspaceExplorer.orphanExcludedFolders')) {
            orphansProvider.refresh();
        }
        if (e.affectsConfiguration('workspaceExplorer.tagIncludedFolders')) {
            tagsProvider.refresh();
        }
    }));

    // Open on startup. The workbench restores its last sidebar view AFTER extensions activate
    // (and sometimes after our first focus calls), so we brute-force focus for a few seconds
    // and ALSO refocus the first time the user's window becomes active.
    if (vscode.workspace.getConfiguration('workspaceExplorer').get<boolean>('openOnStartup', false)) {
        const focus = async () => {
            try {
                await vscode.commands.executeCommand('workbench.view.extension.workspaceExplorer');
            } catch { /* ignore */ }
            try {
                await vscode.commands.executeCommand('workspaceExplorer.tree.focus');
            } catch { /* ignore */ }
        };
        // Fire on a schedule covering ~6s, regardless of visibility state.
        for (const ms of [0, 100, 250, 500, 1000, 1750, 2750, 4000, 6000]) {
            setTimeout(focus, ms);
        }
        // Also refocus once on the first window-state change (covers the case where
        // Cursor's restore happens at an unpredictable time).
        const onceOnState = vscode.window.onDidChangeWindowState(() => {
            focus();
            onceOnState.dispose();
        });
        context.subscriptions.push(onceOnState);
    }

    // Debounced refreshers so rapid file changes (typing + autosave) don't cause flashing/churn.
    const debounce = (fn: () => void, ms: number) => {
        let t: ReturnType<typeof setTimeout> | undefined;
        return () => {
            if (t) clearTimeout(t);
            t = setTimeout(fn, ms);
        };
    };

    // Refresh tags/orphans when workspace files change.
    const aux = vscode.workspace.createFileSystemWatcher('**/*');
    const debouncedAuxRefresh = debounce(() => {
        tagsProvider.refresh();
        orphansProvider.refresh();
        recentProvider.refresh();
    }, 800);
    aux.onDidCreate(() => debouncedAuxRefresh());
    aux.onDidChange(() => debouncedAuxRefresh());
    aux.onDidDelete(() => debouncedAuxRefresh());
    context.subscriptions.push(aux);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));

    vscode.commands.executeCommand('setContext', 'workspaceExplorer.showHidden', provider.getShowHidden());
    vscode.commands.executeCommand('setContext', 'workspaceExplorer.expandAll', provider.getExpandAll());

    const requireNode = (node: FileNode | undefined): node is FileNode => {
        if (!node) {
            vscode.window.showWarningMessage('No item selected.');
            return false;
        }
        return true;
    };

    const setSort = (mode: SortMode) => async (node?: FileNode) => {
        const folderPath = node?.isDirectory
            ? node.uri.fsPath
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!folderPath) return;
        await provider.setSortMode(folderPath, mode);
    };

    const folderTarget = (node?: FileNode): string | undefined => {
        if (node?.isDirectory) return node.uri.fsPath;
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    };

    // Color commands.
    const registerColor = (kind: 'iconColor' | 'textColor', swatch: Swatch | undefined) => {
        const suffix = swatch ?? 'default';
        return vscode.commands.registerCommand(`workspaceExplorer.${kind}.${suffix}`, async (node?: FileNode) => {
            const target = folderTarget(node);
            if (!target) return;
            if (kind === 'iconColor') await provider.setIconColor(target, swatch);
            else await provider.setTextColor(target, swatch);
        });
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('workspaceExplorer.refresh', () => provider.refresh()),
        vscode.commands.registerCommand('workspaceExplorer.sortNameAsc', setSort('nameAsc')),
        vscode.commands.registerCommand('workspaceExplorer.sortNameDesc', setSort('nameDesc')),
        vscode.commands.registerCommand('workspaceExplorer.sortEditedAsc', setSort('editedAsc')),
        vscode.commands.registerCommand('workspaceExplorer.sortEditedDesc', setSort('editedDesc')),
        vscode.commands.registerCommand('workspaceExplorer.pinToFolder', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node) && !node.isDirectory) return provider.pinInFolder(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.pinToTop', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node) && !node.isDirectory) return provider.pinToTop(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.unpin', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node) && !node.isDirectory) return provider.unpin(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.hide', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node)) return provider.hide(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.unhide', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node)) return provider.unhide(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.toggleHiddenShow', async () => {
            await provider.setShowHidden(true);
            recentProvider.refresh();
            orphansProvider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.toggleHiddenHide', async () => {
            await provider.setShowHidden(false);
            recentProvider.refresh();
            orphansProvider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.expandAll', async () => {
            await provider.setExpandAll(true);
            // Walk the tree and reveal every folder. expand: 3 = expand 3 levels at a time.
            const walk = async (parent?: FileNode, depth = 0): Promise<void> => {
                if (depth > 12) return; // safety
                const children = await provider.getChildren(parent);
                for (const child of children) {
                    if (child.isDirectory) {
                        try { await view.reveal(child, { expand: 3, select: false, focus: false }); } catch { /* ignore */ }
                        await walk(child, depth + 1);
                    }
                }
            };
            await walk();
        }),
        vscode.commands.registerCommand('workspaceExplorer.collapseAll', async () => {
            await provider.setExpandAll(false);
            await vscode.commands.executeCommand('workbench.actions.treeView.workspaceExplorer.tree.collapseAll');
        }),
    );

    // Register all color swatch commands.
    context.subscriptions.push(registerColor('iconColor', undefined));
    for (const s of SWATCHES) context.subscriptions.push(registerColor('iconColor', s));
    context.subscriptions.push(registerColor('textColor', undefined));
    for (const s of SWATCHES) context.subscriptions.push(registerColor('textColor', s));

    // Resource actions — delegate to built-ins with our URI.
    context.subscriptions.push(
        vscode.commands.registerCommand('workspaceExplorer.revealInOS', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node)) return vscode.commands.executeCommand('revealFileInOS', node.uri);
        }),
        vscode.commands.registerCommand('workspaceExplorer.openInTerminal', (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node)) return vscode.commands.executeCommand('openInIntegratedTerminal', node.uri);
        }),
        vscode.commands.registerCommand('workspaceExplorer.copyPath', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node)) await vscode.env.clipboard.writeText(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.copyRelativePath', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node)) {
                const rel = vscode.workspace.asRelativePath(node.uri, false);
                await vscode.env.clipboard.writeText(rel);
            }
        }),
        vscode.commands.registerCommand('workspaceExplorer.openToSide', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (requireNode(node) && !node.isDirectory) {
                await vscode.commands.executeCommand('vscode.open', node.uri, { viewColumn: vscode.ViewColumn.Beside });
            }
        }),
    );

    // File ops.
    context.subscriptions.push(
        vscode.commands.registerCommand('workspaceExplorer.rename', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (!requireNode(node)) return;
            const oldBase = path.basename(node.uri.fsPath);
            const input = await vscode.window.showInputBox({
                prompt: 'New name',
                value: oldBase,
                valueSelection: [0, oldBase.length - path.extname(oldBase).length],
            });
            if (!input || input === oldBase) return;
            const target = vscode.Uri.joinPath(node.uri, '..', input);
            const edit = new vscode.WorkspaceEdit();
            edit.renameFile(node.uri, target, { overwrite: false });
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) vscode.window.showErrorMessage('Rename failed.');
            provider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.move', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (!requireNode(node)) return;
            const root = vscode.workspace.workspaceFolders?.[0];
            if (!root) return;

            // Build list of all directories in the workspace.
            const allFiles = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}');
            const dirSet = new Set<string>([root.uri.fsPath]);
            for (const f of allFiles) {
                let d = path.dirname(f.fsPath);
                while (d.startsWith(root.uri.fsPath) && !dirSet.has(d)) {
                    dirSet.add(d);
                    if (d === root.uri.fsPath) break;
                    d = path.dirname(d);
                }
            }
            // Exclude the node's own subtree if it's a folder.
            const items = [...dirSet]
                .filter((d) => !node.isDirectory || !(d === node.uri.fsPath || d.startsWith(node.uri.fsPath + path.sep)))
                .filter((d) => d !== path.dirname(node.uri.fsPath))
                .sort()
                .map((d) => ({
                    label: vscode.workspace.asRelativePath(d, false) || '.',
                    description: d === root.uri.fsPath ? '(workspace root)' : '',
                    fsPath: d,
                }));

            if (items.length === 0) {
                vscode.window.showInformationMessage('No other folders available.');
                return;
            }
            const pick = await vscode.window.showQuickPick(items, { placeHolder: `Move '${path.basename(node.uri.fsPath)}' to…` });
            if (!pick) return;
            const target = vscode.Uri.joinPath(vscode.Uri.file(pick.fsPath), path.basename(node.uri.fsPath));
            if (await pathExists(target)) {
                vscode.window.showErrorMessage(`'${path.basename(target.fsPath)}' already exists in the destination.`);
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.renameFile(node.uri, target, { overwrite: false });
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) vscode.window.showErrorMessage('Move failed.');
            provider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.delete', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (!requireNode(node)) return;
            const name = path.basename(node.uri.fsPath);
            const choice = await vscode.window.showWarningMessage(
                `Move '${name}' to the Trash?`,
                { modal: true },
                'Move to Trash',
            );
            if (choice !== 'Move to Trash') return;
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(node.uri, { recursive: true, ignoreIfNotExists: true });
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) vscode.window.showErrorMessage('Delete failed.');
            provider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.duplicate', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            if (!requireNode(node)) return;
            try {
                const dest = await findFreeDuplicateName(node.uri);
                await vscode.workspace.fs.copy(node.uri, dest, { overwrite: false });
            } catch (e: any) {
                vscode.window.showErrorMessage(`Duplicate failed: ${e.message ?? e}`);
            }
            provider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.newFile', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            const parent = folderTarget(node);
            if (!parent) return;
            const name = await vscode.window.showInputBox({ prompt: 'New file name' });
            if (!name) return;
            const target = vscode.Uri.joinPath(vscode.Uri.file(parent), name);
            if (await pathExists(target)) {
                vscode.window.showErrorMessage('A file with that name already exists.');
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(target, { ignoreIfExists: false });
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) {
                vscode.window.showErrorMessage('Create file failed.');
                return;
            }
            await vscode.commands.executeCommand('vscode.open', target);
            provider.refresh();
        }),
        vscode.commands.registerCommand('workspaceExplorer.newFolder', async (node?: FileNode) => {
            node = coerceToFileNode(node) ?? node;
            const parent = folderTarget(node);
            if (!parent) return;
            const name = await vscode.window.showInputBox({ prompt: 'New folder name' });
            if (!name) return;
            const target = vscode.Uri.joinPath(vscode.Uri.file(parent), name);
            try {
                if (await pathExists(target)) {
                    vscode.window.showErrorMessage('A folder with that name already exists.');
                    return;
                }
                await vscode.workspace.fs.createDirectory(target);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Create folder failed: ${e.message ?? e}`);
            }
            provider.refresh();
        }),
    );

    // Content changes only need a tree refresh (mtime-based sort) — never a decoration refresh.
    const debouncedTreeRefresh = debounce(() => provider.refreshTree(), 400);
    // Create/delete can change structure; still debounced.
    const debouncedStructureRefresh = debounce(() => provider.refreshTree(), 250);

    // Keep the collection-preview board in sync with the filesystem. A
    // rename/delete/move/duplicate/new — from the card context menu, the tree
    // menu, drag-drop, or an external tool — surfaces here as create/delete
    // events, so re-render the board (no-op when it's closed).
    const debouncedPreviewRefresh = debounce(() => { void CollectionPreviewPanel.refresh(); }, 250);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => { debouncedStructureRefresh(); debouncedPreviewRefresh(); });
    watcher.onDidDelete(() => { debouncedStructureRefresh(); debouncedPreviewRefresh(); });
    // Content edits only affect ordering when an mtime-based sort is active. Skipping
    // the refresh otherwise avoids invalidating tree rows on every keystroke, which
    // made colored labels/icons flash to their default (white) color mid-repaint.
    watcher.onDidChange(() => { if (provider.hasEditedSort()) debouncedTreeRefresh(); });
    context.subscriptions.push(watcher);
}

export function deactivate() {}
