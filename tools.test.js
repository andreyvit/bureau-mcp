import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createFsFromVolume, vol } from 'memfs';
import {
  createBureauContext,
  detectDefaultBureauDir,
  findNextReportNumber,
  findNextTaskDirName,
  formatLocalDate,
  getCurrentTaskDir,
  getDateSuffix,
  getRecentTaskDirs,
  getReportFiles,
  getTaskInfo,
  newReportFileName,
  parseTaskDirName,
  resolveBureauContext
} from './bureau.js';
import { handleToolCall } from './index.js';

const memoryFs = createFsFromVolume(vol);
const cwd = '/workspace';

function toolOptions(overrides = {}) {
  return {
    cwd,
    env: {},
    fsImpl: memoryFs.promises,
    ...overrides
  };
}

function parseResponse(response) {
  return JSON.parse(response.content[0].text);
}

function buildDailyTaskFiles(bureauDir, startDate, count) {
  const files = {};
  const taskDirs = [];
  const date = new Date(startDate);

  for (let index = 0; index < count; index += 1) {
    const taskDir = `${formatLocalDate(date)}-task-${index + 1}`;
    files[`${cwd}/${bureauDir}/${taskDir}/.keep`] = '';
    taskDirs.push(taskDir);
    date.setDate(date.getDate() + 1);
  }

  return { files, taskDirs };
}

beforeEach(() => {
  vol.reset();
});

describe('Bureau core logic', () => {
  describe('date suffix generation', () => {
    const sampleDate = new Date(2025, 9, 1, 12, 0, 0);

    test('uses local dates', () => {
      assert.equal(formatLocalDate(sampleDate), '2025-10-01');
      assert.equal(getDateSuffix(0, sampleDate), '2025-10-01');
    });

    test('uses b through y for same-day tasks 2 through 25', () => {
      assert.equal(getDateSuffix(1, sampleDate), '2025-10-01b');
      assert.equal(getDateSuffix(24, sampleDate), '2025-10-01y');
    });

    test('uses zNNN suffixes after y', () => {
      assert.equal(getDateSuffix(25, sampleDate), '2025-10-01z026');
      assert.equal(getDateSuffix(999, sampleDate), '2025-10-01z1000');
    });
  });

  describe('task directory parsing', () => {
    test('parses plain and suffixed task directory names', () => {
      assert.deepEqual(parseTaskDirName('2025-10-01-some-task'), {
        datePrefix: '2025-10-01',
        slug: 'some-task'
      });
      assert.deepEqual(parseTaskDirName('2025-10-01b-second-task'), {
        datePrefix: '2025-10-01b',
        slug: 'second-task'
      });
    });

    test('accepts z-style suffixes with more than three digits', () => {
      assert.deepEqual(parseTaskDirName('2025-10-01z026-many-tasks'), {
        datePrefix: '2025-10-01z026',
        slug: 'many-tasks'
      });
      assert.deepEqual(parseTaskDirName('2025-10-01z1000-last-task'), {
        datePrefix: '2025-10-01z1000',
        slug: 'last-task'
      });
    });

    test('rejects invalid task directory names', () => {
      assert.equal(parseTaskDirName('not-a-task'), null);
    });
  });

  describe('bureau dir detection', () => {
    test('defaults to .tasks when no bureau dir exists', async () => {
      assert.equal(await detectDefaultBureauDir({ cwd, fsImpl: memoryFs.promises }), '.tasks');
    });

    test('prefers the highest-scoring existing bureau dir', async () => {
      vol.fromJSON({
        '/workspace/.tasks/.keep': '',
        '/workspace/_tasks/2025-10-01-existing/.keep': ''
      });
      await memoryFs.promises.symlink('2025-10-01-existing', '/workspace/_tasks/current');

      assert.equal(await detectDefaultBureauDir({ cwd, fsImpl: memoryFs.promises }), '_tasks');
    });

    test('honors BUREAU_DIR overrides', async () => {
      const context = await resolveBureauContext({
        cwd,
        env: { BUREAU_DIR: '/custom/tasks/' },
        fsImpl: memoryFs.promises
      });

      assert.equal(context.bureauDir, '/custom/tasks');
      assert.equal(context.bureauDirPath, '/custom/tasks');
    });
  });

  describe('task and report numbering', () => {
    test('allocates new same-day task suffixes by date prefix, not by slug', async () => {
      const context = createBureauContext({ cwd, bureauDir: '.tasks' });
      const sampleDate = new Date(2025, 9, 1, 12, 0, 0);

      vol.fromJSON({
        '/workspace/.tasks/2025-10-01-first-task/.keep': ''
      });

      assert.equal(
        await findNextTaskDirName(context, 'second-task', memoryFs.promises, sampleDate),
        '2025-10-01b-second-task'
      );
    });

    test('normalizes current symlink targets to a task dir basename', async () => {
      const context = createBureauContext({ cwd, bureauDir: '.tasks' });

      vol.fromJSON({
        '/workspace/.tasks/2025-10-01-task/.keep': ''
      });
      await memoryFs.promises.symlink('../.tasks/2025-10-01-task/', '/workspace/.tasks/current');

      assert.equal(await getCurrentTaskDir(context, memoryFs.promises), '2025-10-01-task');
    });

    test('sorts report files numerically and includes numbered non-markdown files', async () => {
      const context = createBureauContext({ cwd, bureauDir: '.tasks' });

      vol.fromJSON({
        '/workspace/.tasks/2025-10-01-task/1-first.md': '',
        '/workspace/.tasks/2025-10-01-task/11-eleventh.txt': '',
        '/workspace/.tasks/2025-10-01-task/100-hundredth.md': '',
        '/workspace/.tasks/2025-10-01-task/notes.md': ''
      });

      assert.deepEqual(
        await getReportFiles(context, '2025-10-01-task', memoryFs.promises),
        ['1-first.md', '11-eleventh.txt', '100-hundredth.md']
      );
    });

    test('uses the highest numeric prefix when choosing the next report number', async () => {
      const context = createBureauContext({ cwd, bureauDir: '.tasks' });

      vol.fromJSON({
        '/workspace/.tasks/2025-10-01-task/001-start.md': '',
        '/workspace/.tasks/2025-10-01-task/042-review.txt': '',
        '/workspace/.tasks/2025-10-01-task/005-plan.md': ''
      });

      assert.equal(await findNextReportNumber(context, '2025-10-01-task', memoryFs.promises), 43);
      assert.equal(newReportFileName(43, 'implementation'), '043-implementation.md');
    });

    test('returns all tasks from the last 60 days when that already yields at least 30 tasks', async () => {
      const context = createBureauContext({ cwd, bureauDir: '_tasks' });
      const now = new Date(2025, 2, 31, 12, 0, 0);
      const { files, taskDirs } = buildDailyTaskFiles('_tasks', new Date(2025, 1, 1, 12, 0, 0), 35);
      vol.fromJSON(files);

      assert.deepEqual(await getRecentTaskDirs(context, memoryFs.promises, now), taskDirs);
    });

    test('backfills older tasks until at least 30 are returned when the last 60 days contain fewer', async () => {
      const context = createBureauContext({ cwd, bureauDir: '_tasks' });
      const now = new Date(2025, 3, 15, 12, 0, 0);
      const { files, taskDirs } = buildDailyTaskFiles('_tasks', new Date(2025, 0, 1, 12, 0, 0), 40);
      vol.fromJSON(files);

      assert.deepEqual(
        await getRecentTaskDirs(context, memoryFs.promises, now),
        taskDirs.slice(-30)
      );
    });

    test('reports task info using the resolved bureau dir path', async () => {
      const context = createBureauContext({ cwd, bureauDir: '.tasks' });

      vol.fromJSON({
        '/workspace/.tasks/2025-10-01-task/001-user-request.md': ''
      });

      assert.deepEqual(await getTaskInfo(context, '2025-10-01-task', memoryFs.promises), {
        task_dir: '2025-10-01-task',
        task_slug: 'task',
        reports_dir: '.tasks/2025-10-01-task',
        report_file_names: ['001-user-request.md']
      });
    });
  });
});

describe('Bureau MCP tools', () => {
  test('current_task returns a non-error payload when no current task exists', async () => {
    const response = await handleToolCall('current_task', {}, toolOptions());
    assert.deepEqual(parseResponse(response), { error: 'No current task' });
    assert.equal(response.isError, undefined);
  });

  test('current_task returns task info when a current task exists', async () => {
    vol.fromJSON({
      '/workspace/_tasks/2025-10-02-refactor-something/001-user-request.md': '',
      '/workspace/_tasks/2025-10-02-refactor-something/002-plan.md': '',
      '/workspace/_tasks/2025-10-02-refactor-something/003-implementation.md': '',
      '/workspace/_tasks/2025-10-02-refactor-something/004-tests.md': ''
    });
    await memoryFs.promises.symlink('2025-10-02-refactor-something', '/workspace/_tasks/current');

    const response = await handleToolCall('current_task', {}, toolOptions());
    const payload = parseResponse(response);

    assert.deepEqual(payload, {
      task_dir: '2025-10-02-refactor-something',
      task_slug: 'refactor-something',
      reports_dir: '_tasks/2025-10-02-refactor-something',
      report_file_names: [
        '001-user-request.md',
        '002-plan.md',
        '003-implementation.md',
        '004-tests.md'
      ]
    });
  });

  test('start_new_task creates .tasks by default and updates current', async () => {
    const response = await handleToolCall('start_new_task', { task_slug: 'first-task' }, toolOptions());
    const payload = parseResponse(response);

    assert.equal(payload.task_slug, 'first-task');
    assert.match(payload.task_dir, /^\d{4}-\d{2}-\d{2}-first-task$/);
    assert.equal(payload.reports_dir, `.tasks/${payload.task_dir}`);
    assert.equal(await memoryFs.promises.readlink('/workspace/.tasks/current'), payload.task_dir);
  });

  test('start_new_task uses an existing .tasks directory when present', async () => {
    vol.fromJSON({
      '/workspace/.tasks/.keep': ''
    });

    const response = await handleToolCall('start_new_task', { task_slug: 'first-task' }, toolOptions());
    const payload = parseResponse(response);

    assert.equal(payload.reports_dir, `.tasks/${payload.task_dir}`);
    assert.equal(await memoryFs.promises.readlink('/workspace/.tasks/current'), payload.task_dir);
    await assert.rejects(memoryFs.promises.stat('/workspace/_tasks'));
  });

  test('start_new_task uses the next same-day suffix when today already has a task', async () => {
    const today = formatLocalDate();

    vol.fromJSON({
      [`/workspace/.tasks/${today}-first-task/.keep`]: ''
    });

    const response = await handleToolCall('start_new_task', { task_slug: 'second-task' }, toolOptions());
    const payload = parseResponse(response);

    assert.equal(payload.task_dir, `${today}b-second-task`);
    assert.equal(await memoryFs.promises.readlink('/workspace/.tasks/current'), `${today}b-second-task`);
  });

  test('switch_task accepts a full task_dir', async () => {
    vol.fromJSON({
      '/workspace/_tasks/2025-10-01-task-one/.keep': '',
      '/workspace/_tasks/2025-10-01b-task-two/.keep': ''
    });
    await memoryFs.promises.symlink('2025-10-01-task-one', '/workspace/_tasks/current');

    const response = await handleToolCall('switch_task', { task_dir: '2025-10-01b-task-two' }, toolOptions());
    const payload = parseResponse(response);

    assert.equal(payload.task_slug, 'task-two');
    assert.equal(await memoryFs.promises.readlink('/workspace/_tasks/current'), '2025-10-01b-task-two');
  });

  test('switch_task still supports switching by slug', async () => {
    vol.fromJSON({
      '/workspace/_tasks/2025-10-01-task-one/.keep': '',
      '/workspace/_tasks/2025-10-02-task-one/.keep': '',
      '/workspace/_tasks/2025-10-03-task-two/.keep': ''
    });

    const response = await handleToolCall('switch_task', { task_slug: 'task-one' }, toolOptions());
    const payload = parseResponse(response);

    assert.equal(payload.task_dir, '2025-10-02-task-one');
    assert.equal(await memoryFs.promises.readlink('/workspace/_tasks/current'), '2025-10-02-task-one');
  });

  test('list_recent_tasks backfills to 30 task dirs when fewer than 30 fall within 60 days', async () => {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 109);
    const { files, taskDirs } = buildDailyTaskFiles('_tasks', startDate, 40);
    vol.fromJSON(files);

    const response = await handleToolCall('list_recent_tasks', {}, toolOptions());
    const payload = parseResponse(response);

    assert.deepEqual(payload.recent_task_dirs, taskDirs.slice(-30));
    assert.deepEqual(
      payload.recent_task_slugs,
      taskDirs.slice(-30).map(taskDir => parseTaskDirName(taskDir).slug)
    );
  });

  test('start_new_report_file returns a path in the detected bureau dir without creating the file', async () => {
    vol.fromJSON({
      '/workspace/.tasks/2025-10-01-task/001-user-request.md': '',
      '/workspace/.tasks/2025-10-01-task/002-plan.md': ''
    });
    await memoryFs.promises.symlink('2025-10-01-task', '/workspace/.tasks/current');

    const response = await handleToolCall('start_new_report_file', { suffix: 'tests' }, toolOptions());
    const payload = parseResponse(response);

    assert.equal(payload.report_file_to_create, '.tasks/2025-10-01-task/003-tests.md');
    await assert.rejects(memoryFs.promises.stat('/workspace/.tasks/2025-10-01-task/003-tests.md'));
  });

  test('rejects invalid task slugs and report suffixes', async () => {
    await assert.rejects(
      handleToolCall('start_new_task', { task_slug: 'bad slug' }, toolOptions()),
      /must not contain space or '\//
    );
    await assert.rejects(
      handleToolCall('start_new_task', { task_slug: 'bad/slug' }, toolOptions()),
      /must not contain space or '\//
    );
    await assert.rejects(
      handleToolCall('start_new_report_file', { suffix: 'bad slug' }, toolOptions()),
      /must not contain space or '\//
    );

    await assert.rejects(
      handleToolCall('start_new_report_file', { suffix: 'bad/slug' }, toolOptions()),
      /must not contain space or '\//
    );
  });
});
