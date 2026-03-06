import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskManager } from '../src/TaskManager';
import { Task, CutPoint } from '../src/models';

describe('TaskManager', function () {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfd-test-'));

    after(function () {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (e) {
            // ignore
        }
    });

    it('saves and reads detectedCutPoints in task.json', function () {
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
    });

    it('saveCutPoints preserves existing detectedCutPoints', function () {
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

        assert.ok(state.detectedCutPoints, 'detectedCutPoints should exist in task.json');
        assert.strictEqual(state.detectedCutPoints.length, 1);
        assert.strictEqual(state.detectedCutPoints[0].id, 'd1');

        // also the saved cutPoints should match current
        assert.ok(state.cutPoints, 'cutPoints should exist');
        assert.strictEqual(state.cutPoints.length, 1);
        assert.strictEqual(state.cutPoints[0].id, 'c1');
    });
});
