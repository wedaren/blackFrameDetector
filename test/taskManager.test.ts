import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskManager } from '../src/TaskManager';
import { Task, CutPoint } from '../src/models';
import { getCutPointsFile, getDetectedCutPointsFile } from '../src/taskPaths';

describe('TaskManager', function () {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfd-test-'));

    after(function () {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (e) {
            // ignore
        }
    });

    it('saves and reads detected cut points from .analysis files', function () {
        const taskFolder = path.join(tmpRoot, 'task1');
        const task: Task = {
            id: 't1',
            name: 'video.mp4',
            originalVideoPath: '/tmp/video.mp4',
            taskFolderPath: taskFolder,
            createdAt: Date.now()
        };

        const detected: CutPoint[] = [
            { id: 'cp1', time: 1.23 },
            { id: 'cp2', time: 4.56 }
        ];

        // ensure clean state
        if (fs.existsSync(taskFolder)) fs.rmSync(taskFolder, { recursive: true, force: true });

        TaskManager.saveDetectedCutPoints(task, detected, true);

        const read = TaskManager.getDetectedCutPoints(task);
        assert.strictEqual(Array.isArray(read), true);
        assert.strictEqual(read.length, 2);
        assert.strictEqual(read[0].id, 'cp1');

        const taskJsonPath = path.join(taskFolder, 'task.json');
        const state = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
        assert.strictEqual(state.analysis.detectedCutPointsFile, path.join('.analysis', 'detected-cut-points.json'));
        assert.strictEqual(fs.existsSync(getDetectedCutPointsFile(task)), true);
    });

    it('saveCutPoints stores current cut points in .analysis and preserves detected metadata', function () {
        const taskFolder = path.join(tmpRoot, 'task2');
        const task: Task = {
            id: 't2',
            name: 'video2.mp4',
            originalVideoPath: '/tmp/video2.mp4',
            taskFolderPath: taskFolder,
            createdAt: Date.now()
        };

        // prepare detectedCutPoints
        const detected: CutPoint[] = [ { id: 'd1', time: 0.5 } ];
        TaskManager.saveDetectedCutPoints(task, detected, true);

        // now save current cutPoints (this should preserve detectedCutPoints inside task.json)
        const current: CutPoint[] = [ { id: 'c1', time: 2.0 } ];
        TaskManager.saveCutPoints(task, current);

        const taskJsonPath = path.join(taskFolder, 'task.json');
        const content = fs.readFileSync(taskJsonPath, 'utf8');
        const state = JSON.parse(content);

        assert.ok(state.analysis, 'analysis config should exist in task.json');
        assert.strictEqual(state.analysis.cutPointsFile, path.join('.analysis', 'cut-points.json'));
        assert.strictEqual(state.analysis.detectedCutPointsFile, path.join('.analysis', 'detected-cut-points.json'));
        assert.strictEqual(fs.existsSync(getCutPointsFile(task)), true);
        assert.strictEqual(fs.existsSync(getDetectedCutPointsFile(task)), true);

        const savedDetected = JSON.parse(fs.readFileSync(getDetectedCutPointsFile(task), 'utf8'));
        const savedCurrent = JSON.parse(fs.readFileSync(getCutPointsFile(task), 'utf8'));
        assert.strictEqual(savedDetected.length, 1);
        assert.strictEqual(savedDetected[0].id, 'd1');
        assert.strictEqual(savedCurrent.length, 1);
        assert.strictEqual(savedCurrent[0].id, 'c1');
    });

    it('reads legacy embedded cut point data from task.json', function () {
        const taskFolder = path.join(tmpRoot, 'task3');
        fs.mkdirSync(taskFolder, { recursive: true });
        const task: Task = {
            id: 't3',
            name: 'video3.mp4',
            originalVideoPath: '/tmp/video3.mp4',
            taskFolderPath: taskFolder,
            createdAt: Date.now()
        };

        fs.writeFileSync(path.join(taskFolder, 'task.json'), JSON.stringify({
            task,
            cutPoints: [{ id: 'legacy-cut', time: 2.5 }],
            detectedCutPoints: [{ id: 'legacy-detected', time: 1.25 }]
        }, null, 2), 'utf8');

        const current = TaskManager.getCutPoints(task);
        const detected = TaskManager.getDetectedCutPoints(task);
        assert.strictEqual(current[0].id, 'legacy-cut');
        assert.strictEqual(detected[0].id, 'legacy-detected');
    });
});
