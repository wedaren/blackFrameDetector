import * as vscode from 'vscode';

export class ConfigManager {
    public static readonly DEFAULT_DIR_KEY = 'blackFrameDetector.defaultDirectory';
    public static readonly PREVIEW_DURATION_KEY = 'blackFrameDetector.previewDuration';
    public static readonly MIN_SLICE_DURATION_KEY = 'blackFrameDetector.minSliceDuration';

    public static getMinSliceDuration(): number {
        const config = vscode.workspace.getConfiguration();
        return config.get<number>(this.MIN_SLICE_DURATION_KEY) || 5.0;
    }

    public static getPreviewDuration(): number {
        const config = vscode.workspace.getConfiguration();
        return config.get<number>(this.PREVIEW_DURATION_KEY) || 2.0;
    }

    public static getDefaultDirectory(): string | undefined {
        const config = vscode.workspace.getConfiguration();
        const dir = config.get<string>(this.DEFAULT_DIR_KEY);
        return dir && dir.trim() !== '' ? dir : undefined;
    }

    public static async promptForDefaultDirectory(): Promise<string | undefined> {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Default Directory'
        });

        if (selected && selected.length > 0) {
            const dirPath = selected[0].fsPath;
            await vscode.workspace.getConfiguration().update(this.DEFAULT_DIR_KEY, dirPath, vscode.ConfigurationTarget.Global);
            return dirPath;
        }

        return undefined;
    }
}
