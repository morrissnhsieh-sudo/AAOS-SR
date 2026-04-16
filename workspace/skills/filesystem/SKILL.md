---
name: filesystem
description: Read, write, list and search files on the local file system using native file tools.
allowed-tools: file_read file_write file_list file_search
version: 1.0.0
---

# Filesystem Skill

Use the native file tools to interact with the local file system.

## Tools

| Tool          | Purpose                                  |
| ------------- | ---------------------------------------- |
| `file_read`   | Read a file's text content               |
| `file_write`  | Write or append text to a file           |
| `file_list`   | List files and directories at a path     |
| `file_search` | Find files by name pattern under a dir   |

## Reading Files

Call `file_read` with the absolute or relative path:

```
file_read path:/home/user/notes.txt
file_read path:/home/user/data.json encoding:utf8
```

Returns `{ content, bytes }` or `{ error }`.

## Writing Files

Call `file_write` with path and content. Parent directories are created automatically:

```
file_write path:/home/user/output.txt content:"Hello, world!"
file_write path:/home/user/log.txt content:"New entry\n" append:true
```

Returns `{ ok: true, path }` or `{ error }`.

## Listing Files

Call `file_list` with a directory path. Use `recursive:true` for deep listings:

```
file_list dir:/home/user/projects
file_list dir:/home/user/projects recursive:true
```

Returns `{ entries: [{name, path, type, size?}], count }`.

## Searching Files

Call `file_search` to find files by name substring or pattern:

```
file_search dir:/home/user pattern:README
file_search dir:/home/user/code pattern:.ts
```

Returns `{ matches: [{name, path, type}], count }`.

## Guidelines

- Always use absolute paths when the user specifies a full path.
- For relative paths, resolve from the current working directory context.
- When writing sensitive content, confirm with the user before overwriting existing files.
- Show the user a clean summary of results — not the raw tool output.
- If a path does not exist, report the error clearly and suggest alternatives.
