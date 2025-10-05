# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bureau is an MCP (Model Context Protocol) server implemented in Node.js that helps agents manage task-based report files. The server solves a specific problem: agents struggle to reliably maintain sequential numbering and consistent folder organization when managing task reports.

## Commands

**Run the MCP server:**
```bash
npm start
```

**Run tests:**
```bash
npm test
```

**Install dependencies:**
```bash
npm install
```

## Architecture

### Core Functionality

The server manages a `_tasks/` directory structure in the current working directory (where the MCP server is invoked):
- Task directories named using pattern: `YYYY-MM-DDn-slug-slug-slug`
  - Date format: `YYYY-MM-DD` for first task of the day
  - Additional tasks same day: append `b`, `c`, ..., `z` (e.g., `2025-10-01b-second-task`)
- Sequential numbered report files within each task directory (e.g., `001-user-request.md`, `002-plan.md`)
- `_tasks/current` symlink pointing to the active task directory

### Implementation Details

**Main file:** `index.js` - Single file implementation containing:
- Utility functions for date suffix generation, directory scanning, report numbering, and symlink management
- MCP server setup using `@modelcontextprotocol/sdk`
- Stdio transport for communication
- Tool handlers for all 5 MCP tools

**Test file:** `tools.test.js` - Comprehensive tests using:
- Node.js built-in test runner (`node:test`)
- `memfs` for mocking filesystem operations
- Tests for all utility functions and tool behaviors

### MCP Tools

1. **current_task()** - Returns current task information
   - Returns: `{task_slug, reports_dir, report_file_names}`
   - If >50 files: return earliest 20 + latest 30

2. **start_new_task({task_slug})** - Creates new task directory, updates current symlink
   - Returns: same format as current_task()

3. **switch_task({task_slug})** - Points current symlink to specified task
   - Returns: same format as current_task()

4. **list_recent_tasks()** - Lists tasks from last 30 days
   - Returns: `{recent_task_slugs: [...]}`

5. **start_new_report_file({suffix})** - Generates next sequential report filename
   - Returns: `{report_file_to_create: '...'}`
   - File does not exist yet (agent will create it)

### Dependency Philosophy

- Minimal third-party dependencies
- Only `@modelcontextprotocol/sdk` for MCP server implementation
- Only `memfs` as dev dependency for testing
- Use Node.js built-in modules (`fs/promises`, `path`) for all file operations
- Use Node.js built-in test runner (no jest/mocha/vitest)

### Workflow Pattern

Typical agent workflow using this server:
1. Call `current_task()` to get task context
2. Read necessary report files directly (not via MCP)
3. Perform work
4. Call `start_new_report_file({suffix})` to get next filename
5. Write report to the returned filepath
