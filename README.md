# Bureau MCP Server

A Model Context Protocol (MCP) server that helps AI agents reliably manage task-based report files with automatic sequential numbering and consistent directory organization.

## Why Bureau?

AI agents struggle to maintain consistent file numbering and folder organization when managing multi-step tasks. They often:
- Mess up sequential numbering
- Switch to new folders unexpectedly
- Lose track of which task is current

Bureau solves this by managing the directory structure and file numbering, while letting agents focus on reading and writing content.

## Features

- **Automatic Task Directory Management** - Creates dated task folders with automatic suffix handling (2025-10-01, 2025-10-01b, 2025-10-01c, etc.)
- **Sequential Report Numbering** - Generates next available report file numbers automatically
- **Current Task Tracking** - Maintains a `current` symlink pointing to the active task
- **Smart File Listing** - Returns all files if <50, or earliest 20 + latest 30 for efficiency
- **Recent Tasks** - Lists tasks from the last 30 days
- **Minimal Dependencies** - Built with only essential packages

## Directory Structure

Bureau creates and manages a `_tasks/` directory in your project:

```
_tasks/
├── current -> 2025-10-01-implement-feature
├── 2025-10-01-implement-feature/
│   ├── 001-user-request.md
│   ├── 002-plan.md
│   ├── 003-implementation.md
│   └── 004-tests.md
├── 2025-10-01b-fix-bug/
│   ├── 001-bug-report.md
│   └── 002-fix.md
└── 2025-10-02-refactor/
    ├── 001-analysis.md
    └── 002-plan.md
```

## Installation

### Using with Claude Code

**Option 1: CLI (recommended)**
```bash
claude mcp add-json bureau '{"command":"npx","args":["-y","bureau-mcp"]}' --scope user
```

**Option 2: Manual configuration**

Edit `~/.claude.json`:
```json
{
  "mcpServers": {
    "bureau": {
      "command": "npx",
      "args": ["-y", "bureau-mcp"]
    }
  }
}
```

### Using with Claude Desktop

Add to your `claude_desktop_config.json`:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bureau": {
      "command": "npx",
      "args": ["-y", "bureau-mcp"]
    }
  }
}
```

### Local Development

```bash
git clone https://github.com/andreyvit/bureau-mcp.git
cd bureau-mcp
npm install
```

Then configure with the full path:
```json
{
  "mcpServers": {
    "bureau": {
      "command": "node",
      "args": ["/path/to/bureau-mcp/index.js"]
    }
  }
}
```

## Available Tools

### `current_task`
Returns information about the current task.

**Returns:**
```json
{
  "task_slug": "implement-feature",
  "reports_dir": "_tasks/2025-10-01-implement-feature",
  "report_file_names": ["001-user-request.md", "002-plan.md"]
}
```

### `start_new_task`
Creates a new task directory and makes it current.

**Parameters:**
- `task_slug` (string): Slug for the task (e.g., "implement-feature")

**Returns:** Same format as `current_task()`

### `switch_task`
Switches to an existing task by slug.

**Parameters:**
- `task_slug` (string): Slug of the task to switch to

**Returns:** Same format as `current_task()`

### `list_recent_tasks`
Lists all tasks from the last 30 days.

**Returns:**
```json
{
  "recent_task_slugs": ["implement-feature", "fix-bug", "refactor"]
}
```

### `start_new_report_file`
Returns the name for the next sequentially numbered report file.

**Parameters:**
- `suffix` (string): Suffix for the report file (e.g., "code-review")

**Returns:**
```json
{
  "report_file_to_create": "_tasks/2025-10-01-implement-feature/003-code-review.md"
}
```

## Typical Workflow

1. **Agent starts a new task:**
   - Calls `start_new_task({task_slug: "implement-feature"})`
   - Gets back the task directory path

2. **Agent creates initial report:**
   - Calls `start_new_report_file({suffix: "user-request"})`
   - Writes content to the returned filepath

3. **Agent continues work:**
   - Calls `current_task()` to see existing reports
   - Reads report files as needed
   - Calls `start_new_report_file()` for new reports
   - Writes new content

4. **Agent switches between tasks:**
   - Calls `list_recent_tasks()` to see options
   - Calls `switch_task({task_slug: "fix-bug"})` to change tasks

## Task Directory Naming

Task directories follow the pattern: `YYYY-MM-DDn-slug-slug-slug`

- First task of the day: `2025-10-01-first-task`
- Second task same day: `2025-10-01b-second-task`
- Third task same day: `2025-10-01c-third-task`
- Up to 26 tasks per day (a-z)

## Development

**Run tests:**
```bash
npm test
```

**Start server locally:**
```bash
npm start
```

The server uses Node.js built-in test runner and `memfs` for filesystem mocking in tests.

## Requirements

- Node.js >= 18.0.0

## License

MIT

## Contributing

Contributions welcome! Please open an issue or submit a pull request.

## Repository

https://github.com/andreyvit/bureau-mcp
