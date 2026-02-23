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
                            cp.previewBefore = undefined;
                            cp.previewAfter = undefined;
                            cp.previewAnimBefore = undefined;
                            cp.previewAnimAfter = undefined;
                            const previewDir = this._task.taskFolderPath;
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

                        this._task.isSplitting = true;
                        TaskManager.updateTask(this._task);
                        this.treeProvider.refresh();
                        this._panel.dispose();

                        try {
                            const outputDir = path.join(this._task.taskFolderPath, 'splits');
                            if (!fs.existsSync(outputDir)) {
                                fs.mkdirSync(outputDir, { recursive: true });
                            }
                            await FFmpegService.splitVideo(this._task.originalVideoPath, this._cutPoints, outputDir);

                            this._task.isSplitting = false;
                            this._task.isSplit = true;
                            TaskManager.updateTask(this._task);
                            vscode.window.showInformationMessage(`Splitting complete! Saved to ${outputDir}`);
                            this.treeProvider.refresh();
                        } catch (e: any) {
                            this._task.isSplitting = false;
                            TaskManager.updateTask(this._task);
                            this.treeProvider.refresh();
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
    </style>
</head>
<body>
    <div class="sticky-top">
        <div class="header" style="border: none; padding-bottom: 10px; margin-bottom: 0;">
            <h2 style="margin: 0;">Refine Cut Points</h2>
            <div class="header-actions">
                <div>
                    <input type="number" id="new-time" step="any" placeholder="Time (s)">
                    <button onclick="addCutPoint()">+ Add Cut Point</button>
                </div>
                <button class="primary" onclick="confirmSplit()">Confirm and Split Video</button>
            </div>
        </div>
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
            <div class="cut-point">
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
                    break;
            }
        });

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
        }

        function syncInput(id) {
            const inputVal = document.getElementById('time-' + id).value;
            const slider = document.getElementById('slider-' + id);
            if (slider) slider.value = parseFloat(inputVal).toFixed(3);
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
    </script>
</body>
</html>`;
    }
}
