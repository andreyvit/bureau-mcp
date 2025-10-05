# bureaumcp

Bureau is an MCP server in Node.js using the minimum number of third-party dependencies (only whatever's necessary to implement MCP servers, don't use third-party test libs etc etc).

This server helps agents read and write report files with the following naming convention:

```
_tasks/2025-10-01-some-urgent-task/001-user-request.md
_tasks/2025-10-01-some-urgent-task/002-plan.md
_tasks/2025-10-01-some-urgent-task/003-plan-review.md
_tasks/2025-10-01-some-urgent-task/004-tests.md
...
_tasks/2025-10-01-some-urgent-task/007-code-review.md
_tasks/2025-10-01-some-urgent-task/008-plan.md
_tasks/2025-10-01-some-urgent-task/009-user-revision.md
...
```

You get the idea: we have a folder for a task, and within that folder, keep sequentially numbered files.

The reason this MCP exists is because agents cannot do this reliably. They keep messing up the numbering or keep switching to new folders. We want agents to handle reading and writing of files themselves, they do this best; we'll just help them find those files.

Naming convention for task dirs: YYYY-MM-DDn-slug-slug-slug, where 'n' is empty for the first task of the day, and then goes b, c, ..., x, y, z. So e.g. 2025-10-01-first-task, then 2025-10-01b-second-task, 2025-10-01c-another-item, etc.

_tasks/current symlink should be kept pointing to the current task, if any.

Tools:

```
// returns current task info; 'report_file_names' will contain all files if less than 50, or earliest 20 and latest 30 if over 50.
current_task() -> {'task_slug': 'some-urgent-task', 'reports_dir': '_tasks/2025-10-01-some-urgent-task', 'report_file_names': ['001-user-request.md', '02-plan.md', '003-plan-review.md', '004-tests.md', '005-impl.md', '006-docs.md']}

// creates a new task directory and points current to it; returns same data as current_task()
start_new_task({'task_slug': 'some-urgent-task'}) -> {'task_slug': 'some-urgent-task', 'reports_dir': '_tasks/2025-10-01-some-urgent-task', 'report_file_names': []}
// switches current to point to the given task; returns same data as current_task()
switch_task({'task_slug': 'some-urgent-task'}) -> {'task_slug': 'some-urgent-task', 'reports_dir': '_tasks/2025-10-01-some-urgent-task', 'report_file_names': ['001-user-request.md', '02-plan.md', '003-plan-review.md', '004-tests.md', '005-impl.md', '006-docs.md']}

// lists all task directories >= now minus 30 days (or now minus 1 month, or similar, whichever is easier to implement)
list_recent_tasks() -> {"recent_task_slugs": ['prior-urgent-task', 'some-urgent-task']}

// returns the name of the next sequentially numbered report file; the file will not exist
start_new_report_file({'suffix': 'code-review'}) -> {'report_file_to_create': '_tasks/2025-10-01-some-urgent-task/007-code-review.md'}
```

The agent is supposed to invoke current_task(), then read the report files it wants, then do its work, then call start_new_report_file() and write out the report to that file.
