```mermaid
sequenceDiagram
    participant skill_manager
    participant tool_dispatcher
    
    skill_manager->>skill_manager: parse_skill_manifest_yaml()
    skill_manager->>skill_manager: io_run_npm_install()
    skill_manager->>tool_dispatcher: register_tool()
    skill_manager->>tool_dispatcher: register_skill_tools()
```
