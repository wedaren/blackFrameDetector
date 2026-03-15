import * as path from 'path';
import { Task } from './models';

export interface SegmentOutput {
    id: string;
    file: string;
    start: number;
    end?: number;
}

export function getAnalysisDir(task: Task): string {
    return path.join(task.taskFolderPath, '.analysis');
}

export function getPreviewsDir(task: Task): string {
    return path.join(getAnalysisDir(task), 'previews');
}

export function getCutPointsFile(task: Task): string {
    return path.join(getAnalysisDir(task), 'cut-points.json');
}

export function getDetectedCutPointsFile(task: Task): string {
    return path.join(getAnalysisDir(task), 'detected-cut-points.json');
}

export function getTimelinePreviewsDir(task: Task): string {
    return path.join(getAnalysisDir(task), 'timeline-previews');
}

export function formatTimestampForFilename(timeInSeconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(timeInSeconds));
    const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    return `${hours}-${minutes}-${seconds}`;
}

export function getSegmentBaseName(videoPath: string): string {
    return path.basename(videoPath, path.extname(videoPath));
}
