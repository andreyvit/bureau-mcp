import fs from 'fs/promises';
import path from 'path';

export const DEFAULT_BUREAU_DIRS = ['.tasks', '_tasks', '.reports', '_reports'];
export const RECENT_TASK_DAY_WINDOW = 60;
export const MIN_RECENT_TASKS = 30;

const TASK_DIR_RE = /^(\d{4}-\d{2}-\d{2}(?:[b-y]|z\d+)?)-(.+)$/;
const TASK_DIR_PREFIX_RE = /^\d{4}/;
const REPORT_FILE_RE = /^\d/;

export function formatLocalDate(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDateSuffix(index, date = new Date()) {
  const dateStr = formatLocalDate(date);

  if (index === 0) {
    return dateStr;
  }

  if (index <= 24) {
    return dateStr + String.fromCharCode(97 + index);
  }

  return dateStr + 'z' + String(index + 1).padStart(3, '0');
}

export function parseTaskDirName(dirName) {
  const match = dirName.match(TASK_DIR_RE);
  if (!match) {
    return null;
  }

  return {
    datePrefix: match[1],
    slug: match[2]
  };
}

export function newReportFileName(number, suffix) {
  return `${String(number).padStart(3, '0')}-${suffix}.md`;
}

export function normalizeBureauDir(bureauDir) {
  if (bureauDir === '/') {
    return bureauDir;
  }

  return bureauDir.replace(/\/+$/, '');
}

export function createBureauContext({ cwd = process.cwd(), bureauDir }) {
  const normalizedBureauDir = normalizeBureauDir(bureauDir);

  return {
    cwd,
    bureauDir: normalizedBureauDir,
    bureauDirPath: path.resolve(cwd, normalizedBureauDir),
    currentLinkPath: path.resolve(cwd, normalizedBureauDir, 'current')
  };
}

async function pathIsDirectory(dirPath, fsImpl) {
  try {
    return (await fsImpl.stat(dirPath)).isDirectory();
  } catch (error) {
    return false;
  }
}

async function pathIsSymlink(filePath, fsImpl) {
  try {
    return (await fsImpl.lstat(filePath)).isSymbolicLink();
  } catch (error) {
    return false;
  }
}

export async function dirHasTaskDirs(dirPath, fsImpl = fs) {
  try {
    const entries = await fsImpl.readdir(dirPath, { withFileTypes: true });
    return entries.some(entry => entry.isDirectory() && TASK_DIR_PREFIX_RE.test(entry.name));
  } catch (error) {
    return false;
  }
}

export async function detectDefaultBureauDir({ cwd = process.cwd(), fsImpl = fs } = {}) {
  let bestDir = '';
  let bestScore = 0;

  for (const candidate of DEFAULT_BUREAU_DIRS) {
    const candidatePath = path.resolve(cwd, candidate);
    if (!(await pathIsDirectory(candidatePath, fsImpl))) {
      continue;
    }

    let score = 1;

    if (await pathIsSymlink(path.join(candidatePath, 'current'), fsImpl)) {
      score += 1;
    }

    if (await dirHasTaskDirs(candidatePath, fsImpl)) {
      score += 3;
    }

    if (score > bestScore) {
      bestDir = candidate;
      bestScore = score;
    }
  }

  return bestDir || DEFAULT_BUREAU_DIRS[0];
}

export async function resolveBureauContext({ cwd = process.cwd(), env = process.env, fsImpl = fs } = {}) {
  const configuredBureauDir = env.BUREAU_DIR?.trim();
  const bureauDir = configuredBureauDir || await detectDefaultBureauDir({ cwd, fsImpl });
  return createBureauContext({ cwd, bureauDir });
}

export async function getAllTaskDirs(context, fsImpl = fs) {
  try {
    const entries = await fsImpl.readdir(context.bureauDirPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && parseTaskDirName(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    return [];
  }
}

export async function getRecentTaskDirs(context, fsImpl = fs, date = new Date()) {
  const allTaskDirs = await getAllTaskDirs(context, fsImpl);
  const cutoffDate = new Date(date);
  cutoffDate.setDate(cutoffDate.getDate() - RECENT_TASK_DAY_WINDOW);
  const cutoffDateStr = formatLocalDate(cutoffDate);

  const recentTaskDirs = allTaskDirs.filter(taskDir => {
    const parsed = parseTaskDirName(taskDir);
    return parsed && parsed.datePrefix.slice(0, 10) >= cutoffDateStr;
  });

  if (recentTaskDirs.length >= MIN_RECENT_TASKS) {
    return recentTaskDirs;
  }

  return allTaskDirs.slice(-Math.min(MIN_RECENT_TASKS, allTaskDirs.length));
}

export async function getCurrentTaskDir(context, fsImpl = fs) {
  try {
    const target = await fsImpl.readlink(context.currentLinkPath);
    const normalizedTarget = target.replace(/[\\/]+$/, '');
    return path.basename(normalizedTarget);
  } catch (error) {
    return null;
  }
}

function compareReportFiles(a, b) {
  const aNumber = Number.parseInt(a.match(/^(\d+)/)?.[1] ?? '0', 10);
  const bNumber = Number.parseInt(b.match(/^(\d+)/)?.[1] ?? '0', 10);

  if (aNumber !== bNumber) {
    return aNumber - bNumber;
  }

  return a.localeCompare(b);
}

export async function getReportFiles(context, taskDir, fsImpl = fs) {
  const taskPath = path.join(context.bureauDirPath, taskDir);

  try {
    const entries = await fsImpl.readdir(taskPath, { withFileTypes: true });
    const reportFiles = entries
      .filter(entry => entry.isFile() && REPORT_FILE_RE.test(entry.name))
      .map(entry => entry.name)
      .sort(compareReportFiles);

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

export async function getTaskInfo(context, taskDir, fsImpl = fs) {
  if (!taskDir) {
    return null;
  }

  const parsed = parseTaskDirName(taskDir);
  if (!parsed) {
    return null;
  }

  return {
    task_dir: taskDir,
    task_slug: parsed.slug,
    reports_dir: path.join(context.bureauDir, taskDir),
    report_file_names: await getReportFiles(context, taskDir, fsImpl)
  };
}

export async function findNextTaskDirName(context, slug, fsImpl = fs, date = new Date()) {
  const allTaskDirs = await getAllTaskDirs(context, fsImpl);
  const today = formatLocalDate(date);

  for (let index = 0; index < 1000; index += 1) {
    const datePrefix = getDateSuffix(index, date);
    if (!datePrefix.startsWith(today)) {
      break;
    }

    if (!allTaskDirs.some(dirName => dirName.startsWith(datePrefix))) {
      return `${datePrefix}-${slug}`;
    }
  }

  throw new Error('Too many tasks for today (max 1000)');
}

export async function updateCurrentSymlink(context, taskDir, fsImpl = fs) {
  await fsImpl.mkdir(context.bureauDirPath, { recursive: true });

  try {
    await fsImpl.unlink(context.currentLinkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await fsImpl.symlink(taskDir, context.currentLinkPath);
}

export async function findNextReportNumber(context, taskDir, fsImpl = fs) {
  const reportFiles = await getReportFiles(context, taskDir, fsImpl);
  let maxNumber = 0;

  for (const fileName of reportFiles) {
    const number = Number.parseInt(fileName.match(/^(\d+)/)?.[1] ?? '0', 10);
    if (number > maxNumber) {
      maxNumber = number;
    }
  }

  return maxNumber + 1;
}

export async function findTaskDirBySlug(context, slug, fsImpl = fs) {
  const allTaskDirs = await getAllTaskDirs(context, fsImpl);

  for (let index = allTaskDirs.length - 1; index >= 0; index -= 1) {
    const parsed = parseTaskDirName(allTaskDirs[index]);
    if (parsed?.slug === slug) {
      return allTaskDirs[index];
    }
  }

  return null;
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

export function validateTaskSlug(taskSlug) {
  if (isBlank(taskSlug)) {
    throw new Error('task_slug is required');
  }

  if (taskSlug.includes(' ') || taskSlug.includes('/')) {
    throw new Error("task_slug must not contain space or '/'");
  }
}

export function validateTaskDir(taskDir) {
  if (isBlank(taskDir)) {
    throw new Error('task_dir is required');
  }

  if (taskDir.includes('/')) {
    throw new Error("task_dir must not contain '/'");
  }

  if (!TASK_DIR_PREFIX_RE.test(taskDir)) {
    throw new Error('task_dir must start with 4 digits');
  }
}

export function validateReportSuffix(suffix) {
  if (isBlank(suffix)) {
    throw new Error('suffix is required');
  }

  if (suffix.includes(' ') || suffix.includes('/')) {
    throw new Error("suffix must not contain space or '/'");
  }
}
