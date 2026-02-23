import * as vscode from 'vscode';

export class ConfigManager {
    public static readonly DEFAULT_DIR_KEY = 'blackFrameDetector.defaultDirectory';

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
