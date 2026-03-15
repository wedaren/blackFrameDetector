import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CutPoint } from './models';
import { ConfigManager } from './ConfigManager';
import { SegmentOutput, formatTimestampForFilename, getSegmentBaseName } from './taskPaths';

export class FFmpegService {
    private static removeExistingSegments(videoPath: string, outputDir: string) {
        if (!fs.existsSync(outputDir)) {
            return;
        }

        const ext = path.extname(videoPath);
        const baseName = getSegmentBaseName(videoPath);
        const segmentPrefix = `${baseName}_segment-`;

        for (const item of fs.readdirSync(outputDir)) {
            if (!item.startsWith(segmentPrefix) || !item.endsWith(ext)) {
                continue;
            }

            const fullPath = path.join(outputDir, item);
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                fs.rmSync(fullPath, { force: true });
            }
        }
    }

    public static detectBlackFrames(videoPath: string): Promise<CutPoint[]> {
        return this.detectFrames(videoPath, 'black');
    }

    private static runBlackdetectWithFilter(videoPath: string, vfFilter: string): Promise<CutPoint[]> {
        return new Promise((resolve, reject) => {
            const args = [
                '-i', videoPath,
                '-vf', vfFilter,
                '-an',
                '-f', 'null',
                '-'
            ];

            const ffmpeg = spawn('ffmpeg', args);
            const cutPoints: CutPoint[] = [];
            let output = '';

            ffmpeg.stderr.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    const regex = /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
                    let match;
                    while ((match = regex.exec(output)) !== null) {
                        const start = parseFloat(match[1]);
                        const end = parseFloat(match[2]);
                        const duration = parseFloat(match[3]);
                        const time = end;

                        const duplicate = cutPoints.find(cp => Math.abs(cp.time - time) < 0.05);
                        if (!duplicate) {
                            cutPoints.push({
                                id: `cp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                                time,
                                originalTime: time,
                                duration
                            });
                        }
                    }

                    resolve(cutPoints);
                } else {
                    reject(new Error(`ffmpeg exited with code ${code}. Output: ${output}`));
                }
            });

            ffmpeg.on('error', (err) => reject(err));
        });
    }

    public static async detectFrames(videoPath: string, mode: 'black' | 'white' | 'both'): Promise<CutPoint[]> {
        const minSliceDuration = ConfigManager.getMinSliceDuration();

        if (mode === 'black') {
            const raw = await this.runBlackdetectWithFilter(videoPath, 'blackdetect=d=0.1:pix_th=0.1');
            return this.filterByMinSlice(raw, minSliceDuration);
        }

        if (mode === 'white') {
            const raw = await this.runBlackdetectWithFilter(videoPath, 'negate,blackdetect=d=0.1:pix_th=0.1');
            return this.filterByMinSlice(raw, minSliceDuration);
        }

        // both
        const rawBlack = await this.runBlackdetectWithFilter(videoPath, 'blackdetect=d=0.1:pix_th=0.1');
        const rawWhite = await this.runBlackdetectWithFilter(videoPath, 'negate,blackdetect=d=0.1:pix_th=0.1');

        // merge and dedupe by time
        const combined = [...rawBlack, ...rawWhite];
        combined.sort((a, b) => a.time - b.time);

        const merged: CutPoint[] = [];
        for (const cp of combined) {
            if (!merged.find(m => Math.abs(m.time - cp.time) < 0.05)) {
                merged.push(cp);
            }
        }

        return this.filterByMinSlice(merged, minSliceDuration);
    }

    private static filterByMinSlice(cutPoints: CutPoint[], minSliceDuration: number): CutPoint[] {
        const filtered: CutPoint[] = [];
        let lastCutTime = 0;
        cutPoints.sort((a, b) => a.time - b.time);
        for (const cp of cutPoints) {
            if (cp.time - lastCutTime >= minSliceDuration) {
                filtered.push(cp);
                lastCutTime = cp.time;
            }
        }
        return filtered;
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
            const previewDir = path.join(artifactsDir, cp.id);
            if (!fs.existsSync(previewDir)) {
                fs.mkdirSync(previewDir, { recursive: true });
            }

            const beforePath = path.join(previewDir, 'before.jpg');
            const afterPath = path.join(previewDir, 'after.jpg');
            const beforeAnimPath = path.join(previewDir, 'before.webp');
            const afterAnimPath = path.join(previewDir, 'after.webp');

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

    public static async splitVideo(videoPath: string, cutPoints: CutPoint[], outputDir: string): Promise<SegmentOutput[]> {
        // Sort cut points by time ascending
        const sorted = [...cutPoints].sort((a, b) => a.time - b.time);
        const ext = path.extname(videoPath);
        const baseName = getSegmentBaseName(videoPath);

        this.removeExistingSegments(videoPath, outputDir);

        if (sorted.length === 0) {
            // No cut points, just copy the whole video
            const outPath = path.join(outputDir, `${baseName}_segment-001${ext}`);
            await new Promise<void>((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', ['-y', '-i', videoPath, '-c', 'copy', outPath]);
                ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error('Failed to copy video')));
                ffmpeg.on('error', reject);
            });
            return [{
                id: 'segment-001',
                file: outPath,
                start: 0
            }];
        }

        const segmentTimes = sorted.map(cp => cp.time.toFixed(3)).join(',');
        const tempPattern = path.join(outputDir, `${baseName}.__segment_tmp_%03d${ext}`);

        await new Promise<void>((resolve, reject) => {
            const args = [
                '-y',
                '-i', videoPath,
                '-c', 'copy',
                '-f', 'segment',
                '-segment_times', segmentTimes,
                '-reset_timestamps', '1',
                tempPattern
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

        const segmentOutputs: SegmentOutput[] = [];
        const boundaries = [0, ...sorted.map(cp => cp.time)];
        for (let i = 0; i <= sorted.length; i++) {
            const tempIndex = i.toString().padStart(3, '0');
            const segmentIndex = (i + 1).toString().padStart(3, '0');
            const start = boundaries[i];
            const end = i < sorted.length ? sorted[i].time : undefined;
            const timeRange = end !== undefined
                ? `${formatTimestampForFilename(start)}_${formatTimestampForFilename(end)}`
                : `${formatTimestampForFilename(start)}_end`;
            const finalName = `${baseName}_segment-${segmentIndex}_${timeRange}${ext}`;
            const tempPath = path.join(outputDir, `${baseName}.__segment_tmp_${tempIndex}${ext}`);
            const finalPath = path.join(outputDir, finalName);

            if (fs.existsSync(tempPath)) {
                fs.renameSync(tempPath, finalPath);
            }

            segmentOutputs.push({
                id: `segment-${segmentIndex}`,
                file: finalPath,
                start,
                end
            });
        }

        return segmentOutputs;
    }
}
