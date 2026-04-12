# End-to-End Tool Dispatching Implementation

Currently, AAOS tool dispatching is fundamentally disconnected. When you installed the skill, it successfully registered the tools, but:
1. `skill_manager.ts` uses empty dummy handlers for manually installed skills.
2. The `ToolDispatcher` forgets descriptions and parameter schemas.
3. `agent_runner.ts` does not inject tool definitions into the prompt.
4. `plugin_engine.ts` does not construct Google Vertex `tools` schemas, thus the Gemini model has no idea it can call functions natively.

This plan resolves these architectural gaps to fully enable the `get_weather` skill and all AI-created skills.

## User Review Required

> [!WARNING]
> This plan will alter the core Agent Control Pipeline (ACP) loop. `execute_with_acp_retry` will need to be refactored to support bouncing control back and forth between the LLM and local tools until a final text response is produced.

## Proposed Changes

---

### `src/tools/tool_dispatcher.ts`

Redefine tool storage so it stores Full Schema Definitions (OpenAPI/Gemini style FunctionDeclarations) rather than just the execution handler.

#### [MODIFY] tool_dispatcher.ts
- Provide a `ToolDefinition` interface: `{ name, description, parameters }`
- Refactor `register_tool` to accept `(def: ToolDefinition, handler: ToolHandler)`
- Add `get_all_tool_definitions(): ToolDefinition[]`

---

### `src/skills/skill_manager.ts` & `src/skills/skill_builder.ts`

The current manual install pipeline injects "Dummy Handlers" for tools. We need it to `require()` the JS files exactly like the skill builder does.

#### [MODIFY] skill_manager.ts
- Redefine `SkillManifest` to include `description` and `parameters` on tools.
- Refactor `register_skill_tools(skill)` to use `require(path.join(skillDir, 'index.js'))` to extract the real Javascript functions, and register them into the tool dispatcher along with their schema.
- Remove the `dummyHandler`. 

#### [MODIFY] skill_builder.ts
- Refactor `io_write_skill_files` to write `parameters` correctly to `manifest.yaml` when writing JSON from the prompt.
- Refactor `register_built_skill_tools` to parse the `description` and `parameters` and invoke the new `register_tool(schema, handler)`.

---

### `src/plugins/plugin_engine.ts`

Wiring up the tools abstraction to the underlying Google SDK model.

#### [MODIFY] plugin_engine.ts
- Update `LlmPrompt` interface to accept `tools?: ToolDefinition[]`
- Inside `plugin.invoke()` for Google:
  - Map `prompt.tools` into the `tools: [{ functionDeclarations: [...] }]` format expected by `@google/genai`.
  - Process `ai.models.generateContent` response. If `response.functionCalls` exists, extract them and return them in `LlmResponse.tools` rather than failing.
  - Map incoming `history` or `messages` to support passing `function_response` format back to Gemini so it can read tool results.

---

### `src/agent/agent_runner.ts` 

The agent loop needs to pass the tools, and handle the multi-step nature of tool use.

#### [MODIFY] agent_runner.ts
- In `start_agent_run`: Fetch `get_all_tool_definitions()` and attach them to `prompt.tools`.
- Inside `execute_with_acp_retry`:
  - When the LLM returns `tools` (function calls), execute them locally using `dispatch_tool_calls_parallel()`.
  - Append the `functionCall` to the conversation history.
  - Append the `functionResponse` (tool results) to the conversation history.
  - Recursively invoke the plugin again until the model returns a final text answer (`finalResponse`).

## Open Questions

None. This resolves the final architectural gap for closing the loop between UI skills/tools and LLM operations.

## Verification Plan

### Automated Tests
Run `npm run build` and ensure TS compiler passes.

### Manual Verification
Ask the Gateway: "Tell me the weather at Taichung."
Verify it hits the newly generated AAOS Node.js skill wrapper and correctly returns the `get_weather` results to the chat.
