var socket;
var state = { buffers: [] };
var activeBuffer = { networkId: null, bufferName: null };

function getActiveNetwork() {
    return state.buffers.find(function(n) { return n.networkId === activeBuffer.networkId; });
}

function getActiveBufferObj() {
    var net = getActiveNetwork();
    if (!net) return null;
    return net.buffers.find(function(b) { return b.name === activeBuffer.bufferName; });
}

function setActiveBuffer(networkId, bufferName) {
    var old = activeBuffer;
    activeBuffer = { networkId: networkId, bufferName: bufferName };
    var net = getActiveNetwork();
    if (net) {
        var buf = net.buffers.find(function(b) { return b.name === bufferName; });
        if (buf) {
            buf.unreadCount = 0;
            buf.highlight = false;
        }
    }
    if (old.networkId && old.networkId !== networkId) {
        var oldNet = state.buffers.find(function(n) { return n.networkId === old.networkId; });
        if (oldNet) {
            var oldBuf = oldNet.buffers.find(function(b) { return b.name === old.bufferName; });
            if (oldBuf) {
                oldBuf.unreadCount = 0;
                oldBuf.highlight = false;
            }
        }
    }
}

function computeFlatBuffers() {
    var flat = [];
    state.buffers.forEach(function(net) {
        if (net.collapsed) {
            flat.push({ networkId: net.networkId, bufferName: '_server', network: net });
        } else {
            net.buffers.forEach(function(buf) {
                flat.push({ networkId: net.networkId, bufferName: buf.name, network: net, buffer: buf });
            });
        }
    });
    return flat;
}

function findBufferIndex(networkId, bufferName) {
    var flat = computeFlatBuffers();
    for (var i = 0; i < flat.length; i++) {
        if (flat[i].networkId === networkId && flat[i].bufferName === bufferName) return i;
    }
    return -1;
}

function findNextBuffer(direction, unreadOnly) {
    var flat = computeFlatBuffers();
    if (flat.length === 0) return null;
    var idx = findBufferIndex(activeBuffer.networkId, activeBuffer.bufferName);
    if (idx < 0) idx = 0;
    var start = idx;
    var step = direction === 'next' ? 1 : -1;
    do {
        idx = (idx + step + flat.length) % flat.length;
        if (!unreadOnly) return flat[idx];
        var b = flat[idx].buffer;
        if (b && b.unreadCount > 0) return flat[idx];
    } while (idx !== start);
    return null;
}

function connectWebSocket() {
    var wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
    socket = new WebSocket(wsUrl);

    socket.addEventListener('open', function() {
        var statusEl = document.querySelector('.status');
        if (statusEl) statusEl.textContent = 'Connected';
    });

    socket.addEventListener('close', function() {
        var statusEl = document.querySelector('.status');
        if (statusEl) statusEl.textContent = 'Disconnected';
        setTimeout(connectWebSocket, 3000);
    });

    socket.addEventListener('message', function(event) {
        try {
            var data = JSON.parse(event.data);
            if (data.type === 'sync') {
                state.buffers = data.networks || [];
                state.buffers.forEach(function(net) {
                    if (net.id && !net.networkId) net.networkId = net.id;
                    if (!net.buffers) net.buffers = [];
                    if (net.buffers.length === 0 || net.buffers[0].type !== 'server') {
                        net.buffers.unshift({ name: '_server', type: 'server', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] });
                    }
                    if (typeof net.collapsed === 'undefined') net.collapsed = false;
                });
                renderSidebar();
                if (!activeBuffer.networkId && state.buffers.length > 0) {
                    var first = state.buffers[0];
                    if (first.buffers.length > 0) {
                        switchBuffer(first.networkId, first.buffers[0].name);
                    }
                }
            } else if (data.type === 'irc_event') {
                handleIRCEvent(data);
            }
        } catch(e) { console.error(e); }
    });
}

function renderSidebar() {
    var container = document.getElementById('networks');
    var html = '';
    state.buffers.forEach(function(net) {
        var netUnread = net.buffers.reduce(function(sum, b) { return sum + (b.unreadCount || 0); }, 0);
        var netHighlight = net.buffers.some(function(b) { return b.highlight; });
        var collapsed = net.collapsed;
        var chevron = collapsed ? '▶' : '▼';

        html += '<div class="network">';
        html += '<div class="network-header" onclick="toggleNetwork(\'' + net.networkId + '\')">';
        html += '<span class="network-chevron">' + chevron + '</span>';
        html += '<span class="network-status ' + (net.connected ? '' : 'disconnected') + '"></span>';
        html += '<span class="network-name-text">' + escapeHtml(net.name) + '</span>';
        if (netUnread > 0) {
            html += '<span class="unread network-unread ' + (netHighlight ? 'highlight' : '') + '">' + netUnread + '</span>';
        }
        html += '</div>';

        if (!collapsed) {
            html += '<div class="network-buffers">';
            net.buffers.forEach(function(buf) {
                var isActive = (net.networkId === activeBuffer.networkId && buf.name === activeBuffer.bufferName);
                var activeClass = isActive ? 'active' : '';
                var label = buf.name === '_server' ? 'Server' : escapeHtml(buf.name);
                html += '<div class="buffer-item ' + activeClass + ' ' + (buf.highlight ? 'highlight' : '') + '" onclick="switchBuffer(\'' + net.networkId + '\', \'' + escapeHtml(buf.name).replace(/\\'/g, "\\\\'").replace(/'/g, "\\'") + '\')">';
                html += '<span class="buffer-name">' + label + '</span>';
                if (buf.unreadCount > 0) {
                    html += '<span class="unread buffer-unread">' + buf.unreadCount + '</span>';
                }
                html += '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
    });
    container.innerHTML = html;
}

function toggleNetwork(networkId) {
    var net = state.buffers.find(function(n) { return n.networkId === networkId; });
    if (net) {
        net.collapsed = !net.collapsed;
        renderSidebar();
    }
}

function renderUsers() {
    var ul = document.getElementById('users');
    if (!ul) return;
    var net = getActiveNetwork();
    if (!net || !activeBuffer.bufferName || activeBuffer.bufferName === '_server') {
        ul.innerHTML = '';
        return;
    }
    var ch = net.buffers.find(function(c) { return c.name === activeBuffer.bufferName; });
    if (!ch || !ch.users) {
        ul.innerHTML = '';
        return;
    }
    var html = '';
    ch.users.forEach(function(u) {
        var cls = '';
        if (u.startsWith('~')) cls = 'owner';
        else if (u.startsWith('@')) cls = 'op';
        else if (u.startsWith('+')) cls = 'voice';
        html += '<li class="' + cls + '">' + escapeHtml(u) + '</li>';
    });
    ul.innerHTML = html;
}

function switchBuffer(networkId, bufferName) {
    setActiveBuffer(networkId, bufferName);
    var bufObj = getActiveBufferObj();
    var displayName = bufferName === '_server' ? 'Server' : bufferName;
    document.querySelector('#channel-name').textContent = displayName;
    document.querySelector('#compose input[name="network"]').value = networkId;
    document.querySelector('#compose input[name="target"]').value = bufferName === '_server' ? '' : bufferName;
    document.getElementById('messages').innerHTML = '';

    var userList = document.getElementById('user-list-panel');
    var compose = document.getElementById('compose');
    if (bufferName === '_server' || (bufObj && bufObj.type === 'query')) {
        if (userList) userList.style.display = 'none';
        if (compose) compose.style.display = bufferName === '_server' ? 'none' : 'flex';
    } else {
        if (userList) userList.style.display = 'flex';
        if (compose) compose.style.display = 'flex';
    }

    renderSidebar();
    renderUsers();
    loadHistory(networkId, bufferName);
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd: 'buffer', network: networkId, channel: bufferName }));
    }
}

function loadHistory(networkId, bufferName) {
    fetch('/api/channels/' + encodeURIComponent(networkId) + '/' + encodeURIComponent(bufferName) + '/messages?count=500')
        .then(function(r) { return r.json(); })
        .then(function(msgs) {
            var container = document.getElementById('messages');
            container.innerHTML = '';
            var lastDate = null;
            msgs.reverse().forEach(function(msg) {
                var ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
                var d = ts ? ts.split('T')[0] : '';
                if (d && d !== lastDate) {
                    container.innerHTML += '<div class="day-divider"><span>' + d + '</span></div>';
                    lastDate = d;
                }
                appendMessage(msg, false);
            });
            container.scrollTop = container.scrollHeight;
        });
}

function handleIRCEvent(data) {
    var net = state.buffers.find(function(n) { return n.name === data.network; });
    if (!net) return;
    var bufferName = data.channel || '_server';
    var isHighlight = false;
    if ((data.command === 'PRIVMSG' || data.command === 'NOTICE') && data.text && net.currentNick) {
        var re = new RegExp('\\b' + escapeRegex(net.currentNick) + '\\b', 'i');
        if (re.test(data.text)) isHighlight = true;
    }
    incrementUnread(net.networkId, bufferName, isHighlight);
    if (net.networkId === activeBuffer.networkId && bufferName === activeBuffer.bufferName) {
        appendMessage({ timestamp: data.timestamp, nick: data.nick || '', text: data.text || '', command: data.command }, true);
    }
    renderSidebar();
}

function incrementUnread(networkId, bufferName, isHighlight) {
    if (activeBuffer.networkId === networkId && activeBuffer.bufferName === bufferName) return;
    var net = state.buffers.find(function(n) { return n.networkId === networkId; });
    if (!net) return;
    var buf = net.buffers.find(function(b) { return b.name === bufferName; });
    if (!buf) {
        if (bufferName && bufferName[0] !== '#' && bufferName !== '_server') {
            buf = { name: bufferName, type: 'query', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] };
            net.buffers.push(buf);
        } else {
            return;
        }
    }
    buf.unreadCount = (buf.unreadCount || 0) + 1;
    if (isHighlight) buf.highlight = true;
}

function appendMessage(msg, autoScroll) {
    var container = document.getElementById('messages');
    var div = document.createElement('div');
    var cmd = msg.command || msg.c || '';
    var typeClass = 'message';
    if (cmd === 'JOIN' || cmd === 'PART' || cmd === 'QUIT' || cmd === 'NICK' || cmd === 'TOPIC' || cmd === 'CONNECT' || cmd === 'DISCONNECT' || cmd === 'ERROR') typeClass += ' system';
    else if (msg.type === 'action' || msg.y === 'a') typeClass += ' action';
    div.className = typeClass;
    var time;
    if (msg.timestamp) {
        time = msg.timestamp.substring(11, 19);
    } else if (msg.t) {
        time = new Date(msg.t).toISOString().substring(11, 19);
    } else {
        time = '--:--:--';
    }
    var nick = msg.nick || msg.n || '';
    var text = msg.text || msg.x || '';
    if (!text && cmd) text = cmd;
    var nickColor = 'nick-color-' + (stringHash(nick) % 8);
    div.innerHTML = '<span class="timestamp">' + time + '</span>' +
        '<span class="nick ' + nickColor + '">' + escapeHtml(nick) + '</span>' +
        '<span class="text">' + escapeHtml(text) + '</span>';
    container.appendChild(div);
    if (autoScroll) container.scrollTop = container.scrollHeight;
}

function stringHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
    return Math.abs(h);
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>"']/g, function(m) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
    });
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('messages')) {
        connectWebSocket();
    }
    var compose = document.getElementById('compose');
    if (compose) {
        compose.addEventListener('submit', function(evt) {
            evt.preventDefault();
            var textInput = document.getElementById('compose-input');
            var networkInput = evt.target.querySelector('input[name="network"]');
            var targetInput = evt.target.querySelector('input[name="target"]');
            if (socket.readyState === WebSocket.OPEN && textInput.value && networkInput.value && targetInput.value) {
                socket.send(JSON.stringify({ cmd: 'msg', network: networkInput.value, target: targetInput.value, text: textInput.value }));
                textInput.value = '';
            }
        });
    }

    var modal = document.getElementById('network-modal');
    var addBtn = document.getElementById('add-network-btn');
    if (addBtn && modal) {
        addBtn.addEventListener('click', function() {
            modal.style.display = 'flex';
        });
    }
    var cancelBtn = document.getElementById('cancel-network');
    if (cancelBtn && modal) {
        cancelBtn.addEventListener('click', function() {
            modal.style.display = 'none';
        });
    }
    var networkForm = document.getElementById('network-form');
    if (networkForm) {
        networkForm.addEventListener('submit', function(evt) {
            evt.preventDefault();
            var form = evt.target;
            var channels = form.autoJoinChannels.value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
            var payload = {
                name: form.name.value,
                host: form.host.value,
                port: parseInt(form.port.value, 10),
                tls: form.tls.value,
                nick: form.nick.value,
                realName: form.realName.value || form.nick.value,
                autoJoinChannels: channels
            };
            fetch('/api/networks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(function(r) {
                if (r.ok) {
                    return r.json().then(function(net) {
                        net.networkId = net.id;
                        net.connected = false;
                        net.status = 'disconnected';
                        net.currentNick = net.nick;
                        net.buffers = [{ name: '_server', type: 'server', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] }];
                        net.buffers = net.buffers.concat((net.autoJoinChannels || []).map(function(ch) {
                            return { name: ch, type: 'channel', topic: '', unreadCount: 0, highlight: false, isJoined: false, users: [] };
                        }));
                        state.buffers.push(net);
                        renderSidebar();
                        modal.style.display = 'none';
                        form.reset();
                    });
                } else {
                    alert('Failed to add network');
                }
            });
        });
    }

    document.addEventListener('keydown', function(evt) {
        var modal = document.getElementById('network-modal');
        if (evt.key === 'Escape' && modal && modal.style.display === 'flex') {
            modal.style.display = 'none';
            return;
        }
        if (!evt.altKey) return;
        var unreadOnly = evt.shiftKey;
        if (evt.key === 'ArrowUp') {
            evt.preventDefault();
            var prev = findNextBuffer('prev', unreadOnly);
            if (prev) switchBuffer(prev.networkId, prev.bufferName);
        } else if (evt.key === 'ArrowDown') {
            evt.preventDefault();
            var next = findNextBuffer('next', unreadOnly);
            if (next) switchBuffer(next.networkId, next.bufferName);
        }
    });
});
