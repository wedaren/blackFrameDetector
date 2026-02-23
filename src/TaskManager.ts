import * as vscode from 'vscode';
import * as path from 'path';
import { Task, CutPoint } from './models';

export class TaskManager {
    public static STATE_KEY_TASKS = 'blackFrameDetector.tasks';
    public static STATE_KEY_CUTPOINTS_PREFIX = 'blackFrameDetector.cutpoints.';

    private static _context: vscode.ExtensionContext;

    public static initialize(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public static getTasks(): Task[] {
        if (!this._context) { return []; }
        const tasks = this._context.globalState.get<Task[]>(this.STATE_KEY_TASKS) || [];
        return tasks.sort((a, b) => b.createdAt - a.createdAt);
    }

    public static saveTasks(tasks: Task[]) {
        if (!this._context) { return; }
        this._context.globalState.update(this.STATE_KEY_TASKS, tasks);
    }

    public static createTask(videoPath: string): Task {
        const tasks = this.getTasks();
        const baseName = path.basename(videoPath);

        let task = tasks.find(t => t.originalVideoPath === videoPath);
        if (!task) {
            task = {
                id: Buffer.from(videoPath).toString('base64'),
                name: baseName,
                originalVideoPath: videoPath,
                createdAt: Date.now(),
                isSplit: false
            };
            tasks.push(task);
            this.saveTasks(tasks);
        }
        return task;
    }

    public static updateTask(task: Task) {
        let tasks = this.getTasks();
        const idx = tasks.findIndex(t => t.id === task.id);
        if (idx > -1) {
            tasks[idx] = task;
            this.saveTasks(tasks);
        }
    }

    public static removeTask(taskId: string) {
        let tasks = this.getTasks();
        tasks = tasks.filter(t => t.id !== taskId);
        this.saveTasks(tasks);
        this._context.globalState.update(`${this.STATE_KEY_CUTPOINTS_PREFIX}${taskId}`, undefined);
    }

    public static getCutPoints(taskId: string): CutPoint[] {
        if (!this._context) { return []; }
        return this._context.globalState.get<CutPoint[]>(`${this.STATE_KEY_CUTPOINTS_PREFIX}${taskId}`) || [];
    }

    public static saveCutPoints(taskId: string, cutPoints: CutPoint[]) {
        if (!this._context) { return; }
        this._context.globalState.update(`${this.STATE_KEY_CUTPOINTS_PREFIX}${taskId}`, cutPoints);
    }
}
