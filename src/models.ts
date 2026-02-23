export interface Task {
    id: string; // the file path or hash of the video acts as ID
    name: string;
    originalVideoPath: string;
    createdAt: number;
    isSplit?: boolean;
}

export interface CutPoint {
    id: string;
    time: number; // in seconds
    duration?: number;
    previewBefore?: string; // local absolute path
    previewAfter?: string; // local absolute path
}
