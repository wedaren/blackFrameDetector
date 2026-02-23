import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CutPoint } from './models';
import { ConfigManager } from './ConfigManager';

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
                                originalTime: time,
                                duration
                            });
                        }
                    }

                    const minSliceDuration = ConfigManager.getMinSliceDuration();
                    const filteredCutPoints: CutPoint[] = [];
                    let lastCutTime = 0;

                    // Sort by time just in case FFmpeg output was out of order
                    cutPoints.sort((a, b) => a.time - b.time);

                    for (const cp of cutPoints) {
                        if (cp.time - lastCutTime >= minSliceDuration) {
                            filteredCutPoints.push(cp);
                            lastCutTime = cp.time;
                        }
                    }

                    resolve(filteredCutPoints);
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

    public static extractAnimatedPreview(videoPath: string, startTime: number, duration: number, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const safeTime = Math.max(0, startTime);
            const args = [
                '-y',
                '-ss', safeTime.toString(),
                '-t', duration.toString(),
                '-i', videoPath,
                '-vf', 'fps=10,scale=320:-1:flags=lanczos',
                '-loop', '0',
                outputPath
            ];

            const ffmpeg = spawn('ffmpeg', args);

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to extract animated preview starting at ${safeTime}`));
                }
            });
            ffmpeg.on('error', reject);
        });
    }

    public static async generatePreviewsForCutPoints(videoPath: string, cutPoints: CutPoint[], artifactsDir: string): Promise<void> {
        const hoverDuration = ConfigManager.getPreviewDuration();
        for (const cp of cutPoints) {
            const timeBefore = Math.max(0, cp.time - 1.0);
            const timeAfter = cp.time + 1.0; // Assume video is long enough
            const animStartBefore = Math.max(0, cp.time - hoverDuration);
            const animStartAfter = cp.time;

            const beforePath = path.join(artifactsDir, `${cp.id}_before.jpg`);
            const afterPath = path.join(artifactsDir, `${cp.id}_after.jpg`);
            const beforeAnimPath = path.join(artifactsDir, `${cp.id}_before.webp`);
            const afterAnimPath = path.join(artifactsDir, `${cp.id}_after.webp`);

            await this.extractPreview(videoPath, timeBefore, beforePath);
            await this.extractPreview(videoPath, timeAfter, afterPath);
            await this.extractAnimatedPreview(videoPath, animStartBefore, hoverDuration, beforeAnimPath);
            await this.extractAnimatedPreview(videoPath, animStartAfter, hoverDuration, afterAnimPath);

            cp.previewBefore = beforePath;
            cp.previewAfter = afterPath;
            cp.previewAnimBefore = beforeAnimPath;
            cp.previewAnimAfter = afterAnimPath;
        }
    }

    public static async splitVideo(videoPath: string, cutPoints: CutPoint[], outputDir: string): Promise<string[]> {
        // Sort cut points by time ascending
        const sorted = [...cutPoints].sort((a, b) => a.time - b.time);
        const ext = path.extname(videoPath);
        const baseName = path.basename(videoPath, ext);

        if (sorted.length === 0) {
            // No cut points, just copy the whole video
            const outPath = path.join(outputDir, `${baseName}_part001${ext}`);
            await new Promise<void>((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', ['-y', '-i', videoPath, '-c', 'copy', outPath]);
                ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error('Failed to copy video')));
                ffmpeg.on('error', reject);
            });
            return [outPath];
        }

        const segmentTimes = sorted.map(cp => cp.time.toFixed(3)).join(',');
        const outPattern = path.join(outputDir, `${baseName}_part%03d${ext}`);

        await new Promise<void>((resolve, reject) => {
            const args = [
                '-y',
                '-i', videoPath,
                '-c', 'copy',
                '-f', 'segment',
                '-segment_times', segmentTimes,
                '-reset_timestamps', '1',
                outPattern
            ];

            const ffmpeg = spawn('ffmpeg', args);
            let errorOutput = '';

            ffmpeg.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to split video. FFmpeg exited with code ${code}. Output: ${errorOutput}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`Failed to start FFmpeg: ${err.message}`));
            });
        });

        // Generate the expected output file names
        const outputFiles: string[] = [];
        for (let i = 0; i <= sorted.length; i++) {
            const paddedIndex = i.toString().padStart(3, '0');
            outputFiles.push(path.join(outputDir, `${baseName}_part${paddedIndex}${ext}`));
        }

        return outputFiles;
    }
}
