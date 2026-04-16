import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';

export interface SkillFrontmatter {
    name: string;
    description: string;
    allowed_tools: string[];
    version?: string;
}

export interface SkillContent {
    frontmatter: SkillFrontmatter;
    body: string;
    raw: string;
}

export interface Skill {
    id: string;
    name: string;
    version: string;
    status: string;
    description: string;
    skill_md_path: string;
    allowed_tools?: string[];
}

export const SKILL_REGISTRY_FILE = 'skills/registry.json';
export const SKILL_INSTALL_DIR = 'skills';

function getWorkspace(): string {
    return process.env.AAOS_WORKSPACE || path.join(process.env.HOME || '', '.aaos');
}

export function io_read_skill_md(skillMdPath: string): string | null {
    try {
        // Support relative paths (resolved against workspace)
        const resolved = path.isAbsolute(skillMdPath)
            ? skillMdPath
            : path.join(getWorkspace(), skillMdPath);
        let content = fs.readFileSync(resolved, 'utf8');
        // Replace {WORKSPACE} placeholder with the actual workspace path
        content = content.replace(/\{WORKSPACE\}/g, getWorkspace());
        return content;
    } catch { return null; }
}

export function parse_skill_md(raw: string): SkillContent | null {
    try {
        let yamlBlock = '';
        let body = '';

        // Format 1 — standard fenced: ---\n{yaml}\n---\n{body}
        const fenced = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (fenced) {
            yamlBlock = fenced[1];
            body = fenced[2].trim();
        } else {
            // Format 2 — fenceless top: key: value lines, then --- separator, then body
            const fenceless = raw.match(/^((?:[\w-]+:[ \t].+\r?\n)+)\r?\n?---\r?\n([\s\S]*)$/);
            if (fenceless) {
                yamlBlock = fenceless[1];
                body = fenceless[2].trim();
            } else {
                // Format 3 — no frontmatter: derive name from # heading, use all as body
                const heading = raw.match(/^#\s+(.+)/m);
                const name = heading
                    ? heading[1].trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
                    : '';
                body = raw.trim();
                const frontmatter: SkillFrontmatter = { name, description: '', allowed_tools: [] };
                return { frontmatter, body, raw };
            }
        }

        const fm = yaml.load(yamlBlock) as Record<string, unknown>;
        if (!fm || typeof fm !== 'object') return null;

        const rawTools = fm['allowed-tools'] ?? fm['allowed_tools'] ?? '';
        const allowed_tools: string[] = Array.isArray(rawTools)
            ? rawTools.map(String)
            : String(rawTools).split(/\s+/).filter(Boolean);

        const frontmatter: SkillFrontmatter = {
            name:         String(fm['name']        ?? ''),
            description:  String(fm['description'] ?? ''),
            allowed_tools,
            version: fm['version'] ? String(fm['version']) : undefined,
        };

        return { frontmatter, body, raw };
    } catch { return null; }
}

export function validate_skill_md_schema(content: SkillContent): { valid: boolean; reason?: string } {
    if (!content.frontmatter.name) return { valid: false, reason: 'Missing name in frontmatter' };
    if (!content.frontmatter.description) return { valid: false, reason: 'Missing description in frontmatter' };
    if (!content.body) return { valid: false, reason: 'SKILL.md body is empty' };
    return { valid: true };
}

export async function io_receive_skill_install_request(req: Request, res: Response): Promise<void> {
    try {
        const { source_dir } = req.body;
        if (!source_dir || typeof source_dir !== 'string') {
            res.status(400).json({ reason: 'source_dir is required' });
            return;
        }

        const skillMdPath = path.resolve(source_dir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
            res.status(400).json({ reason: `No SKILL.md found in ${source_dir}` });
            return;
        }

        const raw = io_read_skill_md(skillMdPath);
        if (!raw) { res.status(500).json({ reason: 'Failed to read SKILL.md' }); return; }

        const content = parse_skill_md(raw);
        if (!content) { res.status(400).json({ reason: 'Invalid SKILL.md format — check YAML frontmatter delimiters' }); return; }

        const schema = validate_skill_md_schema(content);
        if (!schema.valid) { res.status(400).json({ reason: schema.reason }); return; }

        if (!validate_skill_not_already_installed(content.frontmatter.name)) {
            res.status(409).json({ reason: 'Skill already installed' });
            return;
        }

        const skill: Skill = {
            id: uuidv4(),
            name: content.frontmatter.name,
            version: content.frontmatter.version ?? '1.0.0',
            status: 'enabled',
            description: content.frontmatter.description,
            skill_md_path: skillMdPath,
        };

        io_save_skill_to_registry(skill);
        res.status(200).json({ skill_id: skill.id, name: skill.name, description: skill.description, status: skill.status });
    } catch (e: any) {
        res.status(500).json({ reason: e.message });
    }
}

export function validate_skill_not_already_installed(name: string): boolean {
    return !io_list_installed_skills().some(s => s.name === name);
}

export function validate_skill_enabled(skill: Skill): boolean { return skill.status === 'enabled'; }

export function validate_skill_exists_and_enabled(skillId: string): Skill | null {
    const s = io_list_installed_skills().find(s => s.id === skillId);
    return (s && s.status === 'enabled') ? s : null;
}

export function io_list_installed_skills(): Skill[] {
    try { return JSON.parse(fs.readFileSync(path.join(getWorkspace(), SKILL_REGISTRY_FILE), 'utf8')); } catch { return []; }
}

export function io_save_skill_to_registry(skill: Skill): void {
    const registryPath = path.join(getWorkspace(), SKILL_REGISTRY_FILE);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const skills = io_list_installed_skills();
    skills.push(skill);
    fs.writeFileSync(registryPath, JSON.stringify(skills, null, 2));
}

export function io_disable_skill(skillId: string): Skill {
    const skills = io_list_installed_skills();
    const idx = skills.findIndex(s => s.id === skillId);
    if (idx === -1) throw new Error('Skill not found');
    skills[idx].status = 'disabled';
    fs.writeFileSync(path.join(getWorkspace(), SKILL_REGISTRY_FILE), JSON.stringify(skills, null, 2));
    return skills[idx];
}

export function io_load_active_skill_contents(skills: Skill[]): SkillContent[] {
    const contents: SkillContent[] = [];
    for (const skill of skills) {
        if (skill.status !== 'enabled') continue;
        const raw = io_read_skill_md(skill.skill_md_path);
        if (!raw) { console.warn(`[Skills] Could not read SKILL.md for ${skill.name} at ${skill.skill_md_path}`); continue; }
        const content = parse_skill_md(raw);
        if (!content) { console.warn(`[Skills] Failed to parse SKILL.md for ${skill.name}`); continue; }
        contents.push(content);
    }
    return contents;
}

export function assemble_skill_system_prompt_block(contents: SkillContent[]): string {
    if (contents.length === 0) return '';
    const sections = contents.map(c => `### ${c.frontmatter.name}\n${c.body}`).join('\n\n');
    return `[SKILLS]\n## Active Skills\n\n${sections}\n[/SKILLS]`;
}
