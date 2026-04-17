import * as fs from 'fs';
import * as path from 'path';
import { invoke_for_role, LlmPrompt } from '../plugins/plugin_engine';
import { Skill, SkillContent, io_save_skill_to_registry, io_list_installed_skills, parse_skill_md, validate_skill_not_already_installed, SKILL_INSTALL_DIR } from './skill_manager';
import { v4 as uuidv4 } from 'uuid';

export interface SkillBlueprint {
    name: string;
    version: string;
    description: string;
    allowed_tools: string[];
    instructions: string;
}

const AAOS_NATIVE_TOOLS = [
    'bash_exec',
    'file_read',
    'file_write',
    'file_list',
    'file_search',
    'build_skill',
    'think',
    'remember',
    'sys_info',
    'iot_scan',
    'iot_devices',
    'iot_mqtt_subscribe',
    'iot_mqtt_read',
    'iot_mqtt_publish',
    'iot_tcp_send',
    'iot_mqtt_connections',
    'webcam_capture',
] as const;

function getWorkspace(): string {
    return process.env.AAOS_WORKSPACE ||
        path.join(process.env.HOME || process.env.USERPROFILE || '', '.aaos-sr');
}

/**
 * Generates the system prompt and initial user message for skill authoring.
 * Pass repairFeedback when asking the LLM to fix a previous bad attempt.
 */
export function generate_skill_build_prompt(description: string): string {
    return `You are a SKILL.md authoring agent for USI AI\u2011OS\u00ae - Personal Assistant.
Output ONLY a valid SKILL.md file — no commentary, no markdown code fences around it.

## Available tools
Use ONLY these exact names in the allowed-tools frontmatter field:

| Tool        | When to use                                                       |
|-------------|-------------------------------------------------------------------|
| bash_exec   | Run shell commands: curl, CLI tools (gog, gh, etc.), scripts      |
| file_read   | Read a local file's text content                                  |
| file_write  | Write or append text to a local file                              |
| file_list   | List files and directories at a path                              |
| file_search | Find files by name pattern under a directory                      |
| build_skill           | Generate and register a new skill from a plain-text description          |
| think                 | Private reasoning scratchpad before multi-step tasks                     |
| remember              | Store a fact in long-term memory                                         |
| iot_scan              | Scan local network for IoT devices                                       |
| iot_devices           | List/filter registered IoT devices                                       |
| iot_mqtt_subscribe    | Subscribe to an MQTT topic on a broker                                   |
| iot_mqtt_read         | Read buffered messages from a subscribed MQTT topic                      |
| iot_mqtt_publish      | Publish a command to an MQTT topic                                       |
| iot_tcp_send          | Send a raw TCP command and read the response                             |
| iot_mqtt_connections  | List or disconnect active MQTT broker connections                        |

## SKILL.md format

---
name: kebab-case-name
description: One sentence — what it does and when to use it.
allowed-tools: bash_exec
version: 1.0.0
---

# Skill Name

Step-by-step directive instructions the agent will follow.

## Writing rules
- **name**: lowercase kebab-case only (letters, numbers, hyphens; must start with a letter)
- **description**: single sentence, starts with a verb, clearly states when to use it
- **allowed-tools**: space-separated, exact names from the table above — no others
- **Body**: directive — tell the agent what tool to CALL and with what arguments, not what the user should type
- For bash_exec: write "Call \`bash_exec\` with: \`<exact command>\`"
- For file tools: write "Call \`file_write\` with path \`...\` and content \`...\`"
- Do NOT wrap the output in any markdown code fence

## Example 1 — bash_exec skill

---
name: current-time
description: Get the current date and time. Use when the user asks what time or date it is.
allowed-tools: bash_exec
version: 1.0.0
---

# Current Time

1. Call \`bash_exec\` with: \`date '+%A, %B %-d %Y at %H:%M %Z'\`
2. Present the result in a friendly sentence, e.g. "It's Tuesday, June 3 2025 at 14:30 UTC."
3. Do NOT show the raw command output to the user.

## Example 2 — file tool skill

---
name: save-note
description: Save a quick note to a local markdown file. Use when the user wants to record or jot down a note.
allowed-tools: file_write file_read
version: 1.0.0
---

# Save Note

To save a note:
1. Extract the note text from the user's request.
2. Call \`file_write\` with \`path: ~/notes/notes.md\`, \`content: "- {note}\\n"\`, \`append: true\`.
3. Confirm: "Note saved."

To list saved notes:
1. Call \`file_read\` with \`path: ~/notes/notes.md\`.
2. Present the contents cleanly.`;
}

/**
 * Strips markdown code fences if the LLM accidentally wrapped the output.
 */
function strip_code_fences(raw: string): string {
    return raw
        .replace(/^```(?:markdown|md|yaml|text)?\r?\n/im, '')
        .replace(/\r?\n```\s*$/m, '')
        .trim();
}

/**
 * Parses and validates the raw LLM output into a SkillBlueprint.
 */
export function validate_skill_blueprint(raw: string): { valid: boolean; data?: SkillBlueprint; reason?: string } {
    const cleaned = strip_code_fences(raw);
    const content: SkillContent | null = parse_skill_md(cleaned);
    if (!content) return { valid: false, reason: 'Could not parse SKILL.md frontmatter — check --- delimiters and YAML syntax' };

    const { name, description, allowed_tools, version } = content.frontmatter;

    if (!name) return { valid: false, reason: 'Missing name in frontmatter' };
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return { valid: false, reason: `name "${name}" must be kebab-case (lowercase letters, numbers, hyphens, starting with a letter)` };
    if (!description) return { valid: false, reason: 'Missing description in frontmatter' };
    if (!content.body || content.body.trim().length < 10) return { valid: false, reason: 'SKILL.md body is missing or too short — add step-by-step instructions' };

    const unknownTools = allowed_tools.filter(t => !(AAOS_NATIVE_TOOLS as readonly string[]).includes(t));
    if (unknownTools.length > 0) {
        return { valid: false, reason: `Unknown tools in allowed-tools: ${unknownTools.join(', ')}. Use only: ${AAOS_NATIVE_TOOLS.join(', ')}` };
    }

    return {
        valid: true,
        data: {
            name,
            version: version ?? '1.0.0',
            description,
            allowed_tools,
            instructions: content.body,
        }
    };
}

/**
 * Calls the skill_builder LLM role with retry-and-repair logic.
 * On a failed parse the error is fed back to the LLM for self-correction.
 */
async function invoke_with_repair(
    description: string,
    maxRetries: number = 2
): Promise<SkillBlueprint> {
    const systemPrompt = generate_skill_build_prompt(description);
    let messages: Array<{ role: string; content: string }> = [
        { role: 'user', content: `Build a skill that: ${description}` }
    ];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await invoke_for_role('skill_builder', { system: systemPrompt, messages });
        const raw = res.text || '';
        const parsed = validate_skill_blueprint(raw);

        if (parsed.valid && parsed.data) {
            if (attempt > 0) console.log(`[SkillBuilder] Succeeded on repair attempt ${attempt}.`);
            return parsed.data;
        }

        console.warn(`[SkillBuilder] Attempt ${attempt + 1} invalid: ${parsed.reason}`);

        if (attempt < maxRetries) {
            messages = [
                ...messages,
                { role: 'assistant', content: raw },
                {
                    role: 'user',
                    content: `That SKILL.md was invalid: ${parsed.reason}. ` +
                        `Please fix it and output only the corrected SKILL.md with no commentary or code fences.`
                }
            ];
        } else {
            throw new Error(`Skill generation failed after ${maxRetries + 1} attempt(s): ${parsed.reason}`);
        }
    }

    throw new Error('Skill generation failed: exhausted retries');
}

/**
 * Writes the blueprint to a SKILL.md file on disk.
 */
export function io_write_skill_md_file(blueprint: SkillBlueprint, skillDir: string): void {
    fs.mkdirSync(skillDir, { recursive: true });
    const toolsLine = blueprint.allowed_tools.length > 0
        ? blueprint.allowed_tools.join(' ')
        : 'bash_exec';
    const skillMd = [
        '---',
        `name: ${blueprint.name}`,
        `description: ${blueprint.description}`,
        `allowed-tools: ${toolsLine}`,
        `version: ${blueprint.version}`,
        '---',
        '',
        blueprint.instructions,
        '',
    ].join('\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
}

/**
 * Full pipeline: description → SKILL.md on disk → registered in skill registry.
 * Throws if the name is already installed or if LLM output is invalid after retries.
 */
export async function build_skill_from_description(description: string): Promise<Skill> {
    const blueprint = await invoke_with_repair(description);

    if (!validate_skill_not_already_installed(blueprint.name)) {
        throw new Error(`A skill named "${blueprint.name}" is already installed. Disable it first or choose a different name.`);
    }

    const skillDir = path.join(getWorkspace(), SKILL_INSTALL_DIR, blueprint.name);
    io_write_skill_md_file(blueprint, skillDir);

    const skill: Skill = {
        id: uuidv4(),
        name: blueprint.name,
        version: blueprint.version,
        status: 'enabled',
        description: blueprint.description,
        skill_md_path: path.join(skillDir, 'SKILL.md'),
        allowed_tools: blueprint.allowed_tools,
    };

    io_save_skill_to_registry(skill);
    console.log(`[SkillBuilder] Registered skill: ${skill.name} (${skill.allowed_tools?.join(', ')})`);
    return skill;
}
