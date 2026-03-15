import * as vscode from 'vscode';
import * as path from 'path';
import { Task, CutPoint } from './models';
import { FFmpegService } from './ffmpegService';
import * as fs from 'fs';
import { TaskTreeProvider } from './TaskTreeProvider';
import { TaskManager } from './TaskManager';
import { ConfigManager } from './ConfigManager';
import { formatTimestampForFilename, getPreviewsDir, getTimelinePreviewsDir } from './taskPaths';

export class CutPointWebview {
    public static currentPanel: CutPointWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _task: Task;
    private _cutPoints: CutPoint[];
    private _timelinePreviewRequests = new Map<string, Promise<string>>();
    private _undoStack: CutPoint[][] = [];

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
                            this._pushUndoSnapshot();
                            cp.time = message.time;
                            cp.previewBefore = undefined;
                            cp.previewAfter = undefined;
                            cp.previewAnimBefore = undefined;
                            cp.previewAnimAfter = undefined;
                            const previewDir = getPreviewsDir(this._task);
                            if (previewDir && fs.existsSync(previewDir)) {
                                await FFmpegService.generatePreviewsForCutPoints(this._task.originalVideoPath, [cp], previewDir);
                            }
                            this._saveCutPoints();

                            const cacheBuster = Date.now().toString();
                            const webview = this._panel.webview;
                            const beforeUri = cp.previewBefore && fs.existsSync(cp.previewBefore) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewBefore)).toString()}?t=${cacheBuster}` : '';
                            const afterUri = cp.previewAfter && fs.existsSync(cp.previewAfter) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAfter)).toString()}?t=${cacheBuster}` : '';
                            const beforeAnimUri = cp.previewAnimBefore && fs.existsSync(cp.previewAnimBefore) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAnimBefore)).toString()}?t=${cacheBuster}` : '';
                            const afterAnimUri = cp.previewAnimAfter && fs.existsSync(cp.previewAnimAfter) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAnimAfter)).toString()}?t=${cacheBuster}` : '';

                            webview.postMessage({
                                command: 'cutPointUpdated',
                                id: cp.id,
                                beforeUri,
                                afterUri,
                                beforeAnimUri,
                                afterAnimUri
                            });
                        }
                        return;
                    case 'addCutPoint':
                        this._pushUndoSnapshot();
                        const newCp: CutPoint = {
                            id: `cp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                            time: message.time
                        };
                        this._cutPoints.push(newCp);
                        this._cutPoints.sort((a, b) => a.time - b.time);
                        const previewDirNew = getPreviewsDir(this._task);
                        if (!fs.existsSync(previewDirNew)) {
                            fs.mkdirSync(previewDirNew, { recursive: true });
                        }
                        await FFmpegService.generatePreviewsForCutPoints(this._task.originalVideoPath, [newCp], previewDirNew);
                        this._saveCutPoints();
                        this._update();
                        return;
                    case 'deleteCutPoint':
                        this._pushUndoSnapshot();
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

                        this._task.isSplitting = true;
                        TaskManager.updateTask(this._task);
                        this.treeProvider.refresh();
                        this._panel.dispose();

                        try {
                            const segments = await FFmpegService.splitVideo(this._task.originalVideoPath, this._cutPoints, this._task.taskFolderPath);
                            TaskManager.saveSplitOutputs(this._task, segments);

                            this._task.isSplitting = false;
                            this._task.isSplit = true;
                            TaskManager.updateTask(this._task);
                            vscode.window.showInformationMessage(`Splitting complete! Saved to ${this._task.taskFolderPath}`);
                            this.treeProvider.refresh();
                        } catch (e: any) {
                            this._task.isSplitting = false;
                            TaskManager.updateTask(this._task);
                            this.treeProvider.refresh();
                            vscode.window.showErrorMessage(`Failed to split video: ${e.message}`);
                        }
                        return;
                    case 'restoreDetected':
                        {
                            // Try to restore from cached detected.json first to avoid re-running ffmpeg
                            const cached = TaskManager.getDetectedCutPoints(this._task);
                            if (cached && cached.length > 0) {
                                const confirmCached = await vscode.window.showWarningMessage('Restore to original detected cut points? This will replace current cut points.', { modal: true }, 'Restore');
                                if (confirmCached !== 'Restore') {
                                    return;
                                }

                                this._pushUndoSnapshot();
                                this._cutPoints = cached;
                                const previewDirCached = getPreviewsDir(this._task);
                                try {
                                    if (!fs.existsSync(previewDirCached)) { fs.mkdirSync(previewDirCached, { recursive: true }); }
                                    await FFmpegService.generatePreviewsForCutPoints(this._task.originalVideoPath, this._cutPoints, previewDirCached);
                                    this._saveCutPoints();
                                    this._update();
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(`Failed to regenerate previews: ${e.message}`);
                                }
                                return;
                            }

                            // No cached detected data — offer to re-run detection
                            const run = await vscode.window.showWarningMessage('No cached detected cut points found. Re-run detection (may be slow)?', { modal: true }, 'Re-detect', 'Cancel');
                            if (run !== 'Re-detect') {
                                return;
                            }

                            const defaultMode = ConfigManager.getDetectionMode();
                            const pick = await vscode.window.showQuickPick([
                                { label: `Use Default (${defaultMode})`, description: 'Use global detection mode' },
                                { label: 'Black', description: 'Detect black frames only' },
                                { label: 'White', description: 'Detect white frames only' },
                                { label: 'Black+White', description: 'Detect both black and white frames' }
                            ], { placeHolder: 'Select detection mode (Esc to use default)' });

                            let selectedMode: 'black' | 'white' | 'both' = defaultMode;
                            if (pick) {
                                if (pick.label.startsWith('Use Default')) {
                                    selectedMode = defaultMode;
                                } else if (pick.label === 'Black') {
                                    selectedMode = 'black';
                                } else if (pick.label === 'White') {
                                    selectedMode = 'white';
                                } else if (pick.label === 'Black+White') {
                                    selectedMode = 'both';
                                }
                            }

                            this._task.isLoading = true;
                            TaskManager.updateTask(this._task);
                            this.treeProvider.refresh();

                            try {
                                const detected = await FFmpegService.detectFrames(this._task.originalVideoPath, selectedMode);
                                const previewDir = getPreviewsDir(this._task);
                                if (!fs.existsSync(previewDir)) { fs.mkdirSync(previewDir, { recursive: true }); }
                                await FFmpegService.generatePreviewsForCutPoints(this._task.originalVideoPath, detected, previewDir);
                                this._pushUndoSnapshot();
                                this._cutPoints = detected;
                                // overwrite cached detected.json with fresh results
                                TaskManager.saveDetectedCutPoints(this._task, detected, true);
                                this._saveCutPoints();
                                this._update();
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to restore detected cut points: ${e.message}`);
                            } finally {
                                this._task.isLoading = false;
                                TaskManager.updateTask(this._task);
                                this.treeProvider.refresh();
                            }
                        }
                        return;
                    case 'undo':
                        this._undoLastAction();
                        return;
                    case 'requestTimelinePreview':
                        {
                            const time = typeof message.time === 'number' ? message.time : Number(message.time);
                            if (!Number.isFinite(time)) {
                                return;
                            }

                            try {
                                const previewPath = await this._getTimelinePreviewPath(time);
                                const previewUri = `${this._panel.webview.asWebviewUri(vscode.Uri.file(previewPath)).toString()}?t=${Date.now().toString()}`;
                                this._panel.webview.postMessage({
                                    command: 'timelinePreviewReady',
                                    time,
                                    previewUri
                                });
                            } catch (e: any) {
                                this._panel.webview.postMessage({
                                    command: 'timelinePreviewFailed',
                                    time,
                                    error: e.message
                                });
                            }
                        }
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private async _getTimelinePreviewPath(time: number): Promise<string> {
        const bucketTime = Math.max(0, Math.round(time * 2) / 2);
        const previewsDir = getTimelinePreviewsDir(this._task);
        if (!fs.existsSync(previewsDir)) {
            fs.mkdirSync(previewsDir, { recursive: true });
        }

        const bucketKey = formatTimestampForFilename(bucketTime).replace(/-/g, '_');
        const previewPath = path.join(previewsDir, `timeline_${bucketKey}_${bucketTime.toFixed(1).replace('.', '_')}s.jpg`);
        if (fs.existsSync(previewPath)) {
            return previewPath;
        }

        if (!this._timelinePreviewRequests.has(previewPath)) {
            this._timelinePreviewRequests.set(previewPath, (async () => {
                await FFmpegService.extractPreview(this._task.originalVideoPath, bucketTime, previewPath);
                return previewPath;
            })());
        }

        try {
            return await this._timelinePreviewRequests.get(previewPath)!;
        } finally {
            this._timelinePreviewRequests.delete(previewPath);
        }
    }

    private _cloneCutPoints(cutPoints: CutPoint[]): CutPoint[] {
        return cutPoints.map(cp => ({ ...cp }));
    }

    private _pushUndoSnapshot() {
        this._undoStack.push(this._cloneCutPoints(this._cutPoints));
        if (this._undoStack.length > 50) {
            this._undoStack.shift();
        }
    }

    private _undoLastAction() {
        const snapshot = this._undoStack.pop();
        if (!snapshot) {
            void vscode.window.showInformationMessage('Nothing to undo.');
            return;
        }

        this._cutPoints = this._cloneCutPoints(snapshot);
        this._saveCutPoints();
        this._update();
    }

    private _saveCutPoints() {
        TaskManager.saveCutPoints(this._task, this._cutPoints);
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
                localResourceRoots: [
                    vscode.Uri.file(storagePath),
                    vscode.Uri.file(getTimelinePreviewsDir(task)),
                    vscode.Uri.file(path.dirname(task.originalVideoPath))
                ]
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
        const videoUri = webview.asWebviewUri(vscode.Uri.file(this._task.originalVideoPath)).toString();
        const cacheBuster = Date.now().toString();
        const minSliceDuration = ConfigManager.getMinSliceDuration();
        const mappedData = this._cutPoints.map(cp => {
            const beforeUri = cp.previewBefore && fs.existsSync(cp.previewBefore) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewBefore)).toString()}?t=${cacheBuster}` : '';
            const afterUri = cp.previewAfter && fs.existsSync(cp.previewAfter) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAfter)).toString()}?t=${cacheBuster}` : '';
            const beforeAnimUri = cp.previewAnimBefore && fs.existsSync(cp.previewAnimBefore) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAnimBefore)).toString()}?t=${cacheBuster}` : '';
            const afterAnimUri = cp.previewAnimAfter && fs.existsSync(cp.previewAnimAfter) ? `${webview.asWebviewUri(vscode.Uri.file(cp.previewAnimAfter)).toString()}?t=${cacheBuster}` : '';
            return {
                ...cp,
                beforeUri,
                afterUri,
                beforeAnimUri,
                afterAnimUri
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
        
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 15px; }
        .header-actions { display: flex; gap: 15px; align-items: center; }
        #new-time { width: 80px; }
        .sticky-top { position: sticky; top: -20px; background: var(--vscode-editor-background); padding: 20px 0 10px 0; z-index: 100; margin-top: -20px; border-bottom: 1px solid var(--vscode-widget-border); }
        .overview-panel { margin: 16px 0 24px 0; padding: 16px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; background: var(--vscode-sideBar-background); }
        .overview-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 12px; }
        .overview-title { margin: 0; font-size: 16px; }
        .overview-meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
        .timeline-wrap { position: relative; margin-bottom: 14px; }
        .timeline { display: flex; width: 100%; height: 18px; overflow: hidden; border-radius: 999px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-inactiveSelectionBackground); }
        .timeline-segment { min-width: 6px; border-right: 1px solid var(--vscode-editor-background); background: linear-gradient(90deg, var(--vscode-button-background), var(--vscode-button-hoverBackground)); }
        .timeline-segment.is-short { background: linear-gradient(90deg, #b85a00, #e0a000); }
        .timeline-preview { position: absolute; left: 0; top: calc(100% + 10px); width: 220px; padding: 8px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); box-shadow: 0 6px 24px rgba(0,0,0,0.25); transform: translateX(-50%); pointer-events: none; opacity: 0; transition: opacity 120ms ease; z-index: 20; }
        .timeline-preview.is-visible { opacity: 1; }
        .timeline-preview img { display: none; width: 100%; height: auto; border-radius: 4px; background: #000; }
        .timeline-preview-time { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
        .segment-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
        .segment-card { padding: 12px; border-radius: 6px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); }
        .segment-card.is-short { border-color: #e0a000; box-shadow: inset 0 0 0 1px rgba(224, 160, 0, 0.25); }
        .segment-name { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
        .segment-duration { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
        .segment-range, .segment-warning { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .segment-warning { color: #e0a000; margin-top: 4px; }
        .clickable { cursor: pointer; }
        .cut-point.is-focused { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 2px 12px rgba(0,0,0,0.2); }
    </style>
</head>
<body>
    <video id="source-video" preload="metadata" src="${videoUri}" style="display:none;"></video>
    <div class="sticky-top">
        <div class="header" style="border: none; padding-bottom: 10px; margin-bottom: 0;">
            <h2 style="margin: 0;">Refine Cut Points</h2>
            <div class="header-actions">
                <div>
                    <input type="number" id="new-time" step="any" placeholder="Time (s)">
                    <button onclick="addCutPoint()">+ Add Cut Point</button>
                </div>
                <button onclick="undoEdit()">Undo</button>
                <button onclick="restoreDetected()">Restore Detected</button>
                <button class="primary" onclick="confirmSplit()">Confirm and Split Video</button>
            </div>
        </div>
    </div>

    <div class="overview-panel">
        <div class="overview-head">
            <h3 class="overview-title">Segment Overview</h3>
            <div class="overview-meta" id="overview-meta">Loading video duration...</div>
        </div>
        <div class="timeline-wrap" id="timeline-wrap">
            <div class="timeline-preview" id="timeline-preview">
                <img id="timeline-preview-image" alt="Timeline preview">
                <div class="timeline-preview-time" id="timeline-preview-time">Loading preview...</div>
            </div>
            <div class="timeline" id="segment-timeline"></div>
        </div>
        <div class="segment-grid" id="segment-grid"></div>
    </div>
    
    <div id="cut-points-list" style="margin-top: 20px;">
        ${mappedData.length === 0 ? '<p>No cut points found. Add one manually.</p>' : ''}
        ${mappedData.map((cp, idx) => {
            const durationTxt = cp.duration ? `<div style="font-size: 12px; color: var(--vscode-descriptionForeground);">Detected Duration: ${cp.duration.toFixed(2)}s</div>` : '';
            const beforeImg = `
                <img id="img-before-${cp.id}" src="${cp.beforeUri || ''}" data-static="${cp.beforeUri || ''}" data-anim="${cp.beforeAnimUri || ''}" onmouseover="hoverAnim(this)" onmouseout="unhoverAnim(this)" alt="Before" style="cursor: pointer; ${!cp.beforeUri ? 'display:none;' : ''}">
                <div id="placeholder-before-${cp.id}" style="${cp.beforeUri ? 'display:none;' : ''} height: 135px; width: 240px; display:flex; align-items:center; justify-content:center; border: 1px dashed var(--vscode-widget-border);">No Preview</div>
            `;
            const afterImg = `
                <img id="img-after-${cp.id}" src="${cp.afterUri || ''}" data-static="${cp.afterUri || ''}" data-anim="${cp.afterAnimUri || ''}" onmouseover="hoverAnim(this)" onmouseout="unhoverAnim(this)" alt="After" style="cursor: pointer; ${!cp.afterUri ? 'display:none;' : ''}">
                <div id="placeholder-after-${cp.id}" style="${cp.afterUri ? 'display:none;' : ''} height: 135px; width: 240px; display:flex; align-items:center; justify-content:center; border: 1px dashed var(--vscode-widget-border);">No Preview</div>
            `;

            const origTime = cp.originalTime || cp.time;

            return `
            <div class="cut-point" id="cut-point-card-${cp.id}">
                <div class="controls">
                    <div><strong>Cut #${idx + 1}</strong></div>
                    ${durationTxt}
                    
                    <div class="time-adjuster" style="margin-bottom: 12px;">
                        <button class="btn-small" onclick="adjustTime('${cp.id}', -0.5)">-0.5s</button>
                        <button class="btn-small" onclick="adjustTime('${cp.id}', -0.1)">-0.1s</button>
                        <input type="number" step="any" id="time-${cp.id}" value="${cp.time.toFixed(3)}" onchange="syncInput('${cp.id}'); updateCutPoint('${cp.id}')">
                        <button class="btn-small" onclick="adjustTime('${cp.id}', 0.1)">+0.1s</button>
                        <button class="btn-small" onclick="adjustTime('${cp.id}', 0.5)">+0.5s</button>
                    </div>
                    
                    <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;">Fine-tune Slider:</div>
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 15px;">
                        <input type="range" id="slider-${cp.id}" 
                               min="${Math.max(0, origTime - 5)}" max="${origTime + 5}" step="0.05" 
                               value="${cp.time.toFixed(3)}" 
                               oninput="syncSlider('${cp.id}')" 
                               onchange="updateCutPoint('${cp.id}')" style="flex: 1; cursor: pointer;">
                        <select id="range-${cp.id}" onchange="updateSliderRange('${cp.id}', ${origTime})" style="background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; padding: 2px;">
                            <option value="1">±1s</option>
                            <option value="2">±2s</option>
                            <option value="5" selected>±5s</option>
                        </select>
                    </div>
                    
                    <div style="margin-top: 10px; display: flex; gap: 10px;">
                        <button class="btn-small" onclick="resetCutPoint('${cp.id}', ${origTime})" title="Reset to original detected time">Reset to Default</button>
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
        const minSliceDuration = ${JSON.stringify(minSliceDuration)};
        const initialCutPoints = ${JSON.stringify(mappedData.map(cp => ({ id: cp.id, time: cp.time })))};
        let currentVideoDuration = undefined;
        let timelineHoverTimeout = undefined;
        let lastTimelinePreviewBucket = undefined;
        let activePreviewRequestBucket = undefined;
        let pendingPreviewBucket = undefined;
        let previewCache = new Map();

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'cutPointUpdated':
                    const cpId = message.id;
                    const beforeImg = document.getElementById('img-before-' + cpId);
                    const beforePlaceholder = document.getElementById('placeholder-before-' + cpId);
                    const afterImg = document.getElementById('img-after-' + cpId);
                    const afterPlaceholder = document.getElementById('placeholder-after-' + cpId);
                    
                    if (beforeImg && beforePlaceholder) {
                        if (message.beforeUri) {
                            beforeImg.src = message.beforeUri;
                            beforeImg.setAttribute('data-static', message.beforeUri);
                            beforeImg.setAttribute('data-anim', message.beforeAnimUri || '');
                            beforeImg.style.display = 'block';
                            beforePlaceholder.style.display = 'none';
                        } else {
                            beforeImg.style.display = 'none';
                            beforePlaceholder.style.display = 'flex';
                        }
                    }
                    if (afterImg && afterPlaceholder) {
                        if (message.afterUri) {
                            afterImg.src = message.afterUri;
                            afterImg.setAttribute('data-static', message.afterUri);
                            afterImg.setAttribute('data-anim', message.afterAnimUri || '');
                            afterImg.style.display = 'block';
                            afterPlaceholder.style.display = 'none';
                        } else {
                            afterImg.style.display = 'none';
                            afterPlaceholder.style.display = 'flex';
                        }
                    }
                    
                    document.body.style.cursor = 'default';
                    renderSegmentOverview();
                    break;
                case 'timelinePreviewReady':
                    previewCache.set(message.time, message.previewUri);
                    if (activePreviewRequestBucket === message.time || pendingPreviewBucket === message.time) {
                        updateTimelinePreviewImage(message.time, message.previewUri);
                        activePreviewRequestBucket = undefined;
                        pendingPreviewBucket = undefined;
                    }
                    break;
                case 'timelinePreviewFailed':
                    if (activePreviewRequestBucket === message.time) {
                        activePreviewRequestBucket = undefined;
                    }
                    break;
            }
        });

        const sourceVideo = document.getElementById('source-video');
        sourceVideo.addEventListener('loadedmetadata', () => {
            if (Number.isFinite(sourceVideo.duration)) {
                currentVideoDuration = sourceVideo.duration;
                renderSegmentOverview();
            }
        });
        sourceVideo.addEventListener('durationchange', () => {
            if (Number.isFinite(sourceVideo.duration)) {
                currentVideoDuration = sourceVideo.duration;
                renderSegmentOverview();
            }
        });

        function formatSeconds(seconds) {
            if (!Number.isFinite(seconds)) {
                return 'Unknown';
            }
            const total = Math.max(0, Math.floor(seconds));
            const hours = Math.floor(total / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            const secs = total % 60;
            if (hours > 0) {
                return [hours, minutes.toString().padStart(2, '0'), secs.toString().padStart(2, '0')].join(':');
            }
            return [minutes.toString().padStart(2, '0'), secs.toString().padStart(2, '0')].join(':');
        }

        function getCurrentCutPoints() {
            const ids = initialCutPoints.map(cp => cp.id);
            return ids
                .map(id => {
                    const input = document.getElementById('time-' + id);
                    if (!input) {
                        return null;
                    }
                    const time = parseFloat(input.value);
                    if (isNaN(time)) {
                        return null;
                    }
                    return { id, time };
                })
                .filter(Boolean)
                .sort((a, b) => a.time - b.time);
        }

        function buildSegments(cutPoints, videoDuration) {
            const segments = [];
            let segmentStart = 0;
            for (let i = 0; i < cutPoints.length; i++) {
                const end = cutPoints[i].time;
                segments.push({
                    id: 'segment-' + String(i + 1).padStart(3, '0'),
                    cutPointId: cutPoints[i].id,
                    start: segmentStart,
                    end,
                    duration: Math.max(0, end - segmentStart)
                });
                segmentStart = end;
            }

            segments.push({
                id: 'segment-' + String(cutPoints.length + 1).padStart(3, '0'),
                cutPointId: cutPoints.length > 0 ? cutPoints[cutPoints.length - 1].id : undefined,
                start: segmentStart,
                end: Number.isFinite(videoDuration) ? videoDuration : undefined,
                duration: Number.isFinite(videoDuration) ? Math.max(0, videoDuration - segmentStart) : undefined
            });

            return segments;
        }

        function renderSegmentOverview() {
            const meta = document.getElementById('overview-meta');
            const timeline = document.getElementById('segment-timeline');
            const grid = document.getElementById('segment-grid');
            const cutPoints = getCurrentCutPoints();
            const segments = buildSegments(cutPoints, currentVideoDuration);

            if (!Number.isFinite(currentVideoDuration)) {
                meta.textContent = 'Loading video duration...';
            } else {
                meta.textContent = 'Video duration ' + formatSeconds(currentVideoDuration) + ' · ' + segments.length + ' segments';
            }

            timeline.innerHTML = '';
            grid.innerHTML = '';

            segments.forEach(segment => {
                const segmentDuration = Number.isFinite(segment.duration) ? segment.duration : 0;
                const widthPercent = Number.isFinite(currentVideoDuration) && currentVideoDuration > 0
                    ? Math.max((segmentDuration / currentVideoDuration) * 100, 1)
                    : Math.max(100 / Math.max(segments.length, 1), 8);
                const isShort = Number.isFinite(segment.duration) && segment.duration < minSliceDuration;

                const timelineSegment = document.createElement('div');
                timelineSegment.className = 'timeline-segment clickable' + (isShort ? ' is-short' : '');
                timelineSegment.style.width = widthPercent + '%';
                timelineSegment.title = segment.id + ' · ' + (Number.isFinite(segment.duration) ? formatSeconds(segment.duration) : 'Pending duration');
                timelineSegment.addEventListener('click', () => focusCutPoint(segment.cutPointId));
                timeline.appendChild(timelineSegment);

                const card = document.createElement('div');
                card.className = 'segment-card clickable' + (isShort ? ' is-short' : '');
                card.addEventListener('click', () => focusCutPoint(segment.cutPointId));
                const endText = Number.isFinite(segment.end) ? formatSeconds(segment.end) : 'Video end';
                const durationText = Number.isFinite(segment.duration) ? formatSeconds(segment.duration) : 'Waiting for video metadata';
                card.innerHTML = [
                    '<div class="segment-name">' + segment.id + '</div>',
                    '<div class="segment-duration">' + durationText + '</div>',
                    '<div class="segment-range">' + formatSeconds(segment.start) + ' → ' + endText + '</div>',
                    isShort ? '<div class="segment-warning">Below min slice duration (' + minSliceDuration + 's)</div>' : ''
                ].join('');
                grid.appendChild(card);
            });
        }

        function focusCutPoint(cutPointId) {
            if (!cutPointId) {
                return;
            }
            const target = document.getElementById('cut-point-card-' + cutPointId);
            if (!target) {
                return;
            }

            document.querySelectorAll('.cut-point.is-focused').forEach(node => node.classList.remove('is-focused'));
            target.classList.add('is-focused');
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            window.setTimeout(() => {
                target.classList.remove('is-focused');
            }, 1800);
        }

        const timeline = document.getElementById('segment-timeline');
        const timelinePreview = document.getElementById('timeline-preview');
        const timelinePreviewImage = document.getElementById('timeline-preview-image');
        const timelinePreviewTime = document.getElementById('timeline-preview-time');
        const timelineWrap = document.getElementById('timeline-wrap');

        timeline.addEventListener('mousemove', event => {
            if (!Number.isFinite(currentVideoDuration) || currentVideoDuration <= 0) {
                return;
            }

            const rect = timeline.getBoundingClientRect();
            const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
            const hoverTime = ratio * currentVideoDuration;
            showTimelinePreview(ratio, hoverTime);
        });

        timeline.addEventListener('mouseenter', event => {
            if (!Number.isFinite(currentVideoDuration) || currentVideoDuration <= 0) {
                return;
            }
            const rect = timeline.getBoundingClientRect();
            const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
            const hoverTime = ratio * currentVideoDuration;
            showTimelinePreview(ratio, hoverTime);
        });

        timeline.addEventListener('mouseleave', () => {
            timelinePreview.classList.remove('is-visible');
            if (timelineHoverTimeout) {
                clearTimeout(timelineHoverTimeout);
                timelineHoverTimeout = undefined;
            }
        });

        function showTimelinePreview(ratio, hoverTime) {
            const previewX = Math.max(16, Math.min(ratio * timelineWrap.clientWidth, timelineWrap.clientWidth - 16));
            timelinePreview.style.left = previewX + 'px';
            timelinePreview.classList.add('is-visible');
            timelinePreviewTime.textContent = formatSeconds(hoverTime);

            const bucketTime = Math.max(0, Math.round(hoverTime * 2) / 2);
            if (lastTimelinePreviewBucket === bucketTime && previewCache.has(bucketTime)) {
                updateTimelinePreviewImage(bucketTime, previewCache.get(bucketTime));
                return;
            }

            lastTimelinePreviewBucket = bucketTime;
            if (previewCache.has(bucketTime)) {
                updateTimelinePreviewImage(bucketTime, previewCache.get(bucketTime));
                return;
            }

            pendingPreviewBucket = bucketTime;
            timelinePreviewTime.textContent = formatSeconds(hoverTime) + ' · Loading preview...';
            if (timelineHoverTimeout) {
                clearTimeout(timelineHoverTimeout);
            }
            timelineHoverTimeout = setTimeout(() => {
                if (activePreviewRequestBucket === bucketTime) {
                    return;
                }
                activePreviewRequestBucket = bucketTime;
                vscode.postMessage({ command: 'requestTimelinePreview', time: bucketTime });
            }, 120);
        }

        function updateTimelinePreviewImage(time, uri) {
            timelinePreviewImage.src = uri;
            timelinePreviewImage.style.display = 'block';
            timelinePreviewTime.textContent = formatSeconds(time);
        }

        function hoverAnim(imgElement) {
            const animSrc = imgElement.getAttribute('data-anim');
            if (animSrc) {
                imgElement.src = animSrc;
            }
        }

        function unhoverAnim(imgElement) {
            const staticSrc = imgElement.getAttribute('data-static');
            if (staticSrc) {
                imgElement.src = staticSrc;
            }
        }

        function syncSlider(id) {
            const sliderVal = document.getElementById('slider-' + id).value;
            const input = document.getElementById('time-' + id);
            input.value = parseFloat(sliderVal).toFixed(3);
            renderSegmentOverview();
        }

        function syncInput(id) {
            const inputVal = document.getElementById('time-' + id).value;
            const slider = document.getElementById('slider-' + id);
            if (slider) slider.value = parseFloat(inputVal).toFixed(3);
            renderSegmentOverview();
        }

        function updateSliderRange(id, baseTime) {
            const rangeSelect = document.getElementById('range-' + id);
            const slider = document.getElementById('slider-' + id);
            const rangeVal = parseFloat(rangeSelect.value);
            slider.min = Math.max(0, baseTime - rangeVal);
            slider.max = baseTime + rangeVal;
            // update UI display to not overflow
            if (parseFloat(slider.value) < parseFloat(slider.min)) slider.value = slider.min;
            if (parseFloat(slider.value) > parseFloat(slider.max)) slider.value = slider.max;
            syncSlider(id);
            updateCutPoint(id);
        }

        function resetCutPoint(id, origTime) {
            const input = document.getElementById('time-' + id);
            input.value = origTime.toFixed(3);
            syncInput(id);
            updateCutPoint(id);
        }

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
                syncInput(id);
                updateCutPoint(id);
            }
        }

        const updateTimeouts = {};

        function updateCutPoint(id) {
            const timeVal = parseFloat(document.getElementById('time-' + id).value);
            if (!isNaN(timeVal)) {
                if (updateTimeouts[id]) {
                    clearTimeout(updateTimeouts[id]);
                }
                updateTimeouts[id] = setTimeout(() => {
                    document.body.style.cursor = 'wait';
                    vscode.postMessage({ command: 'updateCutPoint', id, time: timeVal });
                }, 300);
            }
        }

        function deleteCutPoint(id) {
            vscode.postMessage({ command: 'deleteCutPoint', id });
        }

        function confirmSplit() {
            vscode.postMessage({ command: 'confirmSplit' });
        }

        function restoreDetected() {
            vscode.postMessage({ command: 'restoreDetected' });
        }

        function undoEdit() {
            vscode.postMessage({ command: 'undo' });
        }

        renderSegmentOverview();
    </script>
</body>
</html>`;
    }
}
