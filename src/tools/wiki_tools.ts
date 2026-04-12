/**
 * AAOS Wiki — Karpathy-style compiled knowledge base.
 *
 * Three-layer architecture:
 *   sources/   — immutable raw ingested content (URL snapshots, pasted text)
 *   pages/     — LLM-compiled structured Markdown wiki pages
 *   SCHEMA.md  — rules and templates the LLM compiler follows
 *
 * Workflow: Ingest → Compile → Write → Search → Lint
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execSync } from 'child_process';
import { register_tool } from './tool_dispatcher';
import { invoke_for_role } from '../plugins/plugin_engine';

// ── Binary document text extraction ───────────────────────────────────────────

/** Strip XML/HTML tags from a string, collapsing whitespace. */
function strip_xml(xml: string): string {
    return xml
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x[0-9a-f]+;/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Normalise a path for use in shell commands on this system (forward slashes, no WSL conversion). */
function to_shell_path(winPath: string): string {
    // Keep as Windows path but use forward slashes — works with pdftotext, unzip (Git Bash builds)
    return winPath.replace(/\\/g, '/');
}

/**
 * Extract readable text from a binary file.
 * Supports:
 *   .pdf   → pdftotext (text PDFs) or PyMuPDF+Gemini Vision OCR (scanned image PDFs)
 *   .docx  → unzip + XML tag stripping
 *   .xlsx  → unzip + sharedStrings XML stripping
 * Returns null if extraction is not possible.
 */
function extract_binary_text(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    const shellPath = to_shell_path(filePath);

    try {
        if (ext === '.pdf') {
            // First attempt: pdftotext (works on text-layer PDFs)
            let text = '';
            try {
                text = execSync(`pdftotext -layout "${shellPath}" -`, { timeout: 30000 }).toString('utf8').trim();
            } catch { /* pdftotext not available or failed */ }

            if (text) return text;

            // Fallback: scanned/image-only PDF — use PyMuPDF to render pages then Gemini Vision OCR
            console.log(`[Wiki] PDF has no text layer — falling back to Vision OCR for ${path.basename(filePath)}`);
            return extract_scanned_pdf_via_vision(filePath);
        }

        if (ext === '.docx' || ext === '.doc') {
            // DOCX is a ZIP; word/document.xml contains the body text
            const xml = execSync(`unzip -p "${shellPath}" word/document.xml 2>/dev/null`, { timeout: 15000 }).toString('utf8');
            const text = strip_xml(xml);
            return text || null;
        }

        if (ext === '.xlsx' || ext === '.xls') {
            // XLSX is a ZIP; xl/sharedStrings.xml has cell text content
            let text = '';
            try {
                const ss = execSync(`unzip -p "${shellPath}" xl/sharedStrings.xml 2>/dev/null`, { timeout: 15000 }).toString('utf8');
                text += strip_xml(ss) + '\n';
            } catch { /* no shared strings */ }
            try {
                const wb = execSync(`unzip -p "${shellPath}" xl/workbook.xml 2>/dev/null`, { timeout: 15000 }).toString('utf8');
                const sheets = [...wb.matchAll(/name="([^"]+)"/g)].map(m => m[1]).join(', ');
                if (sheets) text = `Sheets: ${sheets}\n` + text;
            } catch { /* ignore */ }
            return text.trim() || null;
        }

        return null; // unsupported type
    } catch (err: any) {
        console.warn(`[Wiki] Binary extract failed for ${filePath}: ${err.message}`);
        return null;
    }
}

/**
 * For scanned PDFs (no text layer): render pages to PNG via PyMuPDF then OCR with Gemini Vision.
 * Returns extracted text or null on failure.
 */
function extract_scanned_pdf_via_vision(filePath: string): string | null {
    const WINDOWS_PYTHON = (() => {
        if (process.platform !== 'win32') return 'python3';
        try {
            const r = execSync('where python', { shell: 'cmd.exe' as any, timeout: 3000, encoding: 'utf8' } as any);
            const lines = (r as string).trim().split(/\r?\n/).filter((l: string) => l.toLowerCase().endsWith('.exe') && !l.includes('WindowsApps'));
            if (lines.length > 0) return lines[0].trim();
        } catch { /* fall through */ }
        for (const p of ['C:\\Python314\\python.exe', 'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe']) {
            try { if (require('fs').existsSync(p)) return p; } catch { /* ignore */ }
        }
        return 'python';
    })();

    const MAX_PAGES = 6; // limit to first N pages to avoid token blowup
    const pyScript = `
import sys, json, base64, fitz, tempfile, os

pdf_path = sys.argv[1]
max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 6

doc = fitz.open(pdf_path)
pages_data = []
tmp_dir = tempfile.mkdtemp()

for i in range(min(max_pages, len(doc))):
    page = doc[i]
    mat = fitz.Matrix(2.0, 2.0)  # 2x zoom for better OCR quality
    pix = page.get_pixmap(matrix=mat)
    img_path = os.path.join(tmp_dir, f"page_{i+1}.png")
    pix.save(img_path)
    with open(img_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode('utf-8')
    pages_data.append({"page": i+1, "b64": b64, "total_pages": len(doc)})
    os.unlink(img_path)

os.rmdir(tmp_dir)
print(json.dumps({"ok": True, "pages": pages_data, "total": len(doc)}))
`;

    const tmpScript = path.join(os.tmpdir(), `aaos_pdf_render_${Date.now()}.py`);
    try {
        fs.writeFileSync(tmpScript, pyScript, 'utf8');
        const raw = execSync(
            `"${WINDOWS_PYTHON}" "${tmpScript}" "${filePath}" ${MAX_PAGES}`,
            { timeout: 60000, maxBuffer: 80 * 1024 * 1024 }
        ).toString('utf8').trim();
        try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }

        const result = JSON.parse(raw);
        if (!result.ok || !result.pages?.length) return null;

        // Send each page image to Gemini Vision for OCR
        const { GoogleGenAI } = require('@google/genai') as typeof import('@google/genai');
        const vertexAI = new GoogleGenAI({
            vertexai: true,
            project: process.env.VERTEX_PROJECT_ID || '',
            location: process.env.VERTEX_LOCATION  || 'us-central1',
        });
        const model = process.env.VERTEX_MODEL || 'gemini-2.0-flash';

        // Note: This is sync-context glue — we run OCR synchronously using execSync calling a second python script
        // that just returns the base64 pages. Then we return a marker for async handling.
        // Since extract_binary_text is sync and Gemini calls are async, we return a special sentinel
        // and let wiki_ingest handle the async Vision call directly.
        // Store the page images for async consumption.
        const pagesB64: string[] = result.pages.map((p: any) => p.b64);
        const totalPages: number = result.total;
        // Write temp file with base64 pages for async pickup
        const tmpData = path.join(os.tmpdir(), `aaos_pdf_pages_${Date.now()}.json`);
        fs.writeFileSync(tmpData, JSON.stringify({ pagesB64, totalPages, filePath }), 'utf8');
        // Return sentinel that wiki_ingest's async handler will detect and expand
        return `__SCANNED_PDF_VISION__:${tmpData}`;
    } catch (err: any) {
        try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
        console.warn(`[Wiki] PyMuPDF render failed for ${path.basename(filePath)}: ${err.message}`);
        return null;
    }
}

/**
 * Read page images written by extract_scanned_pdf_via_vision, send to Gemini Vision for OCR,
 * and return the concatenated text. Cleans up the temp file when done.
 */
async function ocr_pdf_pages_via_gemini(tmpDataPath: string): Promise<string | null> {
    try {
        const { pagesB64, totalPages, filePath } = JSON.parse(fs.readFileSync(tmpDataPath, 'utf8'));
        try { fs.unlinkSync(tmpDataPath); } catch { /* ignore */ }

        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.VERTEX_PROJECT_ID || '',
            location: process.env.VERTEX_LOCATION  || 'us-central1',
        });
        const model = process.env.VERTEX_MODEL || 'gemini-2.0-flash';
        const basename = path.basename(filePath as string);

        const pageTexts: string[] = [];
        for (let i = 0; i < (pagesB64 as string[]).length; i++) {
            const b64 = (pagesB64 as string[])[i];
            const prompt = `This is page ${i + 1} of ${totalPages} from the document "${basename}". Extract ALL text exactly as it appears. Include titles, headers, body text, tables, signatures, dates, certificate numbers — everything visible. Output plain text only, preserving the natural reading order.`;
            try {
                const result = await ai.models.generateContent({
                    model,
                    contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType: 'image/png', data: b64 } },
                            { text: prompt }
                        ]
                    }]
                });
                const text = result.candidates?.[0]?.content?.parts
                    ?.filter((p: any) => p.text).map((p: any) => p.text).join('') || '';
                if (text.trim()) pageTexts.push(`--- Page ${i + 1} ---\n${text.trim()}`);
            } catch (err: any) {
                console.warn(`[Wiki] Vision OCR failed for page ${i + 1}: ${err.message}`);
            }
        }

        if (pageTexts.length === 0) return null;
        return `[Scanned PDF — ${pageTexts.length}/${totalPages} pages extracted via Vision OCR]\n\n${pageTexts.join('\n\n')}`;
    } catch (err: any) {
        console.warn(`[Wiki] ocr_pdf_pages_via_gemini failed: ${err.message}`);
        try { fs.unlinkSync(tmpDataPath); } catch { /* ignore */ }
        return null;
    }
}

/** Translate WSL / Git-Bash / ~ paths to native Windows paths when running on Windows. */
function resolve_path(inputPath: string): string {
    if (process.platform !== 'win32') return inputPath;
    let p = inputPath.trim();
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = path.join(os.homedir(), p.slice(1));
    }
    const wslMatch = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
    if (wslMatch) {
        const drive = wslMatch[1].toUpperCase();
        const rest  = (wslMatch[2] || '').replace(/\//g, path.sep);
        return `${drive}:${rest || path.sep}`;
    }
    const gitBashMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (gitBashMatch) {
        const drive = gitBashMatch[1].toUpperCase();
        const rest  = (gitBashMatch[2] || '').replace(/\//g, path.sep);
        return `${drive}:${rest || path.sep}`;
    }
    return p;
}

// ── Paths ──────────────────────────────────────────────────────────────────────

export function get_wiki_dir(): string {
    const workspace = process.env.AAOS_WORKSPACE ||
        path.join(process.env.HOME || process.env.USERPROFILE || '', '.aaos');
    return path.join(workspace, 'wiki');
}

function pages_dir(): string { return path.join(get_wiki_dir(), 'pages'); }
function sources_dir(): string { return path.join(get_wiki_dir(), 'sources'); }
function schema_path(): string { return path.join(get_wiki_dir(), 'SCHEMA.md'); }

// ── Default schema ─────────────────────────────────────────────────────────────

const DEFAULT_SCHEMA = `# AAOS Wiki Schema

## Purpose
This wiki is a compiled knowledge base maintained by AAOS. Unlike raw document storage,
knowledge here has been actively integrated, cross-referenced, and structured by the LLM.
When new information is ingested, the LLM acts as a compiler — extracting key concepts,
reconciling conflicts, and weaving new knowledge into the existing structure.

## Page Types & File Locations

### Concept Pages — \`concepts/CONCEPT-NAME.md\`
Define key ideas, techniques, methodologies, or technologies.

\`\`\`markdown
# Concept Name
**Category:** [category]
**Related:** [[concepts/other-concept]], [[entities/person-name]]

## Definition
[Concise 1-3 sentence definition]

## Key Points
- [key point 1]
- [key point 2]

## Details
[Deeper explanation, examples, nuances]

## Connections
[How this connects to other wiki pages]

## Conflicting Views
[If sources disagree, note both perspectives here]

## Sources
- [title or URL]
\`\`\`

### Entity Pages — \`entities/ENTITY-NAME.md\`
Track people, organizations, projects, or products.

\`\`\`markdown
# Entity Name
**Type:** Person | Organization | Project | Product
**Related:** [[concepts/related-concept]]

## Overview
[Brief description]

## Key Contributions / Facts
- [fact 1]

## Sources
- [source]
\`\`\`

### Topic Pages — \`topics/TOPIC-NAME.md\`
Broad subject areas that index and link many related concepts and entities.

\`\`\`markdown
# Topic Name

## Overview
[What this topic covers]

## Key Concepts
- [[concepts/concept-a]]: [one line]
- [[concepts/concept-b]]: [one line]

## Key Entities
- [[entities/person-a]]: [one line]

## Subtopics
- [subtopic 1]
\`\`\`

### Summary Pages — \`summaries/SOURCE-NAME.md\`
Compiled summaries of specific ingested sources.

\`\`\`markdown
# Summary: [Source Title]
**Source:** [URL or reference]
**Author:** [if known]
**Date:** [if known]
**Type:** Article | Paper | Talk | Book | Code

## Overview
[2-3 sentence summary of what this source covers]

## Key Takeaways
- [takeaway 1]
- [takeaway 2]

## Key Concepts Introduced
- [[concepts/concept-name]]: [how it appears in this source]

## Notable Quotes
> [quote if relevant]

## Connections to Existing Knowledge
[How this source relates to or updates existing wiki pages]
\`\`\`

## Compiler Rules
1. **Never duplicate** — link to existing pages with [[path/page-name]] instead of repeating content.
2. **Update existing pages** rather than creating redundant ones. Output the full updated content.
3. **Use [[path/page-name]]** syntax (without .md) for all internal cross-references.
4. **Reconcile conflicts** explicitly — if new info contradicts existing, add a "Conflicting Views" section.
5. **Cite sources** — note the origin of claims in every page.
6. **Keep definitions concise** — move deep detail to sub-sections.
7. **Page names**: lowercase, hyphenated (e.g., \`machine-learning\`, \`andrej-karpathy\`).
8. **A single ingest typically creates 2-6 pages**: at least one summary + relevant concept/entity pages.
`;

// ── Filesystem helpers ─────────────────────────────────────────────────────────

export function ensure_wiki_structure(): void {
    fs.mkdirSync(pages_dir(), { recursive: true });
    fs.mkdirSync(sources_dir(), { recursive: true });
    if (!fs.existsSync(schema_path())) {
        fs.writeFileSync(schema_path(), DEFAULT_SCHEMA, 'utf8');
        console.log('[Wiki] Created default SCHEMA.md');
    }
}

export interface WikiPage {
    name: string;       // e.g. "concepts/machine-learning"
    file_path: string;  // absolute path to .md file
    size: number;
    modified: Date;
}

export function list_wiki_pages(): WikiPage[] {
    const pdir = pages_dir();
    const results: WikiPage[] = [];

    function scan(dir: string, prefix: string) {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(full, prefix ? `${prefix}/${entry.name}` : entry.name);
                } else if (entry.isFile() && entry.name.endsWith('.md')) {
                    try {
                        const stat = fs.statSync(full);
                        const name = (prefix ? `${prefix}/` : '') + entry.name.slice(0, -3);
                        results.push({ name, file_path: full, size: stat.size, modified: stat.mtime });
                    } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    }

    scan(pdir, '');
    return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function read_wiki_page(name: string): string | null {
    try {
        return fs.readFileSync(path.join(pages_dir(), `${name}.md`), 'utf8');
    } catch { return null; }
}

function write_wiki_page(name: string, content: string): void {
    const file = path.join(pages_dir(), `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

/** Parse the ===PAGE: name.md=== ... ===END=== blocks the LLM emits. */
function parse_page_blocks(raw: string): Array<{ name: string; content: string }> {
    const pages: Array<{ name: string; content: string }> = [];
    const re = /={3}PAGE:\s*([^\n=]+?\.md)\s*={3}([\s\S]*?)={3}END={3}/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const name = m[1].trim().replace(/\.md$/, '');
        const content = m[2].trim();
        if (name && content) pages.push({ name, content });
    }
    return pages;
}

/** Build a compact "existing pages" context for the LLM: names + first 200 chars each. */
function build_existing_context(maxChars = 6000): string {
    const pages = list_wiki_pages();
    if (pages.length === 0) return '(none yet — this is the first ingestion)';
    let out = '';
    for (const p of pages) {
        const content = read_wiki_page(p.name) || '';
        const snippet = content.slice(0, 200).replace(/\n/g, ' ');
        const line = `- [[${p.name}]]: ${snippet}${content.length > 200 ? '…' : ''}\n`;
        if (out.length + line.length > maxChars) {
            out += `…(${pages.length} total pages)\n`;
            break;
        }
        out += line;
    }
    return out;
}

/** Simple full-text search across all wiki pages. Returns {name, excerpt}[] */
function search_wiki_pages(query: string, maxResults = 10): Array<{ name: string; excerpt: string; score: number }> {
    const pages = list_wiki_pages();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: Array<{ name: string; excerpt: string; score: number }> = [];

    for (const page of pages) {
        const content = read_wiki_page(page.name) || '';
        const lower = content.toLowerCase();
        let score = 0;
        for (const term of terms) {
            let pos = 0;
            while ((pos = lower.indexOf(term, pos)) !== -1) { score++; pos++; }
        }
        if (score > 0) {
            // Find best excerpt: the line with the most term hits
            const lines = content.split('\n');
            let bestLine = '';
            let bestScore = 0;
            for (const line of lines) {
                const ll = line.toLowerCase();
                let ls = terms.reduce((s, t) => s + (ll.includes(t) ? 1 : 0), 0);
                if (ls > bestScore) { bestScore = ls; bestLine = line.trim(); }
            }
            results.push({ name: page.name, excerpt: bestLine.slice(0, 200), score });
        }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function register_wiki_tools(): void {
    ensure_wiki_structure();

    // ── wiki_ingest ──────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'wiki_ingest',
            description:
                'Compile new knowledge into the AAOS Wiki. Feed it a URL, file path, or raw text. ' +
                'The LLM will extract key concepts, entities, and insights, then create or update ' +
                'structured Markdown wiki pages. Use whenever the user shares an article, paper, ' +
                'document, or idea they want to "learn" or remember. ' +
                'Returns the list of pages created/updated.',
            parameters: {
                type: 'object',
                properties: {
                    source: {
                        type: 'string',
                        description: 'URL to fetch, absolute file path to read, or raw text to compile'
                    },
                    title: {
                        type: 'string',
                        description: 'Optional human-readable title for the source (used for the summary page name)'
                    },
                    focus: {
                        type: 'string',
                        description: 'Optional: specific aspect to focus on when compiling (e.g. "technical architecture", "key takeaways for AI agents")'
                    }
                },
                required: ['source']
            }
        },
        async (args: { source: string; title?: string; focus?: string }) => {
            try {
                ensure_wiki_structure();
                let rawContent = '';
                let sourceLabel = args.title || args.source.slice(0, 80);

                // Resolve path aliases (WSL, Git Bash, ~) before file checks
                const resolvedSource = resolve_path(args.source);

                // Determine source type and fetch content
                if (resolvedSource.startsWith('http://') || resolvedSource.startsWith('https://')) {
                    // Use the same HTTP fetch logic as web_fetch
                    const https = await import('https');
                    const http  = await import('http');

                    const fetch_url = (target: string): Promise<string> =>
                        new Promise((resolve, reject) => {
                            // Auto-convert Gist viewer → raw
                            const gm = target.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)\/?$/i);
                            if (gm) target = `https://gist.github.com/${gm[1]}/${gm[2]}/raw`;

                            const mod = target.startsWith('https') ? https : http;
                            (mod as any).get(target, { headers: { 'User-Agent': 'AAOS-Wiki/1.0' }, timeout: 15000 }, (res: any) => {
                                if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
                                    const next = res.headers.location.startsWith('http')
                                        ? res.headers.location
                                        : new URL(res.headers.location, target).href;
                                    return fetch_url(next).then(resolve).catch(reject);
                                }
                                const chunks: Buffer[] = [];
                                res.on('data', (c: Buffer) => chunks.push(c));
                                res.on('end', () => {
                                    let body = Buffer.concat(chunks).toString('utf8');
                                    const ct = res.headers['content-type'] || '';
                                    if (ct.includes('text/html')) {
                                        body = body
                                            .replace(/<script[\s\S]*?<\/script>/gi, '')
                                            .replace(/<style[\s\S]*?<\/style>/gi, '')
                                            .replace(/<[^>]+>/g, ' ')
                                            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&nbsp;/g,' ')
                                            .replace(/\s{3,}/g, '\n\n').trim();
                                    }
                                    resolve(body);
                                });
                            }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
                        });

                    rawContent = await fetch_url(resolvedSource);
                    if (!args.title) sourceLabel = resolvedSource;
                } else if (fs.existsSync(resolvedSource)) {
                    const srcStat = fs.statSync(resolvedSource);
                    if (srcStat.isDirectory()) {
                        // ── Full directory ingest: auto-batch all files, multiple LLM passes ──

                        const PLAIN_TEXT_EXTS = new Set([
                            '.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.xml',
                            '.py', '.ts', '.js', '.tsx', '.jsx', '.java', '.c', '.cpp',
                            '.h', '.hpp', '.rs', '.go', '.rb', '.php', '.html', '.css',
                            '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg', '.conf',
                            '.log', '.rst', '.tex', '.adoc', '.rtf'
                        ]);
                        const BINARY_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls']);
                        const ALL_EXTS = new Set([...PLAIN_TEXT_EXTS, ...BINARY_EXTS]);

                        const dirFiles: string[] = [];
                        const scan_dir = (dir: string) => {
                            try {
                                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                                    const full = path.join(dir, entry.name);
                                    if (entry.isDirectory()) {
                                        scan_dir(full);
                                    } else if (entry.isFile()) {
                                        const ext = path.extname(entry.name).toLowerCase();
                                        if (ALL_EXTS.has(ext)) dirFiles.push(full);
                                    }
                                }
                            } catch { /* skip unreadable dirs */ }
                        };
                        scan_dir(resolvedSource);

                        if (dirFiles.length === 0) {
                            return { ok: false, error: `No readable files found in directory: ${resolvedSource}. Supported: .pdf, .docx, .xlsx, .md, .txt, and other text formats.` };
                        }

                        const MAX_CHARS_PER_FILE  = 6000;   // per-file extraction cap
                        const MAX_BATCH_CHARS     = 28000;  // content budget per LLM compilation pass
                        const dirLabel = args.title || path.basename(resolvedSource);
                        const focusNote = args.focus ? `\nFocus especially on: ${args.focus}` : '';

                        // Build schema + existing pages context once (reused across batches)
                        const schema = fs.readFileSync(schema_path(), 'utf8');
                        const existingCtx = build_existing_context();

                        const allPagesWritten: string[] = [];
                        let filesProcessed = 0;
                        let filesSkipped   = 0;
                        let batchNum       = 0;

                        // Slice files into batches that fit within MAX_BATCH_CHARS
                        let batchFiles: string[] = [];
                        let batchChars = 0;

                        const flush_batch = async (files: string[]) => {
                            if (files.length === 0) return;
                            batchNum++;

                            // Extract content for each file in the batch
                            const parts: string[] = [];
                            for (const file of files) {
                                try {
                                    const fext = path.extname(file).toLowerCase();
                                    let fileContent: string | null = null;

                                    if (BINARY_EXTS.has(fext)) {
                                        const extracted = extract_binary_text(file);
                                        if (!extracted) { filesSkipped++; continue; }
                                        // Handle scanned PDF Vision OCR sentinel
                                        if (extracted.startsWith('__SCANNED_PDF_VISION__:')) {
                                            const tmpPath = extracted.slice('__SCANNED_PDF_VISION__:'.length);
                                            fileContent = await ocr_pdf_pages_via_gemini(tmpPath);
                                            if (!fileContent) { filesSkipped++; continue; }
                                        } else {
                                            fileContent = extracted;
                                        }
                                    } else {
                                        fileContent = fs.readFileSync(file, 'utf8');
                                    }

                                    if (fileContent.length > MAX_CHARS_PER_FILE) {
                                        fileContent = fileContent.slice(0, MAX_CHARS_PER_FILE) +
                                            `\n[...truncated at ${MAX_CHARS_PER_FILE} chars...]`;
                                    }

                                    const rel = path.relative(resolvedSource, file);
                                    parts.push(`\n\n${'─'.repeat(50)}\n## FILE: ${rel}\n${'─'.repeat(50)}\n${fileContent}`);
                                    filesProcessed++;
                                } catch { filesSkipped++; }
                            }

                            if (parts.length === 0) return;

                            const batchContent = parts.join('');
                            const batchSource  = `${dirLabel} (batch ${batchNum}/${Math.ceil(dirFiles.length / 5)})`;

                            // Save raw source for this batch
                            const hash = crypto.createHash('md5').update(batchContent).digest('hex').slice(0, 8);
                            const srcFile = path.join(sources_dir(), `${Date.now()}_${hash}.txt`);
                            fs.writeFileSync(srcFile, `SOURCE: ${batchSource}\nDATE: ${new Date().toISOString()}\n\n${batchContent}`, 'utf8');

                            // Call wiki compiler for this batch
                            const sysPrompt = `You are the AAOS Wiki Compiler integrating files from the "${dirLabel}" directory.${focusNote}

## Wiki Schema
${schema}

## Existing Wiki Pages
${build_existing_context()}

## Output Format — CRITICAL
Output ONLY page blocks:

===PAGE: path/page-name.md===
[full markdown content]
===END===

Rules:
- Create summaries/, concepts/, and entities/ pages as appropriate
- For existing pages, output FULL updated content
- Use [[path/page-name]] for internal links
- Page names: lowercase, hyphenated`;

                            const userMsg = `Compile these files from "${dirLabel}" into the wiki:\n${batchContent}`;

                            try {
                                const res = await invoke_for_role('wiki_compiler', {
                                    system: sysPrompt,
                                    messages: [{ role: 'user', content: userMsg }]
                                });
                                const pages = parse_page_blocks(res.text || '');
                                for (const p of pages) {
                                    write_wiki_page(p.name, p.content);
                                    allPagesWritten.push(p.name);
                                }
                                console.log(`[Wiki] Batch ${batchNum}: compiled ${files.length} files → ${pages.length} pages`);
                            } catch (err: any) {
                                console.warn(`[Wiki] Batch ${batchNum} compilation failed: ${err.message}`);
                            }
                        };

                        // Distribute files into batches
                        for (const file of dirFiles) {
                            const approxSize = Math.min(MAX_CHARS_PER_FILE, 2000); // conservative estimate before extraction
                            if (batchChars + approxSize > MAX_BATCH_CHARS && batchFiles.length > 0) {
                                await flush_batch(batchFiles);
                                batchFiles = [];
                                batchChars = 0;
                            }
                            batchFiles.push(file);
                            batchChars += approxSize;
                        }
                        if (batchFiles.length > 0) await flush_batch(batchFiles);

                        console.log(`[Wiki] Directory ingest complete: ${filesProcessed} processed, ${filesSkipped} skipped of ${dirFiles.length} total files from ${resolvedSource}`);

                        return {
                            ok: true,
                            source: dirLabel,
                            files_total: dirFiles.length,
                            files_processed: filesProcessed,
                            files_skipped: filesSkipped,
                            batches: batchNum,
                            pages_written: allPagesWritten,
                            count: allPagesWritten.length
                        };
                    } else {
                        const fext = path.extname(resolvedSource).toLowerCase();
                        const BINARY_FILE_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls']);
                        if (BINARY_FILE_EXTS.has(fext)) {
                            const extracted = extract_binary_text(resolvedSource);
                            if (!extracted) {
                                return { ok: false, error: `Could not extract text from binary file: ${resolvedSource}. Make sure pdftotext (for PDFs) and unzip (for DOCX/XLSX) are installed.` };
                            }
                            // Scanned PDF sentinel: async Vision OCR
                            if (extracted.startsWith('__SCANNED_PDF_VISION__:')) {
                                const tmpDataPath = extracted.slice('__SCANNED_PDF_VISION__:'.length);
                                const ocrText = await ocr_pdf_pages_via_gemini(tmpDataPath);
                                if (!ocrText) {
                                    return { ok: false, error: `This PDF appears to be a scanned image. Vision OCR failed — ensure VERTEX_PROJECT_ID is set and Gemini Vision is accessible.` };
                                }
                                rawContent = ocrText;
                            } else {
                                rawContent = extracted;
                            }
                        } else {
                            rawContent = fs.readFileSync(resolvedSource, 'utf8');
                        }
                        if (!args.title) sourceLabel = path.basename(resolvedSource, path.extname(resolvedSource));
                    }
                } else {
                    // Treat as raw text
                    rawContent = args.source;
                    sourceLabel = args.title || 'pasted-content';
                }

                // Save immutable source copy
                const hash = crypto.createHash('md5').update(rawContent).digest('hex').slice(0, 8);
                const sourceFile = path.join(sources_dir(), `${Date.now()}_${hash}.txt`);
                fs.writeFileSync(sourceFile, `SOURCE: ${sourceLabel}\nURL/PATH: ${args.source}\nDATE: ${new Date().toISOString()}\n\n${rawContent}`, 'utf8');

                // Build LLM compilation prompt
                const schema = fs.readFileSync(schema_path(), 'utf8');
                const existingCtx = build_existing_context();
                const focusNote = args.focus ? `\n\n**Focus especially on:** ${args.focus}` : '';

                const systemPrompt = `You are the AAOS Wiki Compiler. Your job is to integrate new source material into a structured, persistent knowledge base.

## Wiki Schema
${schema}

## Existing Wiki Pages
${existingCtx}

## Output Format — CRITICAL
Output ONLY page blocks using EXACTLY this format (no preamble, no JSON, no explanation):

===PAGE: path/page-name.md===
[full markdown content of the page]
===END===

Rules:
- Always create at least one summaries/ page for the source
- Create/update concepts/ and entities/ pages for key ideas and people
- For existing pages listed above, output the FULL updated content (not a diff)
- Use [[path/page-name]] (no .md extension) for internal links
- Page names: lowercase, hyphenated`;

                const userMessage = `Compile this source into the wiki:

**Source:** ${sourceLabel}${focusNote}

**Content:**
${rawContent.slice(0, 14000)}${rawContent.length > 14000 ? '\n\n[...content truncated for compilation...]' : ''}`;

                const res = await invoke_for_role('wiki_compiler', {
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userMessage }]
                });

                const compiled = res.text || '';
                const pages = parse_page_blocks(compiled);

                if (pages.length === 0) {
                    return { ok: false, error: 'LLM did not produce any wiki page blocks. Raw output: ' + compiled.slice(0, 300) };
                }

                for (const p of pages) {
                    write_wiki_page(p.name, p.content);
                    console.log(`[Wiki] Written: ${p.name}.md (${p.content.length} chars)`);
                }

                return {
                    ok: true,
                    source: sourceLabel,
                    pages_written: pages.map(p => p.name),
                    count: pages.length
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── wiki_search ──────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'wiki_search',
            description:
                'Full-text search across all AAOS Wiki pages. ' +
                'Returns matching page names and relevant excerpts. ' +
                'Use this to find what the wiki already knows before ingesting new content, ' +
                'or to answer user questions from compiled knowledge.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search terms or question' },
                    max_results: { type: 'number', description: 'Maximum results to return (default: 8)' }
                },
                required: ['query']
            }
        },
        async (args: { query: string; max_results?: number }) => {
            try {
                ensure_wiki_structure();
                const results = search_wiki_pages(args.query, args.max_results ?? 8);
                const total = list_wiki_pages().length;
                return {
                    ok: true,
                    query: args.query,
                    results,
                    total_pages_searched: total
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── wiki_read ────────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'wiki_read',
            description:
                'Read a specific AAOS Wiki page by name (e.g. "concepts/machine-learning", "entities/andrej-karpathy"). ' +
                'Use wiki_search first to find the right page name.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Page name/path without .md extension (e.g. "concepts/rag")' }
                },
                required: ['name']
            }
        },
        async (args: { name: string }) => {
            try {
                ensure_wiki_structure();
                const content = read_wiki_page(args.name);
                if (!content) return { ok: false, error: `Page not found: ${args.name}` };
                return { ok: true, name: args.name, content, chars: content.length };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── wiki_write ───────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'wiki_write',
            description:
                'Create or update an AAOS Wiki page. Use this to manually add knowledge, ' +
                'file a useful response as a wiki page, or update existing pages with new information. ' +
                'Follows the schema in SCHEMA.md.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Page name/path without .md (e.g. "concepts/attention-mechanism")' },
                    content: { type: 'string', description: 'Full Markdown content of the page' }
                },
                required: ['name', 'content']
            }
        },
        async (args: { name: string; content: string }) => {
            try {
                ensure_wiki_structure();
                write_wiki_page(args.name, args.content);
                return { ok: true, name: args.name, chars: args.content.length };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── wiki_list ────────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'wiki_list',
            description: 'List all pages in the AAOS Wiki, grouped by type (concepts, entities, topics, summaries).',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        async (_args: Record<string, never>) => {
            try {
                ensure_wiki_structure();
                const pages = list_wiki_pages();
                const grouped: Record<string, string[]> = {};
                for (const p of pages) {
                    const prefix = p.name.includes('/') ? p.name.split('/')[0] : 'other';
                    if (!grouped[prefix]) grouped[prefix] = [];
                    grouped[prefix].push(p.name);
                }
                return { ok: true, total: pages.length, grouped };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── wiki_lint ────────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'wiki_lint',
            description:
                'Scan the AAOS Wiki for inconsistencies, outdated info, missing cross-references, ' +
                'or duplicate content. The LLM reviews all pages and returns a report with issues found. ' +
                'Optionally applies automatic fixes.',
            parameters: {
                type: 'object',
                properties: {
                    auto_fix: {
                        type: 'boolean',
                        description: 'If true, automatically fix minor issues (default: false — report only)'
                    }
                },
                required: []
            }
        },
        async (args: { auto_fix?: boolean }) => {
            try {
                ensure_wiki_structure();
                const pages = list_wiki_pages();
                if (pages.length === 0) return { ok: true, issues: [], message: 'Wiki is empty — nothing to lint.' };

                // Build full wiki content for review (capped at 12k chars)
                let wikiDump = '';
                for (const p of pages) {
                    const content = read_wiki_page(p.name) || '';
                    const entry = `\n\n### [[${p.name}]]\n${content.slice(0, 600)}${content.length > 600 ? '\n…(truncated)' : ''}`;
                    if (wikiDump.length + entry.length > 12000) break;
                    wikiDump += entry;
                }

                const lintPrompt = `You are reviewing the AAOS Wiki for quality issues. Analyze the following wiki pages and identify:

1. Duplicate or overlapping pages that should be merged
2. Pages with broken [[internal-links]] pointing to non-existent pages
3. Missing important cross-references between related pages
4. Inconsistent information between pages (conflicting facts)
5. Pages that are too sparse (< 100 words) and need expansion
6. Structural issues (wrong page type/location)

${args.auto_fix ? 'For each fixable issue, also output the corrected page using ===PAGE: name.md=== ... ===END=== format.' : 'Report issues only — do not output page corrections.'}

## Wiki Contents (${pages.length} pages)
${wikiDump}

Output a structured list of issues found. Be specific (page name + issue + suggested fix).`;

                const res = await invoke_for_role('wiki_compiler', {
                    system: 'You are an AAOS Wiki quality auditor.',
                    messages: [{ role: 'user', content: lintPrompt }]
                });

                const report = res.text || '';
                let fixCount = 0;

                if (args.auto_fix) {
                    const fixes = parse_page_blocks(report);
                    for (const fix of fixes) {
                        write_wiki_page(fix.name, fix.content);
                        fixCount++;
                    }
                }

                return {
                    ok: true,
                    pages_reviewed: pages.length,
                    report,
                    fixes_applied: fixCount
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    console.log('[Wiki] Tools registered: wiki_ingest, wiki_search, wiki_read, wiki_write, wiki_list, wiki_lint');
}
