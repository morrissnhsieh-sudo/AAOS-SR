```mermaid
sequenceDiagram
    participant heartbeat_monitor
    participant channel_manager
    participant memory_system
    
    heartbeat_monitor->>heartbeat_monitor: ping_all_subsystems()
    heartbeat_monitor->>channel_manager: io_deliver_to_ws_client(keepalive)
    heartbeat_monitor->>memory_system: orchestrate_context_compaction()
    heartbeat_monitor->>heartbeat_monitor: flush_session_logs()
```
