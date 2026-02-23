import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Task } from './models';
import { TaskManager } from './TaskManager';
import { ConfigManager } from './ConfigManager';

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TaskNode | undefined | void> = new vscode.EventEmitter<TaskNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TaskNode | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TaskNode): Promise<TaskNode[]> {
        if (!element) {
            const tasks = TaskManager.getTasks();
            if (tasks.length === 0) {
                return [];
            }
            return tasks.map(t => new TaskGroupNode(t));
        } else if (element instanceof TaskGroupNode) {
            const task = element.task;
            const children: TaskNode[] = [];

            if (task.isSplit) {
                const defaultDir = ConfigManager.getDefaultDirectory();
                if (defaultDir) {
                    const ext = path.extname(task.originalVideoPath);
                    const baseName = path.basename(task.originalVideoPath, ext);
                    const outputDir = path.join(defaultDir, `${baseName}_splits`);
                    if (fs.existsSync(outputDir)) {
                        children.push(new FileNode('Output Artifacts', outputDir, vscode.TreeItemCollapsibleState.Expanded));
                    }
                }
            }
            return children;
        } else if (element instanceof FileNode && element.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
            const children: TaskNode[] = [];
            if (fs.existsSync(element.filePath) && fs.statSync(element.filePath).isDirectory()) {
                const items = fs.readdirSync(element.filePath);
                for (const item of items) {
                    const fullPath = path.join(element.filePath, item);
                    const isDir = fs.statSync(fullPath).isDirectory();
                    children.push(new FileNode(item, fullPath, isDir ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None));
                }
            }
            return children;
        }

        return [];
    }
}

export abstract class TaskNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}

export class TaskGroupNode extends TaskNode {
    constructor(public readonly task: Task) {
        super(task.name || task.id, task.isSplit ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        // Command to open webview directly when clicked
        this.command = {
            command: 'blackFrameDetector.openWebview',
            title: 'Open Webview',
            arguments: [this]
        };
        this.contextValue = 'taskGroup';
        this.iconPath = new vscode.ThemeIcon('device-camera-video');
        this.tooltip = `Task Created: ${new Date(task.createdAt).toLocaleString()}`;
        if (task.isSplit) {
            this.iconPath = new vscode.ThemeIcon('check-all');
            this.description = 'Split Complete';
        }
    }
}

export class FileNode extends TaskNode {
    constructor(
        label: string,
        public readonly filePath: string,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = 'fileNode_canReveal';
        this.tooltip = filePath;

        if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
            this.iconPath = new vscode.ThemeIcon('file-media');
            if (filePath.endsWith('.mp4') || filePath.endsWith('.mov') || filePath.endsWith('.avi')) {
                this.iconPath = new vscode.ThemeIcon('device-camera-video');
            } else if (filePath.endsWith('.json')) {
                this.iconPath = new vscode.ThemeIcon('json');
            } else {
                this.iconPath = new vscode.ThemeIcon('file');
            }
        } else {
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}
