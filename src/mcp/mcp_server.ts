import express, { Request, Response } from 'express';
import { lookup_tool_handler } from '../tools/tool_dispatcher';

export interface McpManifest { tools: string[]; }
export const MCP_BIND_HOST = '127.0.0.1';

export async function io_handle_mcp_request(req: Request, res: Response): Promise<void> {
    const vc = validate_mcp_request_schema(req.body);
    if (!vc.valid) { res.status(400).json({ reason: vc.reason }); return; }
    
    if (req.path === '/mcp/manifest') {
        res.json(build_mcp_tool_manifest());
        return;
    }
    
    const handler = lookup_tool_handler(req.body.tool);
    if (!handler) { res.status(400).json({ reason: 'Unknown tool' }); return; }
    
    try {
        const result = await handler(req.body.args);
        res.json({ result });
    } catch(e: any) {
        res.status(500).json({ error: e.message });
    }
}

export function validate_mcp_request_schema(body: unknown): { valid: boolean; reason?: string } {
    if (!body || typeof body !== 'object') return { valid: false, reason: 'Invalid payload' };
    return { valid: true };
}

export function build_mcp_tool_manifest(): McpManifest {
    return { tools: [] }; // Implementation fetches actual tools
}

export function bind_mcp_to_loopback(port: number): void {
    const app = express();
    app.use(express.json());
    app.post('/mcp', io_handle_mcp_request);
    app.get('/mcp/manifest', io_handle_mcp_request);
    app.listen(port, MCP_BIND_HOST, () => {
        console.log(`MCP loopback listening at http://${MCP_BIND_HOST}:${port}`);
    });
}
