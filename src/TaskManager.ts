import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Task, CutPoint } from './models';
import { ConfigManager } from './ConfigManager';
import { SegmentOutput, getAnalysisDir, getCutPointsFile, getDetectedCutPointsFile, getPreviewsDir } from './taskPaths';

interface PersistentTaskState {
    task: Task;
    cutPoints?: CutPoint[];
    detectedCutPoints?: CutPoint[];
    analysis?: {
        cutPointsFile?: string;
        detectedCutPointsFile?: string;
        previewsDir?: string;
    };
    outputs?: {
        segments?: SegmentOutput[];
    };
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

    private static ensureAnalysisDirectory(task: Task) {
        const analysisDir = getAnalysisDir(task);
        if (!fs.existsSync(analysisDir)) {
            fs.mkdirSync(analysisDir, { recursive: true });
        }
    }

    private static readState(task: Task): PersistentTaskState | undefined {
        const taskJsonPath = path.join(task.taskFolderPath, 'task.json');
        if (!fs.existsSync(taskJsonPath)) {
            return undefined;
        }

        try {
            const content = fs.readFileSync(taskJsonPath, 'utf8');
            return JSON.parse(content) as PersistentTaskState;
        } catch (e) {
            console.error(`Failed to read task.json for ${task.id}`, e);
            return undefined;
        }
    }

    private static writeJsonFile(filePath: string, content: unknown) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
    }

    private static readCutPointsFile(filePath: string): CutPoint[] {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error(`Failed to read cut points file at ${filePath}`, e);
            return [];
        }
    }

    private static saveState(task: Task, cutPoints: CutPoint[]) {
        if (!task.taskFolderPath) { return; }
        if (!fs.existsSync(task.taskFolderPath)) {
            fs.mkdirSync(task.taskFolderPath, { recursive: true });
        }
        this.ensureAnalysisDirectory(task);

        const existing = this.readState(task);
        const state: PersistentTaskState = {
            task,
            analysis: {
                cutPointsFile: path.relative(task.taskFolderPath, getCutPointsFile(task)),
                detectedCutPointsFile: path.relative(task.taskFolderPath, getDetectedCutPointsFile(task)),
                previewsDir: path.relative(task.taskFolderPath, getPreviewsDir(task))
            },
            outputs: existing?.outputs
        };

        if (cutPoints.length > 0) {
            this.writeJsonFile(getCutPointsFile(task), cutPoints);
        } else if (!fs.existsSync(getCutPointsFile(task))) {
            this.writeJsonFile(getCutPointsFile(task), []);
        }

        fs.writeFileSync(path.join(task.taskFolderPath, 'task.json'), JSON.stringify(state, null, 2), 'utf8');
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
        const state = this.readState(task);
        if (!state) {
            return [];
        }

        const cutPointsFile = state.analysis?.cutPointsFile
            ? path.join(task.taskFolderPath, state.analysis.cutPointsFile)
            : getCutPointsFile(task);

        if (fs.existsSync(cutPointsFile)) {
            return this.readCutPointsFile(cutPointsFile);
        }

        return state.cutPoints || [];
    }

    public static saveCutPoints(task: Task, cutPoints: CutPoint[]) {
        // Save current cut points and ensure detectedCutPoints is stored in task.json on first save
        this.saveState(task, cutPoints);
    }

    public static saveDetectedCutPoints(task: Task, cutPoints: CutPoint[], overwrite: boolean = false) {
        if (!task.taskFolderPath) { return; }
        try {
            this.ensureAnalysisDirectory(task);
            const state = this.readState(task) || { task };
            const targetFile = state.analysis?.detectedCutPointsFile
                ? path.join(task.taskFolderPath, state.analysis.detectedCutPointsFile)
                : getDetectedCutPointsFile(task);

            const hasExistingFile = fs.existsSync(targetFile) && this.readCutPointsFile(targetFile).length > 0;
            const hasLegacyEmbedded = Array.isArray(state.detectedCutPoints) && state.detectedCutPoints.length > 0;

            if (overwrite || (!hasExistingFile && !hasLegacyEmbedded)) {
                this.writeJsonFile(targetFile, cutPoints);
                this.saveState(task, this.getCutPoints(task));
            }
        } catch (e) {
            console.error('Failed to save detected cut points into task.json', e);
        }
    }

    public static getDetectedCutPoints(task: Task): CutPoint[] {
        if (!task.taskFolderPath) { return []; }
        const state = this.readState(task);
        if (!state) {
            return [];
        }

        const detectedFile = state.analysis?.detectedCutPointsFile
            ? path.join(task.taskFolderPath, state.analysis.detectedCutPointsFile)
            : getDetectedCutPointsFile(task);

        if (fs.existsSync(detectedFile)) {
            return this.readCutPointsFile(detectedFile);
        }

        return state.detectedCutPoints || [];
    }

    public static saveSplitOutputs(task: Task, segments: SegmentOutput[]) {
        const state = this.readState(task) || { task };
        state.task = task;
        state.analysis = {
            cutPointsFile: path.relative(task.taskFolderPath, getCutPointsFile(task)),
            detectedCutPointsFile: path.relative(task.taskFolderPath, getDetectedCutPointsFile(task)),
            previewsDir: path.relative(task.taskFolderPath, getPreviewsDir(task))
        };
        state.outputs = { segments };
        fs.writeFileSync(path.join(task.taskFolderPath, 'task.json'), JSON.stringify(state, null, 2), 'utf8');
    }

    public static getSplitOutputs(task: Task): SegmentOutput[] {
        const state = this.readState(task);
        return state?.outputs?.segments || [];
    }
}
