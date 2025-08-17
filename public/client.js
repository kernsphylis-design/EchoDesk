document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // DOM Elements
    const agentSelectionDiv = document.getElementById('agent-selection');
    const agentGrid = document.getElementById('agent-grid');
    const refreshBtn = document.getElementById('refresh-agents');
    const chatWindowDiv = document.getElementById('chat-window');
    const messagesDiv = document.getElementById('messages');
    const chatInfoDiv = document.getElementById('chat-info');
    const chatHeaderDiv = document.getElementById('chat-header');
    const backBtn = document.getElementById('back-to-agents');
    const agentNameEl = document.getElementById('agent-name');
    const agentAvatarEl = document.getElementById('agent-avatar');
    // Top banner elements
    const bannerEl = document.getElementById('top-banner');
    const bannerCloseBtn = document.getElementById('banner-close');
    const form = document.getElementById('form');
    const input = document.getElementById('input');

    let selectedAgentName = '';
    let selectedAgentId = null;
    // messagesByAgent: { [agentId]: [ { sender, text, messageClass, ts } ] }
    let messagesByAgent = {};
    let sessionId = null;
    let userId = null;
    let lastRenderedAgentId = null;
    // Audio notification state
    let audioCtx = null;
    let canPlaySound = true; // simple flag in case we later add a mute toggle

    // --- Event Listeners ---
    // Initialize top banner visibility (always show on load)
    (function initTopBanner() {
        try {
            if (bannerEl) bannerEl.classList.remove('hidden');
            if (bannerCloseBtn) {
                bannerCloseBtn.addEventListener('click', () => {
                    if (bannerEl) bannerEl.classList.add('hidden');
                });
            }
        } catch (e) {}
    })();

    // Stable session id for this browser tab
    function getOrCreateSessionId() {
        try {
            const existing = sessionStorage.getItem('session_id');
            if (existing) return existing;
        } catch (e) {}
        const sid = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        try { sessionStorage.setItem('session_id', sid); } catch (e) {}
        return sid;
    }

    function registerSession() {
        sessionId = getOrCreateSessionId();
        socket.emit('register_session', sessionId);
    }

    socket.on('connect', () => {
        registerSession();
        registerUser();
        // Ask for latest agents on connect
        socket.emit('request_agents');
    });

    // Persistent user id for this browser (survives refresh and tabs)
    function getOrCreateUserId() {
        try {
            const existing = localStorage.getItem('user_id');
            if (existing) return existing;
        } catch (e) {}
        const uid = 'u_' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
        try { localStorage.setItem('user_id', uid); } catch (e) {}
        return uid;
    }

    function registerUser() {
        userId = getOrCreateUserId();
        socket.emit('register_user', userId);
    }

    // Ensure userId is available before attempting restore
    userId = getOrCreateUserId();

    // Enforce initial state: show selection, hide chat header/info and input form
    agentSelectionDiv.classList.remove('hidden');
    chatWindowDiv.classList.add('hidden');
    if (chatHeaderDiv) chatHeaderDiv.classList.add('hidden');
    if (chatInfoDiv) chatInfoDiv.classList.add('hidden');
    if (form) form.classList.add('hidden');

    // Update agent list from server (render as cards)
    socket.on('update_agents', (agents) => {
        renderAgentCards(agents);
        // If we restored a selection, ensure we re-select on the server
        if (selectedAgentId) {
            socket.emit('select_agent', selectedAgentId);
        }
    });

    // Manual refresh
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            socket.emit('request_agents');
        });
    }

    // Periodic refresh (keep list fresh)
    setInterval(() => {
        socket.emit('request_agents');
    }, 15000);

    // Handle agent selection confirmation
    socket.on('agent_selected', (agentName) => {
        selectedAgentName = agentName;
        chatWindowDiv.classList.remove('hidden');
        chatInfoDiv.textContent = `正在与 ${selectedAgentName} 客服聊天`;
        if (chatHeaderDiv) chatHeaderDiv.classList.remove('hidden');
        if (chatInfoDiv) chatInfoDiv.classList.remove('hidden');
        // update chat header
        agentNameEl.textContent = selectedAgentName;
        const initial = (selectedAgentName || '?').trim().charAt(0).toUpperCase();
        agentAvatarEl.textContent = initial || 'K';
        if (form) form.classList.remove('hidden');
        saveSession();
        // Render messages for this agent (guard against duplicate rendering)
        if (selectedAgentId && lastRenderedAgentId !== selectedAgentId) {
            renderMessagesForSelectedAgent();
        }
        // Highlight selected in sidebar if cards already rendered
        if (selectedAgentId) {
            const card = document.querySelector(`.agent-card[data-id="${selectedAgentId}"]`);
            if (card) {
                document.querySelectorAll('.agent-card.selected').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
            }
        }
    });

    // Back to agent selection
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            chatWindowDiv.classList.add('hidden');
            agentSelectionDiv.classList.remove('hidden');
            messagesDiv.innerHTML = '';
            chatInfoDiv.textContent = '';
            selectedAgentName = '';
            if (form) form.classList.add('hidden');
        });
    }

    // Handle form submission to send a message
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!selectedAgentName) {
            alert('请先选择客服');
            return;
        }
        if (input.value) {
            const message = input.value;
            socket.emit('web_message', { message });
            appendMessage('我', message, 'user-message', { ts: Date.now(), persist: true });
            input.value = '';
        }
    });

    // Display incoming messages from an agent
    socket.on('agent_message', (data) => {
        // Normalize to string to avoid number/string mismatch
        const aid = (data && data.agentId != null) ? String(data.agentId) : selectedAgentId;
        appendMessage(data.agentName, data.message, 'agent-message', { ts: data.ts, persist: true, agentId: aid });
        // If the message is for the currently selected agent, it will appear immediately via appendMessage
        playNotify();
    });

    // Display error messages
    socket.on('error_message', (message) => {
        alert(message);
    });

    // --- Helper Functions ---
    function playNotify() {
        if (!canPlaySound) return;
        try {
            if (!audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return; // unsupported
                audioCtx = new AC();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            const now = audioCtx.currentTime;
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(880, now); // A5
            g.gain.setValueAtTime(0.0001, now);
            g.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
            o.connect(g);
            g.connect(audioCtx.destination);
            o.start(now);
            o.stop(now + 0.2);
        } catch (e) {
            // ignore audio errors
        }
    }

    function renderAgentCards(agents) {
        agentGrid.innerHTML = '';
        if (!agents || agents.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '暂无客服在线，请稍后重试';
            empty.style.color = '#6b7280';
            empty.style.fontSize = '14px';
            empty.style.textAlign = 'center';
            agentGrid.appendChild(empty);
            return;
        }
        agents.forEach(agent => {
            const card = document.createElement('div');
            card.className = 'agent-card';
            card.setAttribute('data-id', agent.id);

            const nameEl = document.createElement('div');
            nameEl.className = 'agent-name';
            nameEl.textContent = agent.name;

            const metaEl = document.createElement('div');
            metaEl.className = 'agent-meta';
            metaEl.textContent = '点击开始聊天';

            card.appendChild(nameEl);
            card.appendChild(metaEl);

            card.addEventListener('click', () => {
                // visual selection
                document.querySelectorAll('.agent-card.selected').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                selectedAgentId = card.getAttribute('data-id');
                selectedAgentName = agent.name;
                saveSession();
                socket.emit('select_agent', selectedAgentId);
                // Immediately show this agent's history without waiting for echo
                // Also unhide the chat UI immediately for better UX
                chatWindowDiv.classList.remove('hidden');
                if (chatHeaderDiv) chatHeaderDiv.classList.remove('hidden');
                if (chatInfoDiv) chatInfoDiv.classList.remove('hidden');
                if (form) form.classList.remove('hidden');
                chatInfoDiv.textContent = `正在与 ${selectedAgentName} 客服聊天`;
                agentNameEl.textContent = selectedAgentName || '客服';
                const initial = (selectedAgentName || '?').trim().charAt(0).toUpperCase();
                agentAvatarEl.textContent = initial || 'K';
                renderMessagesForSelectedAgent();
            });

            agentGrid.appendChild(card);
        });
        // Re-highlight previously selected agent after render
        if (selectedAgentId) {
            const selectedCard = document.querySelector(`.agent-card[data-id="${selectedAgentId}"]`);
            if (selectedCard) selectedCard.classList.add('selected');
        }
    }

    function formatTime(ts) {
        try {
            const d = new Date(typeof ts === 'number' ? ts : Date.now());
            const pad = (n) => (n < 10 ? '0' + n : '' + n);
            const y = d.getFullYear();
            const m = pad(d.getMonth() + 1);
            const dd = pad(d.getDate());
            const hh = pad(d.getHours());
            const mm = pad(d.getMinutes());
            return `${y}-${m}-${dd} ${hh}:${mm}`;
        } catch (e) {
            return '';
        }
    }

    function appendMessage(sender, text, messageClass, opts = { persist: true, ts: null, agentId: null }) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', messageClass);

        const senderElement = document.createElement('div');
        senderElement.classList.add('sender');
        senderElement.textContent = sender;

        const textElement = document.createElement('div');
        textElement.classList.add('text');
        textElement.textContent = text;

        const ts = opts && typeof opts.ts === 'number' ? opts.ts : Date.now();
        const timeElement = document.createElement('div');
        timeElement.classList.add('meta');
        timeElement.textContent = formatTime(ts);

        messageElement.appendChild(senderElement);
        messageElement.appendChild(textElement);
        messageElement.appendChild(timeElement);
        // Only render to DOM if this message belongs to the currently selected agent
        // For user-sent messages, they always belong to selectedAgentId
        const belongAgentId = (opts && opts.agentId != null) ? String(opts.agentId) : selectedAgentId;
        if (String(belongAgentId) === String(selectedAgentId)) {
            messagesDiv.appendChild(messageElement);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        // persist only when requested (default true)
        if (opts && opts.persist) {
            const aid = (belongAgentId != null ? String(belongAgentId) : selectedAgentId);
            if (!aid) return; // nothing to persist without agent context
            if (!messagesByAgent[aid]) messagesByAgent[aid] = [];
            messagesByAgent[aid].push({ sender, text, messageClass, ts });
            saveSession();
        }
    }

    function renderMessagesForSelectedAgent() {
        messagesDiv.innerHTML = '';
        const list = (selectedAgentId && messagesByAgent[String(selectedAgentId)]) ? messagesByAgent[String(selectedAgentId)] : [];
        list.forEach(m => appendMessage(m.sender, m.text, m.messageClass, { persist: false, ts: m.ts, agentId: selectedAgentId }));
        lastRenderedAgentId = selectedAgentId;
    }

    // --- Session Persistence ---
    function getStateKey() {
        const uid = userId || getOrCreateUserId();
        return `chat_state_${uid}`;
    }

    function saveSession() {
        const state = {
            selectedAgentId,
            selectedAgentName,
            messagesByAgent,
        };
        try {
            localStorage.setItem(getStateKey(), JSON.stringify(state));
        } catch (e) { /* ignore quota errors */ }
    }

    function restoreSession() {
        try {
            const raw = localStorage.getItem(getStateKey());
            if (!raw) return;
            const state = JSON.parse(raw);
            if (!state) return;
            selectedAgentId = state.selectedAgentId || null;
            selectedAgentName = state.selectedAgentName || '';
            // Migration: if legacy flat messages exist, fold them under selectedAgentId
            if (Array.isArray(state.messages)) {
                messagesByAgent = {};
                if (state.selectedAgentId) {
                    messagesByAgent[state.selectedAgentId] = state.messages;
                }
            } else {
                messagesByAgent = state.messagesByAgent && typeof state.messagesByAgent === 'object' ? state.messagesByAgent : {};
            }

            if (selectedAgentId) {
                // Restore UI immediately (keep sidebar visible)
                chatWindowDiv.classList.remove('hidden');
                if (chatHeaderDiv) chatHeaderDiv.classList.remove('hidden');
                if (chatInfoDiv) chatInfoDiv.classList.remove('hidden');
                if (form) form.classList.remove('hidden');

                agentNameEl.textContent = selectedAgentName || '客服';
                const initial = (selectedAgentName || '?').trim().charAt(0).toUpperCase();
                agentAvatarEl.textContent = initial || 'K';
                chatInfoDiv.textContent = selectedAgentName ? `正在与 ${selectedAgentName} 客服聊天` : '';

                // Re-render messages for selected agent
                renderMessagesForSelectedAgent();

                // Re-select on server so routing works for the new socket
                socket.emit('select_agent', selectedAgentId);
            }
        } catch (e) { /* ignore parse errors */ }
    }

    // Run restore on load
    restoreSession();
});
