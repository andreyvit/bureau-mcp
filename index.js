#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  findNextReportNumber,
  findNextTaskDirName,
  findTaskDirBySlug,
  getCurrentTaskDir,
  getRecentTaskDirs,
  getTaskInfo,
  newReportFileName,
  parseTaskDirName,
  resolveBureauContext,
  updateCurrentSymlink,
  validateReportSuffix,
  validateTaskDir,
  validateTaskSlug
} from './bureau.js';

export function listTools() {
  return [
    {
      name: 'current_task',
      description: 'Returns current task info including task dir, task slug, reports directory, and report file names',
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
            description: 'Slug for the task (for example, "some-urgent-task")'
          }
        },
        required: ['task_slug']
      }
    },
    {
      name: 'switch_task',
      description: 'Switches current task to an existing task by full task dir or by slug',
      inputSchema: {
        type: 'object',
        properties: {
          task_dir: {
            type: 'string',
            description: 'Full task directory name (for example, "2025-10-01-fix-bug")'
          },
          task_slug: {
            type: 'string',
            description: 'Slug of the task to switch to'
          }
        },
        required: []
      }
    },
    {
      name: 'list_recent_tasks',
      description: 'Lists tasks from the last 60 days, backfilled to at least 30 task directories when available',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'start_new_report_file',
      description: 'Returns the name of the next sequentially numbered report file; create or touch this file before calling again to avoid duplicate numbers',
      inputSchema: {
        type: 'object',
        properties: {
          suffix: {
            type: 'string',
            description: 'Suffix for the report file (for example, "code-review")'
          }
        },
        required: ['suffix']
      }
    }
  ];
}

function buildResponse(payload, isError = false) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload, null, 2)
    }],
    ...(isError ? { isError: true } : {})
  };
}

export async function handleToolCall(name, args = {}, options = {}) {
  const { cwd = process.cwd(), env = process.env, fsImpl = fs } = options;
  const context = await resolveBureauContext({ cwd, env, fsImpl });

  switch (name) {
    case 'current_task': {
      const taskDir = await getCurrentTaskDir(context, fsImpl);
      const taskInfo = await getTaskInfo(context, taskDir, fsImpl);

      if (!taskInfo) {
        return buildResponse({ error: 'No current task' });
      }

      return buildResponse(taskInfo);
    }

    case 'start_new_task': {
      validateTaskSlug(args.task_slug);

      const taskDirName = await findNextTaskDirName(context, args.task_slug, fsImpl);
      await fsImpl.mkdir(path.join(context.bureauDirPath, taskDirName), { recursive: true });
      await updateCurrentSymlink(context, taskDirName, fsImpl);

      return buildResponse(await getTaskInfo(context, taskDirName, fsImpl));
    }

    case 'switch_task': {
      const taskDirArg = args.task_dir || (typeof args.task_slug === 'string' && /^\d{4}/.test(args.task_slug) ? args.task_slug : null);
      let taskDir = taskDirArg;

      if (taskDir) {
        validateTaskDir(taskDir);
      } else {
        validateTaskSlug(args.task_slug);
        taskDir = await findTaskDirBySlug(context, args.task_slug, fsImpl);
      }

      if (!taskDir) {
        throw new Error(`Task not found: ${args.task_slug}`);
      }

      let taskStats;
      try {
        taskStats = await fsImpl.stat(path.join(context.bureauDirPath, taskDir));
      } catch (error) {
        taskStats = null;
      }

      if (!taskStats?.isDirectory()) {
        throw new Error(`Task not found: ${taskDir}`);
      }

      await updateCurrentSymlink(context, taskDir, fsImpl);
      return buildResponse(await getTaskInfo(context, taskDir, fsImpl));
    }

    case 'list_recent_tasks': {
      const recentTaskDirs = await getRecentTaskDirs(context, fsImpl);
      return buildResponse({
        recent_task_dirs: recentTaskDirs,
        recent_task_slugs: recentTaskDirs
          .map(taskDir => parseTaskDirName(taskDir)?.slug)
          .filter(Boolean)
      });
    }

    case 'start_new_report_file': {
      validateReportSuffix(args.suffix);

      const taskDir = await getCurrentTaskDir(context, fsImpl);
      if (!taskDir) {
        throw new Error('No current task');
      }

      const nextNumber = await findNextReportNumber(context, taskDir, fsImpl);
      return buildResponse({
        report_file_to_create: path.join(context.bureauDir, taskDir, newReportFileName(nextNumber, args.suffix))
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  {
    name: 'bureau-mcp',
    version: '1.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    return await handleToolCall(request.params.name, request.params.arguments ?? {});
  } catch (error) {
    return buildResponse({ error: error.message }, true);
  }
});

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
