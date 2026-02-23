import * as vscode from 'vscode';
import { TaskTreeProvider, FileNode, TaskGroupNode } from './TaskTreeProvider';
import { TaskManager } from './TaskManager';
import { ConfigManager } from './ConfigManager';
import { CutPointWebview } from './CutPointWebview';
import { FFmpegService } from './ffmpegService';
import { CutPoint } from './models';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "black-frame-detector" is now active!');
    TaskManager.initialize(context);

    const treeProvider = new TaskTreeProvider();
    vscode.window.registerTreeDataProvider('blackFrameDetector.tasksView', treeProvider);

    let createDisposable = vscode.commands.registerCommand('blackFrameDetector.createTask', async () => {
        let defaultDir = ConfigManager.getDefaultDirectory();
        if (!defaultDir) {
            const result = await vscode.window.showInformationMessage('Please configure a default output directory first.', 'Configure');
            if (result === 'Configure') {
                defaultDir = await ConfigManager.promptForDefaultDirectory();
                if (!defaultDir) { return; }
            } else {
                return;
            }
        }

        const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select Local Video',
            filters: { 'Videos': ['mp4', 'mov', 'avi', 'mkv'] }
        });

        if (selected && selected.length > 0) {
            const videoPath = selected[0].fsPath;
            const task = TaskManager.createTask(videoPath);
            treeProvider.refresh();

            // Immediately open processing
            vscode.commands.executeCommand('blackFrameDetector.openWebview', new TaskGroupNode(task));
        }
    });

    let openWebviewDisposable = vscode.commands.registerCommand('blackFrameDetector.openWebview', async (node: TaskGroupNode) => {
        if (!node || !node.task) return;
        const task = node.task;

        let cutPoints: CutPoint[] = TaskManager.getCutPoints(task.id);

        if (cutPoints.length === 0 && !task.isSplit) {
            // First time detecting
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Detecting black frames for ${task.name}...`,
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: 'Running FFmpeg blackdetect (this might take a while)...' });
                    cutPoints = await FFmpegService.detectBlackFrames(task.originalVideoPath);
                    progress.report({ message: 'Extracting preview images...' });
                    const previewDir = path.join(context.globalStorageUri.fsPath, task.id);
                    if (!fs.existsSync(previewDir)) { fs.mkdirSync(previewDir, { recursive: true }); }
                    await FFmpegService.generatePreviewsForCutPoints(task.originalVideoPath, cutPoints, previewDir);
                    TaskManager.saveCutPoints(task.id, cutPoints);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`FFmpeg detection failed: ${e.message}`);
                }
            });
        }

        CutPointWebview.createOrShow(task, cutPoints, treeProvider, context.globalStorageUri.fsPath);
    });

    let manageDisposable = vscode.commands.registerCommand('blackFrameDetector.manageCutPoints', (node: TaskGroupNode) => {
        vscode.commands.executeCommand('blackFrameDetector.openWebview', node);
    });

    let revealDisposable = vscode.commands.registerCommand('blackFrameDetector.revealInFinder', (node: FileNode) => {
        if (node && node.filePath) {
            vscode.env.openExternal(vscode.Uri.file(node.filePath));
        }
    });

    let settingsDisposable = vscode.commands.registerCommand('blackFrameDetector.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'blackFrameDetector.defaultDirectory');
    });

    context.subscriptions.push(createDisposable, revealDisposable, settingsDisposable, manageDisposable, openWebviewDisposable);
}

export function deactivate() { }
