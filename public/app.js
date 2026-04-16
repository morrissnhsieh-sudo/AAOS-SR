document.addEventListener('DOMContentLoaded', async () => {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const messagesContainer = document.getElementById('messagesContainer');
    const chatForm = document.getElementById('chatForm');

    // --- View Routing ---
    document.querySelectorAll('.nav-menu a').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            switchView(link.getAttribute('data-view'));
        });
    });

    function switchView(viewId) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('.nav-menu a').forEach(a => a.classList.remove('active'));
        document.getElementById(`view-${viewId}`)?.classList.add('active');
        document.getElementById(`nav-${viewId}`)?.classList.add('active');
        if (viewId === 'memory') loadMemory();
        if (viewId === 'skills') loadSkills();
        if (viewId === 'wiki') loadWikiPages();
        if (viewId === 'usage') loadUsage();
        if (viewId === 'health') loadHealth();
    }

    // --- Auth & WebSocket ---
    let ws, userToken = '';
    let currentThinkingLevel = 'auto';  // per-conversation thinking level
    try {
        const res = await fetch('/auth/ui-token');
        userToken = (await res.json()).token;
    } catch { addSystemMessage('Failed to get auth token.'); return; }

    function connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws/chat?token=${userToken}`);
        ws.onopen = () => {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
            messageInput.disabled = false;
            sendBtn.disabled = false;
            attachBtn.disabled = false;
            addSystemMessage('Connected to USI AI\u2011OS\u00ae - Personal Assistant. Chat with your agent below.');
        };
        ws.onmessage = (event) => {
            try {
                const p = JSON.parse(event.data);
                if (p.type === 'interim') {
                    // Interim events: thinking / step / result — show in-flight without removing the indicator
                    try {
                        const interim = JSON.parse(p.content);
                        addInterimMessage(interim.kind, interim.label, interim.text);
                    } catch { /* ignore malformed interim payload */ }
                } else {
                    // Final response: clear typing indicator and show the agent reply
                    removeTypingIndicator();
                    addAgentMessage(p.content || p.text || event.data);
                }
            } catch {
                removeTypingIndicator();
                addAgentMessage(event.data);
            }
        };
        ws.onclose = () => {
            statusDot.classList.remove('connected');
            statusText.textContent = 'Disconnected...';
            messageInput.disabled = true; sendBtn.disabled = true; attachBtn.disabled = true;
            addSystemMessage('Connection lost. Reconnecting in 3s...');
            setTimeout(connect, 3000);
        };
    }
    connect();

    // --- Thinking Level Button Group ---
    document.getElementById('thinkingLevelGroup').addEventListener('click', e => {
        const btn = e.target.closest('.thinking-btn');
        if (!btn) return;
        currentThinkingLevel = btn.dataset.level;
        document.querySelectorAll('.thinking-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });

    // --- File Attachment ---
    const attachBtn  = document.getElementById('attachBtn');
    const fileInput  = document.getElementById('fileInput');
    const attachPreview = document.getElementById('attachPreview');
    let pendingAttachment = null; // { name, filename, path, webPath, size, mime, isImage, isVideo, previewUrl? }

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        fileInput.value = '';
        await uploadFile(file);
    });

    // Drag-and-drop onto the input area
    document.querySelector('.input-area').addEventListener('dragover', e => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); });
    document.querySelector('.input-area').addEventListener('dragleave', e => e.currentTarget.classList.remove('drag-over'));
    document.querySelector('.input-area').addEventListener('drop', async e => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) await uploadFile(file);
    });

    async function uploadFile(file) {
        showAttachPreview({ name: file.name, size: file.size, uploading: true });
        const form = new FormData();
        form.append('file', file);
        try {
            const res = await fetch('/api/upload', { method: 'POST', body: form });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Upload failed');
            pendingAttachment = { name: data.name, filename: data.filename, path: data.path, webPath: data.webPath, size: data.size, mime: data.mime, isImage: data.isImage, isVideo: data.isVideo };
            if (data.isImage) {
                // For images, generate a local blob URL for instant preview
                const reader = new FileReader();
                reader.onload = e => {
                    pendingAttachment.previewUrl = e.target.result;
                    showAttachPreview(pendingAttachment);
                };
                reader.readAsDataURL(file);
            } else if (data.isVideo) {
                // For video, the server URL is available immediately after upload
                showAttachPreview(pendingAttachment);
            } else {
                showAttachPreview(pendingAttachment);
            }
            messageInput.focus();
        } catch (err) {
            showAttachPreview({ name: file.name, error: err.message });
            setTimeout(clearAttachPreview, 3000);
        }
    }

    function showAttachPreview(info) {
        attachPreview.style.display = 'flex';
        if (info.uploading) {
            attachPreview.innerHTML = `<span class="attach-icon">📎</span><span class="attach-name">${esc(info.name)}</span><span class="attach-status uploading">Uploading...</span>`;
            return;
        }
        if (info.error) {
            attachPreview.innerHTML = `<span class="attach-icon">❌</span><span class="attach-name">${esc(info.name)}</span><span class="attach-status error">${esc(info.error)}</span>`;
            return;
        }
        const sizeStr = info.size > 1024*1024 ? `${(info.size/1024/1024).toFixed(1)} MB` : `${(info.size/1024).toFixed(1)} KB`;
        let icon;
        if (info.isImage && info.previewUrl) {
            icon = `<img class="attach-thumb" src="${info.previewUrl}">`;
        } else if (info.isVideo && info.webPath) {
            icon = `<video class="attach-video-thumb" src="${info.webPath}" preload="metadata" muted></video>`;
        } else {
            icon = fileIcon(info.mime);
        }
        attachPreview.innerHTML = `
            ${icon}
            <div class="attach-info"><span class="attach-name">${esc(info.name)}</span><span class="attach-size">${sizeStr}</span></div>
            <button class="attach-remove" title="Remove">✕</button>`;
        attachPreview.querySelector('.attach-remove').addEventListener('click', clearAttachPreview);
    }

    function clearAttachPreview() {
        pendingAttachment = null;
        attachPreview.style.display = 'none';
        attachPreview.innerHTML = '';
    }

    function fileIcon(mime) {
        if (mime.includes('pdf')) return '📄';
        if (mime.includes('word') || mime.includes('document')) return '📝';
        if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
        if (mime.includes('zip') || mime.includes('compressed')) return '🗜️';
        if (mime.includes('audio')) return '🎵';
        if (mime.includes('video')) return '🎬';
        if (mime.includes('text')) return '📋';
        if (mime.includes('json') || mime.includes('javascript') || mime.includes('python')) return '💻';
        return '📎';
    }

    chatForm.addEventListener('submit', async e => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (!text && !pendingAttachment) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const att = pendingAttachment;
        messageInput.value = '';
        clearAttachPreview();

        // Show user message with optional file badge
        addUserMessage(text, att);

        const wsMsg = { request_id: crypto.randomUUID(), type: 'message', content: text, thinking_level: currentThinkingLevel };
        if (att) wsMsg.attachment = { name: att.name, filename: att.filename, path: att.path, webPath: att.webPath, size: att.size, mime: att.mime, isImage: att.isImage, isVideo: att.isVideo };
        ws.send(JSON.stringify(wsMsg));
        showTypingIndicator();
    });

    // --- Chat Helpers ---
    function ts() { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
    function esc(s) { return String(s).replace(/[&<>'"]/g, t => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t])); }
    function scroll() { messagesContainer.scrollTop = messagesContainer.scrollHeight; }

    // Lightweight markdown renderer — XSS-safe (esc() runs first, then only
    // our own controlled tags are injected). Used for agent messages only.
    function renderMarkdown(raw) {
        // Split on fenced code blocks so their content is never processed as markdown
        const parts = raw.split(/(```[\s\S]*?```)/g);

        return parts.map((part, idx) => {
            if (idx % 2 === 1) {
                // Inside a fenced code block — strip optional language hint, escape, wrap
                const inner = esc(part.replace(/^```\w*\n?/, '').replace(/```$/, ''));
                return `<pre><code>${inner}</code></pre>`;
            }

            // Regular prose — escape HTML first, then apply markdown patterns
            let h = esc(part);

            // Images  ![alt](src)  — rendered before other inline patterns
            // Only allow relative /snapshots/ paths and data URIs to prevent XSS
            h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
                const safeSrc = src.trim();
                if (/^\/snapshots\/[a-zA-Z0-9_.%-]+$/.test(safeSrc) || safeSrc.startsWith('data:image/')) {
                    return `<img class="chat-img" src="${safeSrc}" alt="${esc(alt)}" loading="lazy">`;
                }
                return esc(_); // not an allowed path — render as plain text
            });

            // Inline code  `code`
            h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');

            // Bold + Italic  ***text***
            h = h.replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>');
            // Bold  **text**
            h = h.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
            // Italic  *text*  (must not be adjacent to another *)
            h = h.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
            // Italic  _text_
            h = h.replace(/(?<![\\w])_([^_\n]+)_(?![\\w])/g, '<em>$1</em>');

            // Headings  ### ## #  (line-anchored)
            h = h.replace(/^#### (.+)$/gm, '<h5 class="md-h">$1</h5>');
            h = h.replace(/^### (.+)$/gm,  '<h4 class="md-h">$1</h4>');
            h = h.replace(/^## (.+)$/gm,   '<h3 class="md-h">$1</h3>');
            h = h.replace(/^# (.+)$/gm,    '<h2 class="md-h">$1</h2>');

            // Horizontal rule  ---
            h = h.replace(/^---+$/gm, '<hr class="md-hr">');

            // Bullet lists  - item  or  * item
            h = h.replace(/((?:^[ \t]*[-*][ \t].+(?:\n|$))+)/gm, block => {
                const items = block.trim().split('\n')
                    .map(l => `<li>${l.replace(/^[ \t]*[-*][ \t]/, '').trim()}</li>`)
                    .join('');
                return `<ul class="md-ul">${items}</ul>`;
            });

            // Numbered lists  1. item
            h = h.replace(/((?:^[ \t]*\d+\.[ \t].+(?:\n|$))+)/gm, block => {
                const items = block.trim().split('\n')
                    .map(l => `<li>${l.replace(/^[ \t]*\d+\.[ \t]/, '').trim()}</li>`)
                    .join('');
                return `<ol class="md-ol">${items}</ol>`;
            });

            // Remaining newlines → <br>
            h = h.replace(/\n/g, '<br>');
            return h;
        }).join('');
    }

    function addUserMessage(text, attachment) {
        const el = document.createElement('div');
        el.className = 'message user-msg';
        let attachHtml = '';
        if (attachment) {
            const sizeStr = attachment.size > 1024*1024 ? `${(attachment.size/1024/1024).toFixed(1)} MB` : `${(attachment.size/1024).toFixed(1)} KB`;
            if (attachment.isImage && attachment.previewUrl) {
                attachHtml = `<div class="user-attach-img"><img src="${attachment.previewUrl}" alt="${esc(attachment.name)}" class="chat-img"></div>`;
            } else if (attachment.isVideo && attachment.webPath) {
                attachHtml = `<div class="user-attach-video">
                    <video class="chat-video" controls preload="metadata" src="${attachment.webPath}">
                        Your browser does not support video playback.
                    </video>
                    <div class="video-filename">${esc(attachment.name)} <span class="video-size">${sizeStr}</span></div>
                </div>`;
            } else {
                attachHtml = `<div class="user-attach-badge">${fileIcon(attachment.mime)} <span>${esc(attachment.name)}</span> <small>${sizeStr}</small></div>`;
            }
        }
        el.innerHTML = `${attachHtml}${text ? `<div class="msg-bubble">${esc(text)}</div>` : ''}<div class="msg-time">${ts()}</div>`;
        if (attachment?.isImage) wireImageLightbox(el);
        messagesContainer.appendChild(el); scroll();
    }
    function addAgentMessage(text) {
        const el = document.createElement('div');
        el.className = 'message agent-msg';
        el.innerHTML = `<div class="msg-bubble md-body">${renderMarkdown(text)}</div><div class="msg-time">${ts()}</div>`;
        wireImageLightbox(el);
        messagesContainer.appendChild(el); scroll();
    }
    function addSystemMessage(text) {
        const el = document.createElement('div');
        el.className = 'message system-msg';
        el.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
        messagesContainer.appendChild(el); scroll();
    }

    /**
     * Renders an interim event bubble (thinking / step / result) inline in the chat.
     * These appear while the agent is running, before the final reply arrives.
     *
     * kind = 'thinking' → purple "thought" pill
     * kind = 'step'     → blue tool-call row
     * kind = 'result'   → muted outcome row under the last step
     */
    // Lightbox backdrop — one shared instance for the whole page
    const lightboxBackdrop = document.createElement('div');
    lightboxBackdrop.className = 'img-lightbox-backdrop';
    const lightboxImg = document.createElement('img');
    lightboxBackdrop.appendChild(lightboxImg);
    document.body.appendChild(lightboxBackdrop);
    lightboxBackdrop.addEventListener('click', () => lightboxBackdrop.classList.remove('active'));
    lightboxImg.addEventListener('click', e => e.stopPropagation()); // clicking the image itself doesn't close

    /** Attaches click-to-lightbox handler to all .chat-img elements inside a container. */
    function wireImageLightbox(container) {
        container.querySelectorAll('.chat-img').forEach(img => {
            if (!img.dataset.lightboxWired) {
                img.dataset.lightboxWired = '1';
                img.addEventListener('click', () => {
                    lightboxImg.src = img.src;
                    lightboxImg.alt = img.alt;
                    lightboxBackdrop.classList.add('active');
                });
            }
        });
    }

    function addInterimMessage(kind, label, text) {
        const isImage = text && text.trimStart().startsWith('![');

        if (kind === 'thinking') {
            const el = document.createElement('div');
            el.className = 'message interim-msg interim-thinking';
            el.innerHTML = `
                <div class="interim-bubble thinking-bubble">
                    <span class="interim-label">${esc(label)}</span>
                    ${text ? `<div class="interim-body">${renderMarkdown(text)}</div>` : ''}
                </div>`;
            messagesContainer.appendChild(el);
            wireImageLightbox(el);
            scroll();

        } else if (kind === 'step') {
            const el = document.createElement('div');
            el.className = 'message interim-msg interim-step';
            el.innerHTML = `
                <div class="interim-bubble step-bubble">
                    <span class="interim-label">${esc(label)}</span>
                    ${text ? `<span class="interim-detail">${esc(text)}</span>` : ''}
                </div>`;
            messagesContainer.appendChild(el);
            scroll();

        } else if (kind === 'result') {
            // Image results are skipped here — the full-size image appears in the agent's final reply.
            if (isImage) return;

            // Find the last step bubble using querySelectorAll (not :last-of-type which is unreliable)
            const allSteps = messagesContainer.querySelectorAll('.interim-msg.interim-step .step-bubble');
            const prevStep = allSteps.length ? allSteps[allSteps.length - 1] : null;

            if (prevStep) {
                // Attach as a compact sub-row inside the step bubble
                const r = document.createElement('div');
                r.className = 'step-result';
                r.innerHTML = renderMarkdown(text);
                prevStep.appendChild(r);
                scroll();
            } else {
                // No parent step: render as a standalone result bubble
                const el = document.createElement('div');
                el.className = 'message interim-msg interim-result';
                el.innerHTML = `
                    <div class="interim-bubble result-bubble">
                        <span class="interim-label">${esc(label)}</span>
                        ${text ? `<span class="interim-detail md-body">${renderMarkdown(text)}</span>` : ''}
                    </div>`;
                messagesContainer.appendChild(el);
                scroll();
            }
        }
    }
    let typingEl = null;
    function showTypingIndicator() {
        if (!typingEl) {
            typingEl = document.createElement('div');
            typingEl.className = 'typing-indicator';
            typingEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
            messagesContainer.appendChild(typingEl);
        }
        typingEl.classList.add('active'); scroll();
    }
    function removeTypingIndicator() { typingEl?.classList.remove('active'); }

    // --- Memory ---
    async function loadMemory() {
        const listEl = document.getElementById('factList');
        const countEl = document.getElementById('factCount');
        listEl.innerHTML = '<div class="empty-state">Loading...</div>';
        try {
            const { facts } = await (await fetch('/api/memory')).json();
            countEl.textContent = facts.length;
            if (!facts.length) { listEl.innerHTML = '<div class="empty-state">No memory facts yet. Add one above or chat — facts are auto-extracted!</div>'; return; }
            listEl.innerHTML = '';
            facts.forEach(f => listEl.appendChild(createFactItem(f)));
        } catch { listEl.innerHTML = '<div class="empty-state">Failed to load memory.</div>'; }
    }

    function createFactItem(fact) {
        const el = document.createElement('div');
        el.className = 'fact-item';
        el.innerHTML = `<span>${esc(fact)}</span><button class="delete-btn" title="Delete">✕</button>`;
        el.querySelector('.delete-btn').addEventListener('click', async () => {
            await fetch('/api/memory', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ fact }) });
            loadMemory();
        });
        return el;
    }

    document.getElementById('memoryForm').addEventListener('submit', async e => {
        e.preventDefault();
        const input = document.getElementById('factInput');
        const fact = input.value.trim();
        if (!fact) return;
        await fetch('/api/memory', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ fact }) });
        input.value = ''; loadMemory();
    });

    // --- Skills ---
    async function loadSkills() {
        const listEl = document.getElementById('skillList');
        const countEl = document.getElementById('skillCount');
        listEl.innerHTML = '<div class="empty-state">Loading...</div>';
        try {
            const skills = await (await fetch('/api/skills')).json();
            countEl.textContent = skills.filter(s => s.status === 'enabled').length;
            if (!skills.length) { listEl.innerHTML = '<div class="empty-state">No skills installed yet. Build one above!</div>'; return; }
            listEl.innerHTML = '';
            skills.forEach(s => listEl.appendChild(createSkillItem(s)));
        } catch { listEl.innerHTML = '<div class="empty-state">Failed to load skills.</div>'; }
    }

    function createSkillItem(skill) {
        const el = document.createElement('div');
        el.className = 'skill-item';
        const tools = (skill.allowed_tools||[]).map(t => `<span class="tool-tag">${esc(t)}</span>`).join('');
        el.innerHTML = `
            <div class="skill-info">
                <div class="skill-name">${esc(skill.name)}</div>
                <div class="skill-meta">v${esc(skill.version)} · ${esc(skill.id?.slice(0,8))}...</div>
                ${tools ? `<div class="skill-tools">${tools}</div>` : ''}
            </div>
            <span class="status-badge ${skill.status}">${esc(skill.status)}</span>
            ${skill.status === 'enabled' ? `<button class="delete-btn" title="Disable" style="margin-left:6px">✕</button>` : ''}
        `;
        el.querySelector('.delete-btn')?.addEventListener('click', async () => {
            await fetch(`/api/skills/${skill.id}`, { method: 'DELETE' }); loadSkills();
        });
        return el;
    }

    // AI Skill Builder
    const buildForm = document.getElementById('buildForm');
    const buildStatus = document.getElementById('buildStatus');
    const buildBtn = document.getElementById('buildBtn');

    buildForm.addEventListener('submit', async e => {
        e.preventDefault();
        const desc = document.getElementById('buildDescription').value.trim();
        if (!desc) return;
        buildStatus.className = 'install-status loading';
        buildStatus.textContent = '✨ Generating skill with AI... (this may take 10-30s)';
        buildBtn.disabled = true;
        try {
            const res = await fetch('/api/skills/build', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ description: desc }) });
            const data = await res.json();
            if (res.ok && data.ok) {
                buildStatus.className = 'install-status success';
                const tools = data.allowed_tools || [];
                const toolStr = tools.length ? ` · tools: ${tools.join(', ')}` : '';
                buildStatus.textContent = `✓ Built "${data.skill.name}"${toolStr}`;
                document.getElementById('buildDescription').value = '';
                loadSkills();
            } else {
                buildStatus.className = 'install-status error';
                buildStatus.textContent = `✗ ${data.reason || 'Build failed'}`;
            }
        } catch {
            buildStatus.className = 'install-status error';
            buildStatus.textContent = '✗ Network error during build.';
        }
        buildBtn.disabled = false;
    });

    // Manual Install
    document.getElementById('skillForm').addEventListener('submit', async e => {
        e.preventDefault();
        const statusEl = document.getElementById('installStatus');
        const btn = document.getElementById('installBtn');
        const pkg = document.getElementById('packageInput').value.trim();
        if (!pkg) return;
        statusEl.className = 'install-status loading';
        statusEl.textContent = `Installing ${pkg}...`;
        btn.disabled = true;
        try {
            const res = await fetch('/api/skills/install', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ package_name: pkg }) });
            const data = await res.json();
            if (res.ok) {
                statusEl.className = 'install-status success';
                statusEl.textContent = `✓ Installed ${data.name}`;
                document.getElementById('packageInput').value = '';
                loadSkills();
            } else {
                statusEl.className = 'install-status error';
                statusEl.textContent = `✗ ${data.reason}`;
            }
        } catch {
            statusEl.className = 'install-status error';
            statusEl.textContent = '✗ Network error.';
        }
        btn.disabled = false;
    });

    // --- Model Switcher ---
    const modelSelect = document.getElementById('modelSelect');
    const modelSwitchStatus = document.getElementById('modelSwitchStatus');
    const agentStatus = document.getElementById('agentStatus');

    async function loadModel() {
        try {
            const data = await (await fetch('/api/model')).json();
            modelSelect.innerHTML = '';
            data.available.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.label;
                if (m.id === data.provider) opt.selected = true;
                modelSelect.appendChild(opt);
            });
            modelSelect.disabled = false;
            agentStatus.textContent = `Powered by ${data.label}`;
        } catch {
            agentStatus.textContent = 'Model unknown';
        }
    }

    modelSelect.addEventListener('change', async () => {
        const provider = modelSelect.value;
        modelSelect.disabled = true;
        modelSwitchStatus.textContent = '⏳';
        modelSwitchStatus.className = 'model-switch-status switching';
        try {
            const res = await fetch('/api/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider })
            });
            const data = await res.json();
            if (res.ok && data.ok) {
                agentStatus.textContent = `Powered by ${data.label}`;
                modelSwitchStatus.textContent = '✓';
                modelSwitchStatus.className = 'model-switch-status ok';
                addSystemMessage(`Model switched to ${data.label}`);
            } else {
                modelSwitchStatus.textContent = '✗';
                modelSwitchStatus.className = 'model-switch-status err';
                addSystemMessage(`Failed to switch model: ${data.error || 'unknown error'}`);
            }
        } catch {
            modelSwitchStatus.textContent = '✗';
            modelSwitchStatus.className = 'model-switch-status err';
        }
        modelSelect.disabled = false;
        setTimeout(() => { modelSwitchStatus.textContent = ''; modelSwitchStatus.className = 'model-switch-status'; }, 3000);
    });

    loadModel();

    // --- Per-Agent Model Config ---
    const agentModelsToggle = document.getElementById('agentModelsToggle');
    const agentModelsPanel  = document.getElementById('agentModelsPanel');
    const agentModelRows    = document.getElementById('agentModelRows');
    let agentModelsPanelOpen = false;

    agentModelsToggle.addEventListener('click', () => {
        agentModelsPanelOpen = !agentModelsPanelOpen;
        agentModelsPanel.style.display = agentModelsPanelOpen ? 'block' : 'none';
        agentModelsToggle.classList.toggle('active', agentModelsPanelOpen);
        if (agentModelsPanelOpen) loadAgentModelConfig();
    });

    async function loadAgentModelConfig() {
        try {
            const data = await (await fetch('/api/model-config')).json();
            agentModelRows.innerHTML = '';

            // Show a note about what "default" means
            const note = document.createElement('div');
            note.className = 'agent-model-note';
            note.innerHTML = `Active provider: <strong>${esc(data.active_default.provider)} / ${esc(data.active_default.model)}</strong> — roles marked <em>inherited</em> use this automatically.`;
            agentModelRows.appendChild(note);

            data.roles.forEach(role => {
                const row = document.createElement('div');
                row.className = 'agent-model-row' + (role.is_default ? ' is-inherited' : '');
                row.dataset.role = role.id;

                // Provider select
                const provSel = document.createElement('select');
                provSel.className = 'agent-model-select provider-sel';
                provSel.title = 'Provider';
                data.available_providers.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.label;
                    if (p.id === role.assignment.provider) opt.selected = true;
                    provSel.appendChild(opt);
                });

                // Model select
                const modSel = document.createElement('select');
                modSel.className = 'agent-model-select model-sel';
                modSel.title = 'Model';

                function populateModels(providerId, selectedModel) {
                    modSel.innerHTML = '';
                    const provData = data.available_providers.find(p => p.id === providerId);
                    (provData ? provData.models : []).forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id;
                        opt.textContent = m.label;
                        if (m.id === selectedModel) opt.selected = true;
                        modSel.appendChild(opt);
                    });
                }
                populateModels(role.assignment.provider, role.assignment.model);

                // Status / inherited badge
                const statusEl = document.createElement('span');
                statusEl.className = 'agent-model-status';
                if (role.is_default) {
                    statusEl.textContent = 'inherited';
                    statusEl.className = 'agent-model-inherited';
                }

                // Reset button (only shown when overridden)
                const resetBtn = document.createElement('button');
                resetBtn.className = 'agent-model-reset' + (role.is_default ? ' hidden' : '');
                resetBtn.textContent = '↺';
                resetBtn.title = 'Reset to active provider';

                async function saveRoleModel() {
                    statusEl.textContent = '⏳';
                    statusEl.className = 'agent-model-status saving';
                    resetBtn.classList.remove('hidden');
                    row.classList.remove('is-inherited');
                    try {
                        const res = await fetch(`/api/model-config/${role.id}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ provider: provSel.value, model: modSel.value })
                        });
                        const result = await res.json();
                        if (res.ok && result.ok) {
                            statusEl.textContent = '✓';
                            statusEl.className = 'agent-model-status ok';
                        } else {
                            statusEl.textContent = '✗';
                            statusEl.className = 'agent-model-status err';
                        }
                    } catch {
                        statusEl.textContent = '✗';
                        statusEl.className = 'agent-model-status err';
                    }
                    setTimeout(() => { if (statusEl.textContent !== 'inherited') { statusEl.textContent = ''; statusEl.className = 'agent-model-status'; } }, 3000);
                }

                resetBtn.addEventListener('click', async () => {
                    resetBtn.disabled = true;
                    try {
                        await fetch(`/api/model-config/${role.id}/reset`, { method: 'POST' });
                        await loadAgentModelConfig();  // full reload to show updated active_default
                    } catch { resetBtn.disabled = false; }
                });

                provSel.addEventListener('change', () => { populateModels(provSel.value, null); saveRoleModel(); });
                modSel.addEventListener('change', saveRoleModel);

                const label = document.createElement('span');
                label.className = 'agent-model-role-label';
                label.textContent = role.label;

                row.appendChild(label);
                row.appendChild(provSel);
                row.appendChild(modSel);
                row.appendChild(statusEl);
                row.appendChild(resetBtn);
                agentModelRows.appendChild(row);
            });
        } catch (e) {
            agentModelRows.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load config</div>`;
        }
    }

    // --- Health ---
    async function loadHealth() {
        const subsEl = document.getElementById('subsystemList');
        subsEl.innerHTML = '<div class="empty-state">Fetching health data...</div>';
        try {
            const h = await (await fetch('/api/health')).json();
            document.getElementById('hv-uptime').textContent = formatUptime(h.uptime);
            document.getElementById('hv-sessions').textContent = h.memory?.sessionCount ?? '—';
            document.getElementById('hv-skills-count').textContent = `${h.skills?.enabledCount ?? 0} / ${h.skills?.installedCount ?? 0}`;
            document.getElementById('hv-memory-file').textContent = h.memory?.memoryFileExists ? '✓' : '✗';
            document.getElementById('workspacePath').textContent = h.memory?.workspace || '—';
            subsEl.innerHTML = '';
            (h.subsystems || []).forEach(sub => subsEl.appendChild(createSubsystemItem(sub)));
        } catch { subsEl.innerHTML = '<div class="empty-state">Failed to fetch health. Is the gateway running?</div>'; }
    }

    function createSubsystemItem(sub) {
        const el = document.createElement('div');
        el.className = 'subsystem-item';
        el.innerHTML = `
            <div class="subsystem-dot ${sub.ok ? 'ok' : 'fail'}"></div>
            <div class="subsystem-name">${esc(sub.name)}</div>
            <div class="subsystem-detail">${esc(sub.detail || (sub.ok ? 'OK' : 'Degraded'))}</div>
            ${sub.latency !== undefined ? `<div class="subsystem-latency">${sub.latency}ms</div>` : ''}
        `;
        return el;
    }

    function formatUptime(s) {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    }

    document.getElementById('refreshHealthBtn').addEventListener('click', loadHealth);

    // --- Wiki ---
    let wikiPages = [];
    let wikiSearchTimeout = null;

    async function loadWikiPages() {
        try {
            const data = await (await fetch('/api/wiki/pages')).json();
            wikiPages = data.pages || [];
            renderWikiPageList(wikiPages);
        } catch {
            document.getElementById('wikiPageList').innerHTML = '<div class="empty-state" style="color:#ef4444">Failed to load wiki</div>';
        }
    }

    function renderWikiPageList(pages) {
        const el = document.getElementById('wikiPageList');
        if (pages.length === 0) {
            el.innerHTML = '<div class="empty-state">No wiki pages yet.<br>Ingest a source above to get started.</div>';
            return;
        }
        // Group by prefix
        const groups = {};
        for (const p of pages) {
            const prefix = p.name.includes('/') ? p.name.split('/')[0] : 'other';
            if (!groups[prefix]) groups[prefix] = [];
            groups[prefix].push(p);
        }
        const iconMap = { concepts: '💡', entities: '👤', topics: '🗂️', summaries: '📄', other: '📎' };
        let html = '';
        for (const [group, items] of Object.entries(groups)) {
            html += `<div class="wiki-group">
                <div class="wiki-group-label">${iconMap[group] || '📁'} ${group} <span class="pill">${items.length}</span></div>`;
            for (const p of items) {
                const shortName = p.name.includes('/') ? p.name.split('/').slice(1).join('/') : p.name;
                const kb = (p.size / 1024).toFixed(1);
                html += `<div class="wiki-page-item" data-name="${esc(p.name)}" title="${esc(p.name)}">
                    <span class="wiki-page-name">${esc(shortName)}</span>
                    <span class="wiki-page-meta">${kb}KB</span>
                </div>`;
            }
            html += '</div>';
        }
        el.innerHTML = html;
        el.querySelectorAll('.wiki-page-item').forEach(item => {
            item.addEventListener('click', () => loadWikiPage(item.dataset.name));
        });
    }

    async function loadWikiPage(name) {
        document.querySelectorAll('.wiki-page-item').forEach(el => el.classList.remove('active'));
        const item = document.querySelector(`.wiki-page-item[data-name="${CSS.escape(name)}"]`);
        if (item) item.classList.add('active');

        const contentArea = document.getElementById('wikiContentArea');
        contentArea.innerHTML = '<div class="wiki-loading">Loading...</div>';
        try {
            const data = await (await fetch(`/api/wiki/pages/${name}`)).json();
            if (!data.content) throw new Error('Empty page');
            contentArea.innerHTML = `
                <div class="wiki-page-header">
                    <span class="wiki-breadcrumb">${esc(name)}</span>
                    <span class="wiki-page-size">${(data.content.length/1024).toFixed(1)} KB</span>
                </div>
                <div class="wiki-markdown">${renderWikiMarkdown(data.content)}</div>`;
        } catch (e) {
            contentArea.innerHTML = `<div class="wiki-error">Failed to load page: ${esc(e.message)}</div>`;
        }
    }

    function renderWikiMarkdown(raw) {
        // Extend renderMarkdown with wiki-link support
        let h = esc(raw);
        // Wiki links [[path/name]] → styled span
        h = h.replace(/\[\[([^\]]+)\]\]/g, (_, name) =>
            `<span class="wiki-link" data-target="${esc(name)}" title="Wiki: ${esc(name)}">${esc(name.split('/').pop())}</span>`
        );
        // Fenced code blocks
        h = h.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
        // Inline code
        h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        // Bold + italic
        h = h.replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>');
        h = h.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
        h = h.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
        // Headings
        h = h.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
        h = h.replace(/^### (.+)$/gm,  '<h4>$1</h4>');
        h = h.replace(/^## (.+)$/gm,   '<h3>$1</h3>');
        h = h.replace(/^# (.+)$/gm,    '<h2>$1</h2>');
        // Blockquotes
        h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        // Horizontal rule
        h = h.replace(/^---+$/gm, '<hr>');
        // Bullet lists
        h = h.replace(/((?:^[ \t]*[-*][ \t].+(?:\n|$))+)/gm, block => {
            const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*][ \t]/, '').trim()}</li>`).join('');
            return `<ul>${items}</ul>`;
        });
        // Numbered lists
        h = h.replace(/((?:^[ \t]*\d+\.[ \t].+(?:\n|$))+)/gm, block => {
            const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\.[ \t]/, '').trim()}</li>`).join('');
            return `<ol>${items}</ol>`;
        });
        h = h.replace(/\n/g, '<br>');
        return h;
    }

    // Wiki link clicks navigate to that page
    document.getElementById('view-wiki').addEventListener('click', e => {
        const link = e.target.closest('.wiki-link');
        if (link) loadWikiPage(link.dataset.target);
    });

    // Search
    document.getElementById('wikiSearch').addEventListener('input', e => {
        clearTimeout(wikiSearchTimeout);
        const q = e.target.value.trim().toLowerCase();
        if (!q) { renderWikiPageList(wikiPages); return; }
        wikiSearchTimeout = setTimeout(() => {
            const filtered = wikiPages.filter(p => p.name.toLowerCase().includes(q));
            renderWikiPageList(filtered);
        }, 200);
    });

    // Ingest
    document.getElementById('wikiIngestForm').addEventListener('submit', async e => {
        e.preventDefault();
        const source = document.getElementById('wikiSourceInput').value.trim();
        const focus  = document.getElementById('wikiFocusInput').value.trim();
        if (!source) return;
        const btn    = document.getElementById('wikiIngestBtn');
        const status = document.getElementById('wikiIngestStatus');
        btn.disabled = true;
        status.textContent = '⏳ Compiling...';
        status.className = 'install-status pending';
        try {
            const res = await fetch('/api/wiki/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source, focus: focus || undefined })
            });
            const data = await res.json();
            if (res.ok && data.ok) {
                status.textContent = `✓ ${data.count} page(s) written`;
                status.className = 'install-status ok';
                document.getElementById('wikiSourceInput').value = '';
                document.getElementById('wikiFocusInput').value  = '';
                await loadWikiPages();
                if (data.pages_written?.length) loadWikiPage(data.pages_written[0]);
            } else {
                status.textContent = `✗ ${data.error || 'Failed'}`;
                status.className = 'install-status error';
            }
        } catch (err) {
            status.textContent = `✗ ${err.message}`;
            status.className = 'install-status error';
        }
        btn.disabled = false;
        setTimeout(() => { status.textContent = ''; status.className = 'install-status'; }, 8000);
    });

    // Lint
    document.getElementById('wikiLintBtn').addEventListener('click', async () => {
        const btn = document.getElementById('wikiLintBtn');
        const contentArea = document.getElementById('wikiContentArea');
        btn.disabled = true;
        btn.textContent = '⏳ Linting...';
        contentArea.innerHTML = '<div class="wiki-loading">Running wiki lint audit...</div>';
        try {
            const res = await fetch('/api/wiki/lint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_fix: false }) });
            const data = await res.json();
            contentArea.innerHTML = `
                <div class="wiki-page-header"><span class="wiki-breadcrumb">🔍 Lint Report</span><span class="wiki-page-size">${data.pages_reviewed} pages reviewed</span></div>
                <div class="wiki-markdown">${renderWikiMarkdown(data.report || 'No issues found.')}</div>`;
        } catch (err) {
            contentArea.innerHTML = `<div class="wiki-error">Lint failed: ${esc(err.message)}</div>`;
        }
        btn.disabled = false;
        btn.textContent = '🔍 Lint';
    });

    document.getElementById('wikiRefreshBtn').addEventListener('click', loadWikiPages);

    // --- Usage Dashboard ---
    let usagePeriod = '24h';

    document.getElementById('usagePeriodBtns').addEventListener('click', e => {
        const btn = e.target.closest('.period-btn');
        if (!btn) return;
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        usagePeriod = btn.dataset.period;
        loadUsage();
    });

    async function loadUsage() {
        try {
            const data = await (await fetch(`/api/usage?period=${usagePeriod}`)).json();
            const s = data.summary;

            // Summary cards
            document.getElementById('uc-cost').textContent   = formatCost(s.total_cost_usd);
            document.getElementById('uc-tokens').textContent = formatNum(s.total_tokens);
            document.getElementById('uc-input').textContent    = formatNum(s.total_input_tokens);
            document.getElementById('uc-output').textContent   = formatNum(s.total_output_tokens);
            document.getElementById('uc-thinking').textContent = formatNum(s.total_thinking_tokens ?? 0);
            document.getElementById('uc-calls').textContent    = s.call_count;
            document.getElementById('uc-avg').textContent    = s.call_count ? formatCost(s.total_cost_usd / s.call_count) : '$0.000000';

            // Timeline chart
            drawUsageChart(s.timeline);

            // By role breakdown
            renderBreakdown('usageByRole', s.by_role, s.total_cost_usd);

            // By model breakdown
            renderBreakdown('usageByModel', s.by_model, s.total_cost_usd);

            // Activity log
            const log = document.getElementById('usageActivityLog');
            document.getElementById('usageActivityCount').textContent = data.recent.length;
            if (data.recent.length === 0) {
                log.innerHTML = '<div class="empty-state">No activity in this period.</div>';
            } else {
                log.innerHTML = data.recent.map(r => `
                    <div class="usage-activity-row">
                        <div class="ua-meta">
                            <span class="ua-role ${r.role}">${roleIcon(r.role)} ${r.role}</span>
                            <span class="ua-time">${fmtTime(r.timestamp)}</span>
                        </div>
                        <div class="ua-model">${esc(r.model)}</div>
                        <div class="ua-activity">${esc(r.activity || '—')}</div>
                        <div class="ua-stats">
                            <span class="ua-tokens">${formatNum(r.total_tokens)} tok</span>
                            <span class="ua-cost">${formatCost(r.cost_usd)}</span>
                        </div>
                    </div>`).join('');
            }
        } catch (e) {
            console.error('Usage load failed:', e);
        }
    }

    function renderBreakdown(elId, byMap, totalCost) {
        const el = document.getElementById(elId);
        const entries = Object.entries(byMap).sort((a, b) => b[1].cost_usd - a[1].cost_usd);
        if (entries.length === 0) { el.innerHTML = '<div class="empty-state">No data.</div>'; return; }
        const maxCost = entries[0][1].cost_usd || 1;
        el.innerHTML = entries.map(([key, v]) => {
            const pct = Math.round((v.cost_usd / (totalCost || 1)) * 100);
            const barW = Math.max(2, Math.round((v.cost_usd / maxCost) * 100));
            return `<div class="usage-bk-row">
                <div class="usage-bk-label" title="${esc(key)}">${esc(key.split('/').pop())}</div>
                <div class="usage-bk-bar-wrap"><div class="usage-bk-bar" style="width:${barW}%"></div></div>
                <div class="usage-bk-nums">
                    <span>${formatCost(v.cost_usd)}</span>
                    <span class="usage-bk-pct">${pct}%</span>
                </div>
            </div>`;
        }).join('');
    }

    function drawUsageChart(timeline) {
        const canvas = document.getElementById('usageChart');
        const empty  = document.getElementById('usageChartEmpty');
        if (!timeline || timeline.length === 0) {
            canvas.style.display = 'none';
            empty.style.display = 'block';
            return;
        }
        canvas.style.display = 'block';
        empty.style.display = 'none';

        const dpr = window.devicePixelRatio || 1;
        const W = canvas.parentElement.clientWidth - 32;
        const H = 140;
        canvas.width  = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width  = W + 'px';
        canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const PAD = { top: 12, right: 16, bottom: 36, left: 60 };
        const chartW = W - PAD.left - PAD.right;
        const chartH = H - PAD.top - PAD.bottom;

        const maxCost = Math.max(...timeline.map(t => t.cost_usd), 0.000001);
        const barW = Math.max(4, Math.floor(chartW / timeline.length) - 2);

        // Background
        ctx.clearRect(0, 0, W, H);

        // Grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = PAD.top + chartH - (i / 4) * chartH;
            ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + chartW, y); ctx.stroke();
            ctx.fillStyle = 'rgba(148,163,184,0.7)';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(formatCost(maxCost * i / 4), PAD.left - 6, y + 4);
        }

        // Bars
        timeline.forEach((t, i) => {
            const x = PAD.left + i * (chartW / timeline.length) + (chartW / timeline.length - barW) / 2;
            const barH = Math.max(2, (t.cost_usd / maxCost) * chartH);
            const y = PAD.top + chartH - barH;

            // Bar gradient
            const grad = ctx.createLinearGradient(0, y, 0, y + barH);
            grad.addColorStop(0, 'rgba(99,102,241,0.9)');
            grad.addColorStop(1, 'rgba(99,102,241,0.3)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
            ctx.fill();
        });

        // X-axis labels (show ~6 labels max)
        const step = Math.max(1, Math.ceil(timeline.length / 6));
        ctx.fillStyle = 'rgba(148,163,184,0.7)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        timeline.forEach((t, i) => {
            if (i % step !== 0) return;
            const x = PAD.left + i * (chartW / timeline.length) + (chartW / timeline.length) / 2;
            ctx.fillText(fmtAxisLabel(t.bucket, usagePeriod), x, PAD.top + chartH + 18);
        });
    }

    // ── Helpers ──
    function formatCost(usd) {
        if (usd === 0) return '$0.000000';
        if (usd < 0.000001) return `$${usd.toExponential(2)}`;
        if (usd < 0.01) return `$${usd.toFixed(6)}`;
        if (usd < 1)    return `$${usd.toFixed(4)}`;
        return `$${usd.toFixed(2)}`;
    }
    function formatNum(n) {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
        if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
        return String(n);
    }
    function fmtTime(iso) {
        const d = new Date(iso);
        return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    function fmtAxisLabel(iso, period) {
        const d = new Date(iso);
        if (period === '1h' || period === '6h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (period === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `${d.getMonth()+1}/${d.getDate()}`;
    }
    function roleIcon(role) {
        const icons = { chatbot: '💬', skill_builder: '⚡', wiki_compiler: '📖', memory_extractor: '🧠' };
        return icons[role] || '🤖';
    }

    // ══════════════════════════════════════════════════════
    // 🗓  SCHEDULER DASHBOARD
    // ══════════════════════════════════════════════════════

    const scheduleList      = document.getElementById('scheduleList');
    const scheduleCount     = document.getElementById('scheduleCount');
    const scheduleNewBtn    = document.getElementById('scheduleNewBtn');
    const schedCancelBtn    = document.getElementById('schedCancelBtn');
    const scheduleRefreshBtn= document.getElementById('scheduleRefreshBtn');
    const scheduleCreateCard= document.getElementById('scheduleCreateCard');
    const scheduleForm      = document.getElementById('scheduleForm');
    const schedRunResult    = document.getElementById('schedRunResult');

    // Register view switch
    const _origSwitchView = switchView;
    // Patch switchView to load scheduler when needed
    document.querySelectorAll('.nav-menu a').forEach(link => {
        if (link.getAttribute('data-view') === 'schedule') {
            link.addEventListener('click', () => loadScheduler());
        }
    });

    scheduleNewBtn?.addEventListener('click', () => {
        const visible = scheduleCreateCard.style.display !== 'none';
        scheduleCreateCard.style.display = visible ? 'none' : 'block';
        if (!visible) document.getElementById('sched-name')?.focus();
    });

    schedCancelBtn?.addEventListener('click', () => {
        scheduleCreateCard.style.display = 'none';
        scheduleForm.reset();
        document.getElementById('schedFormStatus').textContent = '';
    });

    scheduleRefreshBtn?.addEventListener('click', loadScheduler);

    scheduleForm?.addEventListener('submit', async e => {
        e.preventDefault();
        const status = document.getElementById('schedFormStatus');
        const name    = document.getElementById('sched-name').value.trim();
        const cron    = document.getElementById('sched-cron').value.trim();
        const message = document.getElementById('sched-message').value.trim();
        const notify  = document.getElementById('sched-notify').checked;
        if (!name || !cron || !message) { status.textContent = '⚠ All fields are required.'; return; }
        status.textContent = 'Creating…';
        document.getElementById('schedSaveBtn').disabled = true;
        try {
            const res = await fetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, cron, message, notify })
            });
            const data = await res.json();
            if (!data.ok) { status.textContent = `❌ ${data.error}`; return; }
            status.textContent = '✅ Job created!';
            scheduleForm.reset();
            setTimeout(() => {
                scheduleCreateCard.style.display = 'none';
                status.textContent = '';
            }, 1200);
            loadScheduler();
        } catch (err) {
            status.textContent = `❌ ${err.message}`;
        } finally {
            document.getElementById('schedSaveBtn').disabled = false;
        }
    });

    async function loadScheduler() {
        try {
            const res  = await fetch('/api/schedule');
            const jobs = await res.json();
            scheduleCount.textContent = jobs.length;
            if (!jobs.length) {
                scheduleList.innerHTML = '<div class="empty-state">No scheduled jobs yet. Click <strong>+ New Job</strong> to create one.</div>';
                return;
            }
            scheduleList.innerHTML = jobs.map(renderJobCard).join('');
            // Bind action buttons
            jobs.forEach(job => {
                document.getElementById(`run-${job.name}`)?.addEventListener('click',    () => runJobNow(job.name));
                document.getElementById(`pause-${job.name}`)?.addEventListener('click',  () => pauseJob(job.name));
                document.getElementById(`resume-${job.name}`)?.addEventListener('click', () => resumeJob(job.name));
                document.getElementById(`del-${job.name}`)?.addEventListener('click',    () => deleteJob(job.name));
            });
        } catch (err) {
            scheduleList.innerHTML = `<div class="empty-state">Failed to load jobs: ${err.message}</div>`;
        }
    }

    function renderJobCard(job) {
        const isActive  = job.enabled;
        const isError   = job.last_status === 'error';
        const dotClass  = isError ? 'error' : isActive ? 'active' : 'paused';
        const cardClass = isError ? 'job-error' : !isActive ? 'job-paused' : '';

        const tags = (job.tags || []).map(t => `<span class="job-tag">${t}</span>`).join('');
        const notifyBadge = job.notify ? '<span class="job-notify-badge">🔔 notify</span>' : '';

        const lastRunText = job.last_run_at
            ? `<span class="job-meta-item job-last-${job.last_status}">
                 ${job.last_status === 'ok' ? '✓' : '✗'} ${fmtTime(job.last_run_at)}
               </span>`
            : '<span class="job-meta-item job-last-never">Never run</span>';

        const pauseBtn = isActive
            ? `<button class="job-btn pause-btn" id="pause-${job.name}" title="Pause">⏸ Pause</button>`
            : `<button class="job-btn resume-btn" id="resume-${job.name}" title="Resume">▶ Resume</button>`;

        return `
        <div class="job-card ${cardClass}">
            <div class="job-card-top">
                <div class="job-status-dot ${dotClass}"></div>
                <div class="job-main">
                    <div class="job-name-row">
                        <span class="job-name">${job.name}</span>
                        <span class="job-cron">${job.cron}</span>
                        ${notifyBadge}
                        ${tags}
                    </div>
                    <div class="job-message" title="${job.message}">${job.message}</div>
                    <div class="job-meta">
                        ${lastRunText}
                        <span class="job-meta-item">🔁 ${job.run_count || 0} run${job.run_count !== 1 ? 's' : ''}</span>
                        <span class="job-meta-item">📅 Created ${fmtTime(job.created_at)}</span>
                    </div>
                </div>
                <div class="job-actions">
                    <button class="job-btn run-btn" id="run-${job.name}" title="Run Now">▶ Run</button>
                    ${pauseBtn}
                    <button class="job-btn del-btn" id="del-${job.name}" title="Delete">🗑</button>
                </div>
            </div>
        </div>`;
    }

    async function runJobNow(name) {
        const btn = document.getElementById(`run-${name}`);
        if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
        try {
            const res  = await fetch(`/api/schedule/${name}/run`, { method: 'POST' });
            const data = await res.json();
            showRunResult(name, data.ok ? data.result : `❌ ${data.error}`, data.ok);
            loadScheduler();
        } catch (err) {
            showRunResult(name, `❌ ${err.message}`, false);
        } finally {
            if (btn) { btn.textContent = '▶ Run'; btn.disabled = false; }
        }
    }

    async function pauseJob(name) {
        await fetch(`/api/schedule/${name}/pause`, { method: 'POST' });
        loadScheduler();
    }

    async function resumeJob(name) {
        await fetch(`/api/schedule/${name}/resume`, { method: 'POST' });
        loadScheduler();
    }

    async function deleteJob(name) {
        if (!confirm(`Delete job "${name}"? This cannot be undone.`)) return;
        await fetch(`/api/schedule/${name}`, { method: 'DELETE' });
        loadScheduler();
    }

    function showRunResult(jobName, text, ok) {
        schedRunResult.style.display = 'block';
        schedRunResult.innerHTML = `
            <span class="sched-run-result-close" id="schedRunClose">✕</span>
            <div class="sched-run-result-header">${ok ? '✅' : '❌'} Run result — ${jobName}</div>
            <div class="sched-run-result-body">${text || '(no output)'}</div>`;
        document.getElementById('schedRunClose')?.addEventListener('click', () => {
            schedRunResult.style.display = 'none';
        });
        // Auto-dismiss after 15 seconds
        setTimeout(() => { schedRunResult.style.display = 'none'; }, 15000);
    }

    // Also hook into the existing switchView so scheduler loads on nav click
    const _patchedNav = document.getElementById('nav-schedule');
    if (_patchedNav) {
        _patchedNav.addEventListener('click', () => setTimeout(loadScheduler, 0));
    }
});
