```mermaid
sequenceDiagram
    participant memory_system
    participant agent_runner
    
    memory_system->>memory_system: orchestrate_context_compaction()
    memory_system->>agent_runner: start_agent_run(summarization)
    agent_runner-->>memory_system: summary
    memory_system->>memory_system: io_write_to_memory_md() / session_log
```
