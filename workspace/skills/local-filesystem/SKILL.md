---
name: local-filesystem
description: Use this skill when the agent needs to read, write, list, search, move, or delete files and directories on the local file system.
allowed-tools: Read Write Bash
version: 1.0.0
---

# Local File System Access

## Working Directories

| Purpose           | Path                        | Access     |
|-------------------|-----------------------------|------------|
| User uploads      | `/mnt/user-data/uploads/`   | Read-only  |
| Agent workspace   | `/home/claude/`             | Read/Write |
| Final outputs     | `/mnt/user-data/outputs/`   | Write only |
| Skills (public)   | `/mnt/skills/public/`       | Read-only  |

> ⚠️ **Never write to read-only mounts.** If you need to modify an uploaded file, copy it to `/home/claude/` first.

---

## Step 0 — Orient Before You Act

Always stat a path before reading or writing it:

```bash
stat $ARGUMENTS
file $ARGUMENTS
ls -lah /home/claude/

---

## Reading Files

### Small text files (< 20KB)
```bash
cat $ARGUMENTS
```

### Large text files (> 20KB)
```bash
wc -c $ARGUMENTS
head -100 $ARGUMENTS
tail -200 $ARGUMENTS
grep -n "ERROR" $ARGUMENTS
```

### Binary files — never cat
```bash
file $ARGUMENTS
xxd $ARGUMENTS | head -10
```

### Structured files
```bash
# JSON
jq . $ARGUMENTS
jq '.services | keys' $ARGUMENTS

# CSV (never raw cat)
python3 -c "
import pandas as pd
df = pd.read_csv('$ARGUMENTS', nrows=5)
print(df, '\\n', df.dtypes)
"
```

---

## Writing Files

### Create a new file
```bash
cat > $ARGUMENTS << 'EOF'
your content here
EOF
```

### Append to a file
```bash
echo "new line" >> $ARGUMENTS
```

### Write from Python
```python
with open("$ARGUMENTS", "w") as f:
    import json
    json.dump(data, f, indent=2)
```

### Copy an upload before editing
```bash
cp /mnt/user-data/uploads/$ARGUMENTS /home/claude/$ARGUMENTS
```

---

## Listing & Searching

```bash
# List directory (2 levels)
find $ARGUMENTS -maxdepth 2 | sort

# Find by name
find $ARGUMENTS -name "*.json"

# Find by modification time (last 24h)
find $ARGUMENTS -mtime -1

# Search content across files
grep -r "keyword" $ARGUMENTS --include="*.py" -l
grep -rn "keyword" $ARGUMENTS --include="*.py"
```

---

## Moving & Deleting

```bash
# Move / rename
mv $ARGUMENTS $ARGUMENTS

# Copy
cp $ARGUMENTS $ARGUMENTS

# Delete (no recycle bin — confirm intent before deleting)
rm $ARGUMENTS
rm -rf $ARGUMENTS
```

---

## Publishing Output

When a file is ready for the user, copy it to the outputs directory:

```bash
cp /home/claude/$ARGUMENTS /mnt/user-data/outputs/$ARGUMENTS
```

Then call `present_files` with the output path. Without this step, the user cannot access the file.

---

## Safety Rules

1. **Never write to `/mnt/user-data/uploads/` or `/mnt/skills/`** — they are read-only mounts.
2. **Always stat before writing** to avoid overwriting something important.
3. **Never `cat` a binary** — use `file`, `xxd`, or the appropriate parser.
4. **Never auto-extract archives** — list contents first with `unzip -l` or `tar -tf`, then extract only what's needed.
5. **For file type dispatch** (PDF, DOCX, XLSX, PPTX) — defer to `/mnt/skills/public/file-reading/SKILL.md`.
```
