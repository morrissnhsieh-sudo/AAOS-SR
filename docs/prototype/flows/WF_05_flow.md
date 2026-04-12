```mermaid
sequenceDiagram
    participant node_manager
    participant auth_manager
    
    node_manager->>node_manager: io_receive_node_registration()
    node_manager->>auth_manager: validate_device_jwt()
    node_manager->>node_manager: register_node()
    node_manager->>node_manager: select_available_node()
    node_manager->>node_manager: io_dispatch_task_to_node()
```
