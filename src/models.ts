export interface Task {
    id: string; // the file path or hash of the video acts as ID
    name: string;
    originalVideoPath: string;
    taskFolderPath: string; // the absolute path to the directory saving this task's state
    createdAt: number;
    isSplit?: boolean;
    isLoading?: boolean;
    isSplitting?: boolean;
}

export interface CutPoint {
    id: string;
    time: number; // in seconds
    originalTime?: number; // the original detected time for resetting
    duration?: number;
    previewBefore?: string; // local absolute path
    previewAfter?: string; // local absolute path
    previewAnimBefore?: string; // animated webp for hover
    previewAnimAfter?: string; // animated webp for hover
}
