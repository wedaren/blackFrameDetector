import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CutPoint } from './models';

export class FFmpegService {

    public static detectBlackFrames(videoPath: string): Promise<CutPoint[]> {
        return new Promise((resolve, reject) => {
            // We use default parameters for blackdetect. E.g., duration >= 0.1s, pixel threshold 0.10
            const args = [
                '-i', videoPath,
                '-vf', 'blackdetect=d=0.1:pix_th=0.1',
                '-an',
                '-f', 'null',
                '-'
            ];

            const ffmpeg = spawn('ffmpeg', args);
            const cutPoints: CutPoint[] = [];
            let output = '';

            ffmpeg.stderr.on('data', (data) => {
                const text = data.toString();
                output += text;
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    // Parse lines like: [blackdetect @ 0x...] black_start:1.468 black_end:2.302 black_duration:0.834
                    const regex = /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
                    let match;
                    while ((match = regex.exec(output)) !== null) {
                        const start = parseFloat(match[1]);
                        const end = parseFloat(match[2]);
                        const duration = parseFloat(match[3]);
                        const time = start + (duration / 2);

                        if (!cutPoints.find(cp => cp.time === time)) {
                            cutPoints.push({
                                id: `cp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                                time,
                                duration
                            });
                        }
                    }
                    resolve(cutPoints);
                } else {
                    reject(new Error(`ffmpeg exited with code ${code}. Output: ${output}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(err);
            });
        });
    }

    public static extractPreview(videoPath: string, time: number, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const safeTime = Math.max(0, time);
            const args = [
                '-y',
                '-ss', safeTime.toString(),
                '-i', videoPath,
                '-vframes', '1',
                '-q:v', '2',
                outputPath
            ];

            const ffmpeg = spawn('ffmpeg', args);

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to extract preview at ${safeTime}`));
                }
            });
            ffmpeg.on('error', reject);
        });
    }

    public static async generatePreviewsForCutPoints(videoPath: string, cutPoints: CutPoint[], artifactsDir: string): Promise<void> {
        for (const cp of cutPoints) {
            const timeBefore = Math.max(0, cp.time - 1.0);
            const timeAfter = cp.time + 1.0; // Assume video is long enough

            const beforePath = path.join(artifactsDir, `${cp.id}_before.jpg`);
            const afterPath = path.join(artifactsDir, `${cp.id}_after.jpg`);

            await this.extractPreview(videoPath, timeBefore, beforePath);
            await this.extractPreview(videoPath, timeAfter, afterPath);

            cp.previewBefore = beforePath;
            cp.previewAfter = afterPath;
        }
    }

    public static async splitVideo(videoPath: string, cutPoints: CutPoint[], outputDir: string): Promise<string[]> {
        // Sort cut points by time ascending
        const sorted = [...cutPoints].sort((a, b) => a.time - b.time);
        const outputFiles: string[] = [];

        const ext = path.extname(videoPath);
        const baseName = path.basename(videoPath, ext);

        let startTime = 0;

        for (let i = 0; i <= sorted.length; i++) {
            const endTime = i < sorted.length ? sorted[i].time : null;
            const outPath = path.join(outputDir, `${baseName}_part${i + 1}${ext}`);

            await new Promise<void>((resolve, reject) => {
                const args = [
                    '-y',
                    '-i', videoPath,
                    '-ss', startTime.toString()
                ];

                if (endTime !== null) {
                    args.push('-to', endTime.toString());
                }

                args.push('-c', 'copy', outPath);

                const ffmpeg = spawn('ffmpeg', args);

                ffmpeg.on('close', (code) => {
                    if (code === 0) {
                        outputFiles.push(outPath);
                        resolve();
                    } else {
                        reject(new Error(`Failed to split chunk ${i + 1}`));
                    }
                });
                ffmpeg.on('error', reject);
            });

            if (endTime !== null) {
                startTime = endTime;
            }
        }

        return outputFiles;
    }
}
