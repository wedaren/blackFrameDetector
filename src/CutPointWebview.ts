import * as vscode from 'vscode';
import * as path from 'path';
import { Task, CutPoint } from './models';
import { FFmpegService } from './ffmpegService';
import * as fs from 'fs';
import { TaskTreeProvider } from './TaskTreeProvider';
import { TaskManager } from './TaskManager';
import { ConfigManager } from './ConfigManager';

export class CutPointWebview {
    public static currentPanel: CutPointWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _task: Task;
    private _cutPoints: CutPoint[];

    private constructor(panel: vscode.WebviewPanel, task: Task, cutPoints: CutPoint[], private treeProvider: TaskTreeProvider, private storagePath: string) {
        this._panel = panel;
        this._task = task;
        this._cutPoints = cutPoints;

        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'updateCutPoint':
                        const cp = this._cutPoints.find(c => c.id === message.id);
                        if (cp) {
                            cp.time = message.time;
                            const previewDir = path.join(this.storagePath, this._task.id);
                            await FFmpegService.generatePreviewsForCutPoints(this._task.originalVideoPath, [cp], previewDir);
                            this._saveCutPoints();
                            this._update();
                        }
                        return;
                    case 'addCutPoint':
                        const newCp: CutPoint = {
                            id: `cp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                            time: message.time
                        };
                        this._cutPoints.push(newCp);
                        this._cutPoints.sort((a, b) => a.time - b.time);
                        const previewDirNew = path.join(this.storagePath, this._task.id);
                        await FFmpegService.generatePreviewsForCutPoints(this._task.originalVideoPath, [newCp], previewDirNew);
                        this._saveCutPoints();
                        this._update();
                        return;
                    case 'deleteCutPoint':
                        this._cutPoints = this._cutPoints.filter(c => c.id !== message.id);
                        this._saveCutPoints();
                        this._update();
                        return;
                    case 'confirmSplit':
                        const defaultDir = ConfigManager.getDefaultDirectory();
                        if (!defaultDir) {
                            vscode.window.showErrorMessage('No output directory configured.');
                            return;
                        }

                        vscode.window.showInformationMessage('Starting video splitting in background...');
                        try {
                            const ext = path.extname(this._task.originalVideoPath);
                            const baseName = path.basename(this._task.originalVideoPath, ext);
                            const outputDir = path.join(defaultDir, `${baseName}_splits`);
                            if (!fs.existsSync(outputDir)) {
                                fs.mkdirSync(outputDir, { recursive: true });
                            }
                            await FFmpegService.splitVideo(this._task.originalVideoPath, this._cutPoints, outputDir);

                            this._task.isSplit = true;
                            TaskManager.updateTask(this._task);
                            vscode.window.showInformationMessage(`Splitting complete! Saved to ${outputDir}`);
                            this.treeProvider.refresh();
                            this._panel.dispose();
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Failed to split video: ${e.message}`);
                        }
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _saveCutPoints() {
        TaskManager.saveCutPoints(this._task.id, this._cutPoints);
    }

    public static createOrShow(task: Task, cutPoints: CutPoint[], treeProvider: TaskTreeProvider, storagePath: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (CutPointWebview.currentPanel) {
            CutPointWebview.currentPanel._panel.reveal(column);
            CutPointWebview.currentPanel._task = task;
            CutPointWebview.currentPanel._cutPoints = cutPoints;
            CutPointWebview.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'blackFrameWebview',
            `Cut Points: ${task.name}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(storagePath)]
            }
        );

        CutPointWebview.currentPanel = new CutPointWebview(panel, task, cutPoints, treeProvider, storagePath);
    }

    public dispose() {
        CutPointWebview.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const cacheBuster = Date.now().toString();
        const mappedData = this._cutPoints.map(cp => {
            const beforeUri = cp.previewBefore && fs.existsSync(cp.previewBefore) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewBefore)).toString()}?t=${cacheBuster}` : '';
            const afterUri = cp.previewAfter && fs.existsSync(cp.previewAfter) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAfter)).toString()}?t=${cacheBuster}` : '';
            return {
                ...cp,
                beforeUri,
                afterUri
            };
        });

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cut Points Editor</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        .cut-point { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding: 20px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
        .previews { display: flex; gap: 15px; }
        .preview { display: flex; flex-direction: column; align-items: center; width: 240px; }
        .preview img { max-width: 100%; height: auto; border: 1px solid var(--vscode-widget-border); border-radius: 4px; background: #000; }
        .preview span { margin-top: 8px; font-size: 13px; color: var(--vscode-descriptionForeground); }
        .controls { display: flex; flex-direction: column; gap: 12px; min-width: 250px; }
        
        .time-adjuster { display: flex; align-items: center; gap: 5px; }
        .time-adjuster input { width: 80px; text-align: center; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; border-radius: 2px; }
        
        button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; padding: 6px 12px; cursor: pointer; border-radius: 2px; font-size: 13px; }
        button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        button.primary:hover { background: var(--vscode-button-hoverBackground); }
        button.danger { background: transparent; border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
        button.danger:hover { background: var(--vscode-errorForeground); color: white; }
        
        .btn-small { padding: 4px 8px; font-size: 12px; }
        
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 15px; }
        .header-actions { display: flex; gap: 15px; align-items: center; }
        #new-time { width: 80px; }
    </style>
</head>
<body>
    <div class="header">
        <h2>Refine Cut Points</h2>
        <div class="header-actions">
            <div>
                <input type="number" id="new-time" step="any" placeholder="Time (s)">
                <button onclick="addCutPoint()">+ Add Cut Point</button>
            </div>
            <button class="primary" onclick="confirmSplit()">Confirm and Split Video</button>
        </div>
    </div>
    <div id="cut-points-list">
        ${mappedData.length === 0 ? '<p>No cut points found. Add one manually.</p>' : ''}
        ${mappedData.map((cp, idx) => {
            const durationTxt = cp.duration ? `<div style="font-size: 12px; color: var(--vscode-descriptionForeground);">Detected Duration: ${cp.duration.toFixed(2)}s</div>` : '';
            const beforeImg = cp.beforeUri ? `<img src="${cp.beforeUri}" alt="Before">` : `<div style="height: 135px; width: 240px; display:flex; align-items:center; justify-content:center; border: 1px dashed var(--vscode-widget-border);">No Preview</div>`;
            const afterImg = cp.afterUri ? `<img src="${cp.afterUri}" alt="After">` : `<div style="height: 135px; width: 240px; display:flex; align-items:center; justify-content:center; border: 1px dashed var(--vscode-widget-border);">No Preview</div>`;

            return `
            <div class="cut-point">
                <div class="controls">
                    <div><strong>Cut #${idx + 1}</strong></div>
                    ${durationTxt}
                    
                    <div class="time-adjuster">
                        <button class="btn-small" onclick="adjustTime('${cp.id}', -0.5)">-0.5s</button>
                        <button class="btn-small" onclick="adjustTime('${cp.id}', -0.1)">-0.1s</button>
                        <input type="number" step="any" id="time-${cp.id}" value="${cp.time.toFixed(3)}" onchange="updateCutPoint('${cp.id}')">
                        <button class="btn-small" onclick="adjustTime('${cp.id}', 0.1)">+0.1s</button>
                        <button class="btn-small" onclick="adjustTime('${cp.id}', 0.5)">+0.5s</button>
                    </div>
                    
                    <div style="margin-top: 10px;">
                        <button class="danger btn-small" onclick="deleteCutPoint('${cp.id}')">Remove</button>
                    </div>
                </div>
                <div class="previews">
                    <div class="preview">
                        ${beforeImg}
                        <span>Before (-1s)</span>
                    </div>
                    <div class="preview">
                        ${afterImg}
                        <span>After (+1s)</span>
                    </div>
                </div>
            </div>
        `;
        }).join('')}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function addCutPoint() {
            const timeVal = parseFloat(document.getElementById('new-time').value);
            if (!isNaN(timeVal)) {
                vscode.postMessage({ command: 'addCutPoint', time: timeVal });
                document.getElementById('new-time').value = '';
                document.body.style.cursor = 'wait';
            }
        }

        function adjustTime(id, delta) {
            const input = document.getElementById('time-' + id);
            const current = parseFloat(input.value);
            if (!isNaN(current)) {
                const newVal = Math.max(0, current + delta);
                input.value = newVal.toFixed(3);
                updateCutPoint(id);
            }
        }

        function updateCutPoint(id) {
            const timeVal = parseFloat(document.getElementById('time-' + id).value);
            if (!isNaN(timeVal)) {
                document.body.style.cursor = 'wait';
                vscode.postMessage({ command: 'updateCutPoint', id, time: timeVal });
            }
        }

        function deleteCutPoint(id) {
            vscode.postMessage({ command: 'deleteCutPoint', id });
        }

        function confirmSplit() {
            vscode.postMessage({ command: 'confirmSplit' });
        }
    </script>
</body>
</html>`;
    }
}
