import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';

const LEGACY_DIR = 'C:\\Users\\User\\openclaw-source\\openclaw\\skills';
const project = process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl';
const location = process.env.VERTEX_LOCATION || 'us-central1';
process.env.GOOGLE_APPLICATION_CREDENTIALS = 'C:\\Users\\User\\OneDrive\\USI-Sync\\AI Development\\VertexKeys\\d-sxd110x-ssd1-cdl-429bd22f2ba7.json';

const ai = new GoogleGenAI({ vertexai: true, project, location });

const systemPrompt = `You are a script migration agent. Turn this Markdown documentation into a generic JS wrapper skill.
Respond with ONLY raw JSON in this format:
{
  "name": "lowercase-skill",
  "description": "Short description of what it does",
  "tools": [{ "name": "tool_name", "description": "What it does", "params": { "target": "string argument if needed" } }],
  "code": "const cp = require('child_process'); module.exports = { tool_name: async (args) => { /* use cp.exec if needed to invoke underlying scripts or binaries described in MD */ return { result: 'Output' }; } };"
}`;

async function main() {
    const entries = fs.readdirSync(LEGACY_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(LEGACY_DIR, entry.name);
        
        if (fs.existsSync(path.join(skillPath, 'package.json'))) {
            console.log(`[SKIPPED] ${entry.name} already has package.json`);
            continue;
        }

        const mdPath = path.join(skillPath, 'SKILL.md');
        if (!fs.existsSync(mdPath)) continue;

        console.log(`[PROCESSING] ${entry.name}...`);
        const mdContent = fs.readFileSync(mdPath, 'utf8');

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.0-flash',
                contents: [{ role: 'user', parts: [{ text: `Convert this legacy skill into a CommonJS wrapper:\n\n${mdContent.substring(0, 5000)}` }] }],
                config: { systemInstruction: systemPrompt }
            });

            const raw = (response.text || '{"error": true}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const blueprint = JSON.parse(raw);

            if (blueprint.error) throw new Error('Model returned error');

            const pkg = { name: blueprint.name, version: "1.0.0", description: blueprint.description, main: 'index.js', dependencies: {} };
            fs.writeFileSync(path.join(skillPath, 'package.json'), JSON.stringify(pkg, null, 2));

            const toolLines = blueprint.tools.map((t: any) => `  - name: ${t.name}\n    description: "${t.description}"\n    entrypoint: "./index.js"\n    parameters:\n      type: "object"\n      properties:\n${Object.keys(t.params || {}).map(k => `        ${k}:\n          type: "string"\n          description: "argument"`).join('\n')}`).join('\n');
            const manifest = `version: "1.0.0"\ntools:\n${toolLines}\n`;
            fs.writeFileSync(path.join(skillPath, 'manifest.yaml'), manifest);

            fs.writeFileSync(path.join(skillPath, 'index.js'), blueprint.code);
            console.log(`[SUCCESS] ${entry.name}`);
        } catch (e: any) {
            console.error(`[ERROR] ${entry.name}: ${e.message}`);
        }
        
        // Anti-rate-limit sleep
        await new Promise(r => setTimeout(r, 2000));
    }
}

main().catch(console.error);
