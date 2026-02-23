import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Task, CutPoint } from './models';
import { ConfigManager } from './ConfigManager';

interface PersistentTaskState {
    task: Task;
    cutPoints: CutPoint[];
}

export class TaskManager {
    public static getTasks(): Task[] {
        const defaultDir = ConfigManager.getDefaultDirectory();
        if (!defaultDir || !fs.existsSync(defaultDir)) { return []; }

        const tasks: Task[] = [];
        try {
            const items = fs.readdirSync(defaultDir);
            for (const item of items) {
                const itemPath = path.join(defaultDir, item);
                if (fs.statSync(itemPath).isDirectory()) {
                    const taskJsonPath = path.join(itemPath, 'task.json');
                    if (fs.existsSync(taskJsonPath)) {
                        try {
                            const content = fs.readFileSync(taskJsonPath, 'utf8');
                            const state: PersistentTaskState = JSON.parse(content);
                            if (state && state.task) {
                                tasks.push(state.task);
                            }
                        } catch (e) {
                            console.error(`Failed to parse task state at ${taskJsonPath}`, e);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to read default directory', e);
        }

        return tasks.sort((a, b) => b.createdAt - a.createdAt);
    }

    private static saveState(task: Task, cutPoints: CutPoint[]) {
        if (!task.taskFolderPath) { return; }
        if (!fs.existsSync(task.taskFolderPath)) {
            fs.mkdirSync(task.taskFolderPath, { recursive: true });
        }
        const state: PersistentTaskState = { task, cutPoints };
        const taskJsonPath = path.join(task.taskFolderPath, 'task.json');
        fs.writeFileSync(taskJsonPath, JSON.stringify(state, null, 2), 'utf8');
    }

    public static createTask(videoPath: string): Task {
        const defaultDir = ConfigManager.getDefaultDirectory();
        if (!defaultDir) { throw new Error("Default directory not configured"); }

        const tasks = this.getTasks();
        const baseName = path.basename(videoPath);
        const hash = Buffer.from(videoPath).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 8);
        const dirName = `${path.basename(videoPath, path.extname(videoPath))}_${hash}`;
        const taskFolderPath = path.join(defaultDir, dirName);

        let task = tasks.find(t => t.originalVideoPath === videoPath);
        if (!task) {
            task = {
                id: hash,
                name: baseName,
                originalVideoPath: videoPath,
                taskFolderPath: taskFolderPath,
                createdAt: Date.now(),
                isSplit: false
            };
            this.saveState(task, []);
        }
        return task;
    }

    public static updateTask(task: Task) {
        // Read existing cut points to preserve them
        const cutPoints = this.getCutPoints(task);
        this.saveState(task, cutPoints);
    }

    public static removeTask(task: Task) {
        if (task.taskFolderPath && fs.existsSync(task.taskFolderPath)) {
            fs.rmSync(task.taskFolderPath, { recursive: true, force: true });
        }
    }

    public static getCutPoints(task: Task): CutPoint[] {
        if (!task.taskFolderPath) { return []; }
        const taskJsonPath = path.join(task.taskFolderPath, 'task.json');
        if (fs.existsSync(taskJsonPath)) {
            try {
                const content = fs.readFileSync(taskJsonPath, 'utf8');
                const state: PersistentTaskState = JSON.parse(content);
                return state.cutPoints || [];
            } catch (e) {
                console.error(`Failed to load cut points for ${task.id}`, e);
            }
        }
        return [];
    }

    public static saveCutPoints(task: Task, cutPoints: CutPoint[]) {
        this.saveState(task, cutPoints);
    }
}
