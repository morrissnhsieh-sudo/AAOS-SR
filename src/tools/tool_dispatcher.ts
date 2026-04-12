export type ToolHandler = (args: any) => Promise<any>;
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: any;
}
export interface ToolCall { id: string; name: string; args: any; }
export interface ToolResult { id: string; result: any; error?: string; }
export interface ToolArgs { [key: string]: any; }
export interface ToolResultMap { [id: string]: ToolResult; }

interface RegisteredTool {
    definition: ToolDefinition;
    handler: ToolHandler;
}

const registry = new Map<string, RegisteredTool>();

export function register_tool(definition: ToolDefinition, handler: ToolHandler): void {
    registry.set(definition.name, { definition, handler });
}

export function lookup_tool_handler(name: string): ToolHandler | null {
    const registered = registry.get(name);
    return registered ? registered.handler : null;
}

export function get_all_tool_definitions(): ToolDefinition[] {
    return Array.from(registry.values()).map(r => r.definition);
}

export function validate_tool_exists(name: string): boolean {
    return registry.has(name);
}

export function deregister_tool(name: string): void {
    registry.delete(name);
}

export async function execute_tool(toolCall: ToolCall): Promise<ToolResult> {
    const handler = lookup_tool_handler(toolCall.name);
    if (!handler) {
        console.error(`Tool not found: ${toolCall.name}`);
        return { id: toolCall.id, result: null, error: `Tool not found: ${toolCall.name}` };
    }
    return io_invoke_skill_handler(handler, toolCall.args)
        .then(res => ({ id: toolCall.id, result: res.result }))
        .catch(e => ({ id: toolCall.id, result: null, error: e.message }));
}

export async function io_invoke_skill_handler(handler: ToolHandler, args: ToolArgs): Promise<ToolResult> {
    try {
        const result = await handler(args);
        return { id: 'inline', result };
    } catch(err) {
        if (err instanceof Error) throw err;
        throw new Error('Unknown error in skill handler');
    }
}
