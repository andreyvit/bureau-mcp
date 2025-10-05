#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';

const TASKS_DIR = path.join(process.cwd(), '_tasks');
const CURRENT_LINK = path.join(TASKS_DIR, 'current');

// Utility: Generate date suffix (YYYY-MM-DD, then YYYY-MM-DDb, YYYY-MM-DDc, ...)
function getDateSuffix(index) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  if (index === 0) return dateStr;
  // a=97, so index 1 -> 'b', index 2 -> 'c', etc.
  return dateStr + String.fromCharCode(97 + index);
}

// Utility: Parse task directory name to extract date and slug
function parseTaskDirName(dirName) {
  // Pattern: YYYY-MM-DD[b-z]-slug or YYYY-MM-DD-slug
  const match = dirName.match(/^(\d{4}-\d{2}-\d{2}[b-z]?)-(.+)$/);
  if (!match) return null;
  return { datePrefix: match[1], slug: match[2] };
}

// Utility: Get all task directories
async function getAllTaskDirs() {
  try {
    await fs.mkdir(TASKS_DIR, { recursive: true });
    const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && parseTaskDirName(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    return [];
  }
}

// Utility: Get task directories from last 30 days
async function getRecentTaskDirs() {
  const allDirs = await getAllTaskDirs();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoffStr = thirtyDaysAgo.toISOString().split('T')[0];

  return allDirs.filter(dirName => {
    const parsed = parseTaskDirName(dirName);
    if (!parsed) return false;
    // Extract just the date part (YYYY-MM-DD)
    const dateOnly = parsed.datePrefix.replace(/[b-z]$/, '');
    return dateOnly >= cutoffStr;
  });
}

// Utility: Read current task from symlink
async function getCurrentTaskDir() {
  try {
    const target = await fs.readlink(CURRENT_LINK);
    // target might be relative or absolute, normalize it
    const targetPath = path.isAbsolute(target) ? target : path.join(TASKS_DIR, target);
    const dirName = path.basename(targetPath);
    return dirName;
  } catch (error) {
    return null;
  }
}

// Utility: Get report files in a task directory
async function getReportFiles(taskDir) {
  const taskPath = path.join(TASKS_DIR, taskDir);
  try {
    const entries = await fs.readdir(taskPath);
    // Filter for numbered markdown files (e.g., 001-*.md, 002-*.md)
    const reportFiles = entries
      .filter(name => /^\d{3}-.*\.md$/.test(name))
      .sort();

    // Return all if <50, or earliest 20 + latest 30
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

// Utility: Get task info
async function getTaskInfo(taskDir) {
  if (!taskDir) {
    return null;
  }

  const parsed = parseTaskDirName(taskDir);
  if (!parsed) {
    return null;
  }

  const reportFiles = await getReportFiles(taskDir);
  return {
    task_slug: parsed.slug,
    reports_dir: path.join('_tasks', taskDir),
    report_file_names: reportFiles
  };
}

// Utility: Find next available task directory name
async function findNextTaskDirName(slug) {
  const allDirs = await getAllTaskDirs();
  const today = new Date().toISOString().split('T')[0];

  // Try without suffix first, then b, c, d, ..., z
  for (let i = 0; i < 26; i++) {
    const datePrefix = getDateSuffix(i);
    if (!datePrefix.startsWith(today)) break; // Safety check

    const candidateName = `${datePrefix}-${slug}`;
    if (!allDirs.includes(candidateName)) {
      return candidateName;
    }
  }

  throw new Error('Too many tasks for today (max 26)');
}

// Utility: Update current symlink
async function updateCurrentSymlink(taskDir) {
  const targetPath = path.join(TASKS_DIR, taskDir);

  // Remove existing symlink if it exists
  try {
    await fs.unlink(CURRENT_LINK);
  } catch (error) {
    // Ignore if doesn't exist
  }

  // Create new symlink (use relative path)
  await fs.symlink(taskDir, CURRENT_LINK);
}

// Utility: Find next report file number
async function findNextReportNumber(taskDir) {
  const reportFiles = await getReportFiles(taskDir);
  if (reportFiles.length === 0) {
    return 1;
  }

  // Extract numbers from all report files
  const numbers = reportFiles.map(name => {
    const match = name.match(/^(\d{3})-/);
    return match ? parseInt(match[1], 10) : 0;
  });

  const maxNumber = Math.max(...numbers);
  return maxNumber + 1;
}

// Utility: Find task directory by slug
async function findTaskDirBySlug(slug) {
  const allDirs = await getAllTaskDirs();

  // Find the most recent directory with matching slug
  for (let i = allDirs.length - 1; i >= 0; i--) {
    const parsed = parseTaskDirName(allDirs[i]);
    if (parsed && parsed.slug === slug) {
      return allDirs[i];
    }
  }

  return null;
}

// Create MCP server
const server = new Server(
  {
    name: 'bureaumcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'current_task',
        description: 'Returns current task info including task slug, reports directory, and report file names',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'start_new_task',
        description: 'Creates a new task directory and makes it the current task',
        inputSchema: {
          type: 'object',
          properties: {
            task_slug: {
              type: 'string',
              description: 'Slug for the task (e.g., "some-urgent-task")'
            }
          },
          required: ['task_slug']
        }
      },
      {
        name: 'switch_task',
        description: 'Switches current task to the specified one',
        inputSchema: {
          type: 'object',
          properties: {
            task_slug: {
              type: 'string',
              description: 'Slug of the task to switch to'
            }
          },
          required: ['task_slug']
        }
      },
      {
        name: 'list_recent_tasks',
        description: 'Lists all task directories from the last 30 days',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'start_new_report_file',
        description: 'Returns the name of the next sequentially numbered report file',
        inputSchema: {
          type: 'object',
          properties: {
            suffix: {
              type: 'string',
              description: 'Suffix for the report file (e.g., "code-review")'
            }
          },
          required: ['suffix']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'current_task': {
        const taskDir = await getCurrentTaskDir();
        const taskInfo = await getTaskInfo(taskDir);

        if (!taskInfo) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'No current task' }, null, 2)
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(taskInfo, null, 2)
          }]
        };
      }

      case 'start_new_task': {
        const { task_slug } = args;
        if (!task_slug) {
          throw new Error('task_slug is required');
        }

        const taskDirName = await findNextTaskDirName(task_slug);
        const taskPath = path.join(TASKS_DIR, taskDirName);
        await fs.mkdir(taskPath, { recursive: true });
        await updateCurrentSymlink(taskDirName);

        const taskInfo = await getTaskInfo(taskDirName);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(taskInfo, null, 2)
          }]
        };
      }

      case 'switch_task': {
        const { task_slug } = args;
        if (!task_slug) {
          throw new Error('task_slug is required');
        }

        const taskDir = await findTaskDirBySlug(task_slug);
        if (!taskDir) {
          throw new Error(`Task not found: ${task_slug}`);
        }

        await updateCurrentSymlink(taskDir);
        const taskInfo = await getTaskInfo(taskDir);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(taskInfo, null, 2)
          }]
        };
      }

      case 'list_recent_tasks': {
        const recentDirs = await getRecentTaskDirs();
        const slugs = recentDirs.map(dirName => {
          const parsed = parseTaskDirName(dirName);
          return parsed ? parsed.slug : null;
        }).filter(Boolean);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ recent_task_slugs: slugs }, null, 2)
          }]
        };
      }

      case 'start_new_report_file': {
        const { suffix } = args;
        if (!suffix) {
          throw new Error('suffix is required');
        }

        const taskDir = await getCurrentTaskDir();
        if (!taskDir) {
          throw new Error('No current task');
        }

        const nextNumber = await findNextReportNumber(taskDir);
        const fileName = `${String(nextNumber).padStart(3, '0')}-${suffix}.md`;
        const filePath = path.join('_tasks', taskDir, fileName);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ report_file_to_create: filePath }, null, 2)
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Connect to stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
