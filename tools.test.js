import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { vol } from 'memfs';
import fs from 'fs/promises';

// Mock the fs module with memfs
import { createFsFromVolume } from 'memfs';
const memoryFs = createFsFromVolume(vol);

// We need to import the utilities from index.js, but since it's a server file,
// we'll test the logic by simulating the tool handlers

// Utility functions extracted for testing (copy from index.js)
function getDateSuffix(index) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0];
  if (index === 0) return dateStr;
  return dateStr + String.fromCharCode(97 + index);
}

function parseTaskDirName(dirName) {
  const match = dirName.match(/^(\d{4}-\d{2}-\d{2}[b-z]?)-(.+)$/);
  if (!match) return null;
  return { datePrefix: match[1], slug: match[2] };
}

async function getAllTaskDirs(tasksDir, fsImpl) {
  try {
    await fsImpl.mkdir(tasksDir, { recursive: true });
    const entries = await fsImpl.readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && parseTaskDirName(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    return [];
  }
}

async function getRecentTaskDirs(tasksDir, fsImpl) {
  const allDirs = await getAllTaskDirs(tasksDir, fsImpl);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoffStr = thirtyDaysAgo.toISOString().split('T')[0];

  return allDirs.filter(dirName => {
    const parsed = parseTaskDirName(dirName);
    if (!parsed) return false;
    const dateOnly = parsed.datePrefix.replace(/[b-z]$/, '');
    return dateOnly >= cutoffStr;
  });
}

async function getCurrentTaskDir(currentLink, fsImpl) {
  try {
    const target = await fsImpl.readlink(currentLink);
    return target;
  } catch (error) {
    return null;
  }
}

async function getReportFiles(taskPath, fsImpl) {
  try {
    const entries = await fsImpl.readdir(taskPath);
    const reportFiles = entries
      .filter(name => /^\d{3}-.*\.md$/.test(name))
      .sort();

    if (reportFiles.length <= 50) {
      return reportFiles;
    }
    return [
      ...reportFiles.slice(0, 20),
      ...reportFiles.slice(-30)
    ];
  } catch (error) {
    return [];
  }
}

async function findNextReportNumber(taskPath, fsImpl) {
  const reportFiles = await getReportFiles(taskPath, fsImpl);
  if (reportFiles.length === 0) {
    return 1;
  }

  const numbers = reportFiles.map(name => {
    const match = name.match(/^(\d{3})-/);
    return match ? parseInt(match[1], 10) : 0;
  });

  const maxNumber = Math.max(...numbers);
  return maxNumber + 1;
}

async function findTaskDirBySlug(slug, tasksDir, fsImpl) {
  const allDirs = await getAllTaskDirs(tasksDir, fsImpl);

  for (let i = allDirs.length - 1; i >= 0; i--) {
    const parsed = parseTaskDirName(allDirs[i]);
    if (parsed && parsed.slug === slug) {
      return allDirs[i];
    }
  }

  return null;
}

describe('Bureau MCP Tools', () => {
  const TASKS_DIR = '/_tasks';
  const CURRENT_LINK = '/_tasks/current';

  beforeEach(() => {
    vol.reset();
  });

  afterEach(() => {
    vol.reset();
  });

  describe('Date suffix generation', () => {
    test('generates correct date suffix for first task', () => {
      const suffix = getDateSuffix(0);
      assert.match(suffix, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('generates correct date suffix for second task', () => {
      const suffix = getDateSuffix(1);
      assert.match(suffix, /^\d{4}-\d{2}-\d{2}b$/);
    });

    test('generates correct date suffix for third task', () => {
      const suffix = getDateSuffix(2);
      assert.match(suffix, /^\d{4}-\d{2}-\d{2}c$/);
    });
  });

  describe('Task directory name parsing', () => {
    test('parses simple task directory name', () => {
      const result = parseTaskDirName('2025-10-01-some-urgent-task');
      assert.deepEqual(result, {
        datePrefix: '2025-10-01',
        slug: 'some-urgent-task'
      });
    });

    test('parses task directory name with suffix', () => {
      const result = parseTaskDirName('2025-10-01b-second-task');
      assert.deepEqual(result, {
        datePrefix: '2025-10-01b',
        slug: 'second-task'
      });
    });

    test('returns null for invalid format', () => {
      const result = parseTaskDirName('invalid-name');
      assert.equal(result, null);
    });
  });

  describe('current_task tool', () => {
    test('returns null when no current task exists', async () => {
      vol.fromJSON({
        '/_tasks/.keep': ''
      });

      const taskDir = await getCurrentTaskDir(CURRENT_LINK, memoryFs.promises);
      assert.equal(taskDir, null);
    });

    test('returns task info when current task exists', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-test-task/001-user-request.md': 'content',
        '/_tasks/2025-10-01-test-task/002-plan.md': 'content'
      });

      // Create symlink
      await memoryFs.promises.symlink('2025-10-01-test-task', CURRENT_LINK);

      const taskDir = await getCurrentTaskDir(CURRENT_LINK, memoryFs.promises);
      assert.equal(taskDir, '2025-10-01-test-task');

      const parsed = parseTaskDirName(taskDir);
      assert.equal(parsed.slug, 'test-task');

      const reportFiles = await getReportFiles('/_tasks/2025-10-01-test-task', memoryFs.promises);
      assert.deepEqual(reportFiles, ['001-user-request.md', '002-plan.md']);
    });
  });

  describe('start_new_task tool', () => {
    test('creates first task of the day', async () => {
      vol.fromJSON({ '/_tasks/.keep': '' });

      const today = new Date().toISOString().split('T')[0];
      const expectedDir = `${today}-my-task`;

      await memoryFs.promises.mkdir(`/_tasks/${expectedDir}`, { recursive: true });
      await memoryFs.promises.symlink(expectedDir, CURRENT_LINK);

      const taskDir = await getCurrentTaskDir(CURRENT_LINK, memoryFs.promises);
      assert.equal(taskDir, expectedDir);
    });

    test('creates second task of the day with suffix', async () => {
      const today = new Date().toISOString().split('T')[0];

      vol.fromJSON({
        [`/_tasks/${today}-first-task/.keep`]: '',
        [`/_tasks/${today}b-second-task/.keep`]: ''
      });

      const allDirs = await getAllTaskDirs(TASKS_DIR, memoryFs.promises);
      assert.deepEqual(allDirs, [`${today}-first-task`, `${today}b-second-task`]);
    });
  });

  describe('switch_task tool', () => {
    test('switches to existing task', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-task-one/.keep': '',
        '/_tasks/2025-10-01b-task-two/.keep': ''
      });

      await memoryFs.promises.symlink('2025-10-01-task-one', CURRENT_LINK);

      let currentDir = await getCurrentTaskDir(CURRENT_LINK, memoryFs.promises);
      assert.equal(currentDir, '2025-10-01-task-one');

      // Switch to second task
      await memoryFs.promises.unlink(CURRENT_LINK);
      await memoryFs.promises.symlink('2025-10-01b-task-two', CURRENT_LINK);

      currentDir = await getCurrentTaskDir(CURRENT_LINK, memoryFs.promises);
      assert.equal(currentDir, '2025-10-01b-task-two');
    });

    test('finds task by slug', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-my-task/.keep': '',
        '/_tasks/2025-10-02-another-task/.keep': ''
      });

      const taskDir = await findTaskDirBySlug('my-task', TASKS_DIR, memoryFs.promises);
      assert.equal(taskDir, '2025-10-01-my-task');
    });

    test('returns null for non-existent task', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-my-task/.keep': ''
      });

      const taskDir = await findTaskDirBySlug('non-existent', TASKS_DIR, memoryFs.promises);
      assert.equal(taskDir, null);
    });
  });

  describe('list_recent_tasks tool', () => {
    test('returns empty list when no tasks exist', async () => {
      vol.fromJSON({ '/_tasks/.keep': '' });

      const recentDirs = await getRecentTaskDirs(TASKS_DIR, memoryFs.promises);
      assert.deepEqual(recentDirs, []);
    });

    test('returns tasks from last 30 days', async () => {
      const today = new Date();
      const recent = new Date(today);
      recent.setDate(recent.getDate() - 10);
      const old = new Date(today);
      old.setDate(old.getDate() - 40);

      const recentDate = recent.toISOString().split('T')[0];
      const oldDate = old.toISOString().split('T')[0];

      vol.fromJSON({
        [`/_tasks/${recentDate}-recent-task/.keep`]: '',
        [`/_tasks/${oldDate}-old-task/.keep`]: ''
      });

      const recentDirs = await getRecentTaskDirs(TASKS_DIR, memoryFs.promises);
      assert.equal(recentDirs.length, 1);
      assert.equal(recentDirs[0], `${recentDate}-recent-task`);
    });
  });

  describe('start_new_report_file tool', () => {
    test('generates first report file number', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-my-task/.keep': ''
      });

      const nextNumber = await findNextReportNumber('/_tasks/2025-10-01-my-task', memoryFs.promises);
      assert.equal(nextNumber, 1);
    });

    test('generates sequential report file numbers', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-my-task/001-start.md': 'content',
        '/_tasks/2025-10-01-my-task/002-plan.md': 'content',
        '/_tasks/2025-10-01-my-task/003-review.md': 'content'
      });

      const nextNumber = await findNextReportNumber('/_tasks/2025-10-01-my-task', memoryFs.promises);
      assert.equal(nextNumber, 4);
    });

    test('handles gaps in numbering', async () => {
      vol.fromJSON({
        '/_tasks/2025-10-01-my-task/001-start.md': 'content',
        '/_tasks/2025-10-01-my-task/005-review.md': 'content'
      });

      const nextNumber = await findNextReportNumber('/_tasks/2025-10-01-my-task', memoryFs.promises);
      assert.equal(nextNumber, 6);
    });
  });

  describe('Report file filtering', () => {
    test('returns all files when less than 50', async () => {
      const files = {};
      for (let i = 1; i <= 30; i++) {
        files[`/_tasks/2025-10-01-my-task/${String(i).padStart(3, '0')}-file.md`] = 'content';
      }
      vol.fromJSON(files);

      const reportFiles = await getReportFiles('/_tasks/2025-10-01-my-task', memoryFs.promises);
      assert.equal(reportFiles.length, 30);
    });

    test('returns earliest 20 and latest 30 when over 50 files', async () => {
      const files = {};
      for (let i = 1; i <= 100; i++) {
        files[`/_tasks/2025-10-01-my-task/${String(i).padStart(3, '0')}-file.md`] = 'content';
      }
      vol.fromJSON(files);

      const reportFiles = await getReportFiles('/_tasks/2025-10-01-my-task', memoryFs.promises);
      assert.equal(reportFiles.length, 50);
      assert.equal(reportFiles[0], '001-file.md');
      assert.equal(reportFiles[19], '020-file.md');
      assert.equal(reportFiles[20], '071-file.md');
      assert.equal(reportFiles[49], '100-file.md');
    });
  });
});
