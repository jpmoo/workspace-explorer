import * as vscode from 'vscode';
import * as path from 'path';

type SortMode = 'nameAsc' | 'nameDesc' | 'editedAsc' | 'editedDesc';
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

const DEFAULT_SORT: SortMode = 'nameAsc';
const SORTS_KEY = 'workspaceExplorer.sorts';
const PINNED_FOLDER_KEY = 'workspaceExplorer.pinnedInFolder';
const PINNED_TOP_KEY = 'workspaceExplorer.pinnedTop';
const HIDDEN_KEY = 'workspaceExplorer.hidden';
const SHOW_HIDDEN_KEY = 'workspaceExplorer.showHidden';
const EXPAND_ALL_KEY = 'workspaceExplorer.expandAll';
const ICON_COLOR_KEY = 'workspaceExplorer.iconColor';   // folderPath -> Swatch
const TEXT_COLOR_KEY = 'workspaceExplorer.textColor';   // folderPath -> Swatch (inherited)
const FOLDER_ORDER_KEY = 'workspaceExplorer.folderOrder'; // parentPath -> ordered child folder names
const EXPANDED_FOLDERS_KEY = 'workspaceExplorer.expandedFolders'; // string[] of expanded folder paths
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

class WorkspaceExplorerProvider implements vscode.TreeDataProvider<FileNode>, vscode.FileDecorationProvider, vscode.TreeDragAndDropController<FileNode> {
    readonly dragMimeTypes = [DND_MIME];
    readonly dropMimeTypes = [DND_MIME];

    handleDrag(source: readonly FileNode[], data: vscode.DataTransfer): void {
        // Only allow folder drags (we reorder folders within their parent).
        const folders = source.filter((n) => n.isDirectory).map((n) => n.uri.fsPath);
        if (folders.length === 0) return;
        data.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(folders)));
    }

    async handleDrop(target: FileNode | undefined, data: vscode.DataTransfer): Promise<void> {
        const item = data.get(DND_MIME);
        if (!item) return;
        let payload: string[];
        try { payload = JSON.parse(await item.asString()); } catch { return; }
        if (!Array.isArray(payload) || payload.length === 0) return;

        // All dragged folders must share a parent for reordering to make sense.
        const parents = new Set(payload.map((p) => path.dirname(p)));
        if (parents.size !== 1) {
            vscode.window.showWarningMessage('Workspace Explorer: can only reorder folders that share the same parent.');
            return;
        }
        const sourceParent = [...parents][0];

        // Determine drop parent: dropping on a folder = drop inside it; dropping on a file = into its folder; undefined = workspace root.
        let dropParent: string;
        let beforeName: string | undefined;
        if (!target) {
            dropParent = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        } else if (target.isDirectory) {
            // If target folder is a sibling of source, treat as "insert before this sibling".
            if (path.dirname(target.uri.fsPath) === sourceParent) {
                dropParent = sourceParent;
                beforeName = path.basename(target.uri.fsPath);
            } else {
                // Otherwise interpret as "drop inside this folder" — but we don't support cross-parent moves yet.
                vscode.window.showWarningMessage('Workspace Explorer: drag-and-drop only reorders folders within the same parent (filesystem moves are not yet supported).');
                return;
            }
        } else {
            // Dropped on a file: place at the end of that file's folder.
            dropParent = path.dirname(target.uri.fsPath);
            if (dropParent !== sourceParent) {
                vscode.window.showWarningMessage('Workspace Explorer: drag-and-drop only reorders folders within the same parent.');
                return;
            }
        }
        if (dropParent !== sourceParent) return;

        await this.reorderFolders(sourceParent, payload.map((p) => path.basename(p)), beforeName);
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

    refresh(): void {
        this._onDidChangeTreeData.fire();
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
            return [...pinnedFileNodes, ...filtered];
        }

        if (element.isDirectory) return this.readDir(element.uri);
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

        return [...folderPinned.map(toNode), ...dirs.map(toNode), ...regular.map(toNode)];
    }

    // ---- persistence: sort ----
    getSortMode(folderPath: string): SortMode {
        return (this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {}))[folderPath] ?? DEFAULT_SORT;
    }
    async setSortMode(folderPath: string, mode: SortMode): Promise<void> {
        const sorts = this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {});
        sorts[folderPath] = mode;
        await this.context.workspaceState.update(SORTS_KEY, sorts);
        this.refresh();
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
        this.refresh();
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

    async getChildren(e?: TagNode): Promise<TagNode[]> {
        if (!e) {
            if (this.tagMap.size === 0) await this.scan();
            const needle = this.filter.trim().toLowerCase();
            return [...this.tagMap.entries()]
                .filter(([tag]) => !needle || tag.toLowerCase().includes(needle))
                .sort((a, b) => a[0].localeCompare(b[0]))
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

    const tagsProvider = new TagsProvider();
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

    // Refresh tags/orphans when workspace files change.
    const aux = vscode.workspace.createFileSystemWatcher('**/*');
    aux.onDidCreate(() => { tagsProvider.refresh(); orphansProvider.refresh(); recentProvider.refresh(); });
    aux.onDidChange(() => { tagsProvider.refresh(); orphansProvider.refresh(); recentProvider.refresh(); });
    aux.onDidDelete(() => { tagsProvider.refresh(); orphansProvider.refresh(); recentProvider.refresh(); });
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
            if (requireNode(node) && !node.isDirectory) return provider.pinInFolder(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.pinToTop', (node?: FileNode) => {
            if (requireNode(node) && !node.isDirectory) return provider.pinToTop(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.unpin', (node?: FileNode) => {
            if (requireNode(node) && !node.isDirectory) return provider.unpin(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.hide', (node?: FileNode) => {
            if (requireNode(node)) return provider.hide(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.unhide', (node?: FileNode) => {
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
            if (requireNode(node)) return vscode.commands.executeCommand('revealFileInOS', node.uri);
        }),
        vscode.commands.registerCommand('workspaceExplorer.openInTerminal', (node?: FileNode) => {
            if (requireNode(node)) return vscode.commands.executeCommand('openInIntegratedTerminal', node.uri);
        }),
        vscode.commands.registerCommand('workspaceExplorer.copyPath', async (node?: FileNode) => {
            if (requireNode(node)) await vscode.env.clipboard.writeText(node.uri.fsPath);
        }),
        vscode.commands.registerCommand('workspaceExplorer.copyRelativePath', async (node?: FileNode) => {
            if (requireNode(node)) {
                const rel = vscode.workspace.asRelativePath(node.uri, false);
                await vscode.env.clipboard.writeText(rel);
            }
        }),
        vscode.commands.registerCommand('workspaceExplorer.openToSide', async (node?: FileNode) => {
            if (requireNode(node) && !node.isDirectory) {
                await vscode.commands.executeCommand('vscode.open', node.uri, { viewColumn: vscode.ViewColumn.Beside });
            }
        }),
    );

    // File ops.
    context.subscriptions.push(
        vscode.commands.registerCommand('workspaceExplorer.rename', async (node?: FileNode) => {
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

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    watcher.onDidChange(() => provider.refresh());
    context.subscriptions.push(watcher);
}

export function deactivate() {}
