import * as vscode from 'vscode';
import * as path from 'path';

type SortMode = 'nameAsc' | 'nameDesc' | 'editedAsc' | 'editedDesc';

const DEFAULT_SORT: SortMode = 'nameAsc';
const SORTS_KEY = 'workspaceExplorer.sorts';
const PINNED_FOLDER_KEY = 'workspaceExplorer.pinnedInFolder';
const PINNED_TOP_KEY = 'workspaceExplorer.pinnedTop';

class FileNode extends vscode.TreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly isDirectory: boolean,
        public readonly parentDir: string | undefined,
        pinned: 'folder' | 'top' | null,
    ) {
        super(
            uri,
            isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
        );
        this.resourceUri = uri;
        this.label = path.basename(uri.fsPath);
        if (isDirectory) {
            this.contextValue = 'folder';
        } else {
            this.contextValue = pinned ? 'pinnedFile' : 'file';
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [uri],
            };
        }
        if (pinned) {
            this.description = pinned === 'top' ? '📌 top' : '📌';
        }
    }
}

class WorkspaceExplorerProvider implements vscode.TreeDataProvider<FileNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: FileNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: FileNode): Promise<FileNode[]> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return [];
        }

        if (!element) {
            // Root: list contents of first workspace folder, with top-pinned files lifted to the very top.
            const root = folders[0].uri;
            const children = await this.readDir(root);
            const topPins = this.getPinnedTop();
            const pinnedFileNodes: FileNode[] = [];
            for (const pinPath of topPins) {
                try {
                    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(pinPath));
                    if (stat.type === vscode.FileType.File) {
                        pinnedFileNodes.push(
                            new FileNode(
                                vscode.Uri.file(pinPath),
                                false,
                                path.dirname(pinPath),
                                'top',
                            ),
                        );
                    }
                } catch {
                    // missing; skip
                }
            }
            const filtered = children.filter(
                (c) => !(!c.isDirectory && topPins.includes(c.uri.fsPath)),
            );
            return [...pinnedFileNodes, ...filtered];
        }

        if (element.isDirectory) {
            return this.readDir(element.uri);
        }
        return [];
    }

    private async readDir(dir: vscode.Uri): Promise<FileNode[]> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dir);
        } catch {
            return [];
        }

        const sortMode = this.getSortMode(dir.fsPath);
        const topPins = new Set(this.getPinnedTop());
        const folderPins = new Set(this.getPinnedInFolder(dir.fsPath));

        // Gather stat info for edited sorts.
        const items = await Promise.all(
            entries.map(async ([name, type]) => {
                const childUri = vscode.Uri.joinPath(dir, name);
                let mtime = 0;
                if (sortMode === 'editedAsc' || sortMode === 'editedDesc') {
                    try {
                        const s = await vscode.workspace.fs.stat(childUri);
                        mtime = s.mtime;
                    } catch {
                        mtime = 0;
                    }
                }
                return { name, type, uri: childUri, mtime };
            }),
        );

        const dirs = items.filter((i) => i.type === vscode.FileType.Directory);
        const files = items.filter((i) => i.type !== vscode.FileType.Directory);

        const cmp = (a: typeof items[number], b: typeof items[number]) => {
            switch (sortMode) {
                case 'nameDesc':
                    return b.name.localeCompare(a.name);
                case 'editedAsc':
                    return a.mtime - b.mtime;
                case 'editedDesc':
                    return b.mtime - a.mtime;
                case 'nameAsc':
                default:
                    return a.name.localeCompare(b.name);
            }
        };

        dirs.sort(cmp);
        files.sort(cmp);

        // Split files into pinned-to-this-folder vs not, but exclude any pinned to top of list (those appear at root).
        const folderPinned: typeof files = [];
        const regular: typeof files = [];
        for (const f of files) {
            if (topPins.has(f.uri.fsPath)) {
                continue;
            }
            if (folderPins.has(f.uri.fsPath)) {
                folderPinned.push(f);
            } else {
                regular.push(f);
            }
        }

        const toNode = (i: typeof items[number]): FileNode => {
            const isDir = i.type === vscode.FileType.Directory;
            const pinned: 'folder' | 'top' | null = isDir
                ? null
                : topPins.has(i.uri.fsPath)
                    ? 'top'
                    : folderPins.has(i.uri.fsPath)
                        ? 'folder'
                        : null;
            return new FileNode(i.uri, isDir, dir.fsPath, pinned);
        };

        return [...folderPinned.map(toNode), ...dirs.map(toNode), ...regular.map(toNode)];
    }

    // ---- persistence ----

    getSortMode(folderPath: string): SortMode {
        const sorts = this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {});
        return sorts[folderPath] ?? DEFAULT_SORT;
    }

    async setSortMode(folderPath: string, mode: SortMode): Promise<void> {
        const sorts = this.context.workspaceState.get<Record<string, SortMode>>(SORTS_KEY, {});
        sorts[folderPath] = mode;
        await this.context.workspaceState.update(SORTS_KEY, sorts);
        this.refresh();
    }

    getPinnedInFolder(folderPath: string): string[] {
        const all = this.context.workspaceState.get<Record<string, string[]>>(PINNED_FOLDER_KEY, {});
        return all[folderPath] ?? [];
    }

    async pinInFolder(filePath: string): Promise<void> {
        const folderPath = path.dirname(filePath);
        const all = this.context.workspaceState.get<Record<string, string[]>>(PINNED_FOLDER_KEY, {});
        const list = new Set(all[folderPath] ?? []);
        list.add(filePath);
        all[folderPath] = [...list];
        await this.context.workspaceState.update(PINNED_FOLDER_KEY, all);
        // Also ensure not in top pins.
        await this.removeFromTopPins(filePath);
        this.refresh();
    }

    getPinnedTop(): string[] {
        return this.context.workspaceState.get<string[]>(PINNED_TOP_KEY, []);
    }

    async pinToTop(filePath: string): Promise<void> {
        const list = new Set(this.getPinnedTop());
        list.add(filePath);
        await this.context.workspaceState.update(PINNED_TOP_KEY, [...list]);
        // Remove folder pin if any.
        await this.removeFromFolderPins(filePath);
        this.refresh();
    }

    async unpin(filePath: string): Promise<void> {
        await this.removeFromTopPins(filePath);
        await this.removeFromFolderPins(filePath);
        this.refresh();
    }

    private async removeFromTopPins(filePath: string): Promise<void> {
        const list = this.getPinnedTop().filter((p) => p !== filePath);
        await this.context.workspaceState.update(PINNED_TOP_KEY, list);
    }

    private async removeFromFolderPins(filePath: string): Promise<void> {
        const folderPath = path.dirname(filePath);
        const all = this.context.workspaceState.get<Record<string, string[]>>(PINNED_FOLDER_KEY, {});
        if (all[folderPath]) {
            all[folderPath] = all[folderPath].filter((p) => p !== filePath);
            if (all[folderPath].length === 0) {
                delete all[folderPath];
            }
            await this.context.workspaceState.update(PINNED_FOLDER_KEY, all);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new WorkspaceExplorerProvider(context);
    const view = vscode.window.createTreeView('workspaceExplorer.tree', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(view);

    const setSort = (mode: SortMode) => async (node?: FileNode) => {
        const folderPath = node?.isDirectory
            ? node.uri.fsPath
            : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!folderPath) {
            return;
        }
        await provider.setSortMode(folderPath, mode);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('workspaceExplorer.refresh', () => provider.refresh()),
        vscode.commands.registerCommand('workspaceExplorer.sortNameAsc', setSort('nameAsc')),
        vscode.commands.registerCommand('workspaceExplorer.sortNameDesc', setSort('nameDesc')),
        vscode.commands.registerCommand('workspaceExplorer.sortEditedAsc', setSort('editedAsc')),
        vscode.commands.registerCommand('workspaceExplorer.sortEditedDesc', setSort('editedDesc')),
        vscode.commands.registerCommand('workspaceExplorer.pinToFolder', (node: FileNode) => {
            if (node && !node.isDirectory) {
                return provider.pinInFolder(node.uri.fsPath);
            }
        }),
        vscode.commands.registerCommand('workspaceExplorer.pinToTop', (node: FileNode) => {
            if (node && !node.isDirectory) {
                return provider.pinToTop(node.uri.fsPath);
            }
        }),
        vscode.commands.registerCommand('workspaceExplorer.unpin', (node: FileNode) => {
            if (node && !node.isDirectory) {
                return provider.unpin(node.uri.fsPath);
            }
        }),
    );

    // Refresh on filesystem changes.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    watcher.onDidChange(() => provider.refresh());
    context.subscriptions.push(watcher);
}

export function deactivate() {}
