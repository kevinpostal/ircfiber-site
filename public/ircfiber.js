var socket;
var state = { buffers: [] };
var activeBuffer = { networkId: null, bufferName: null };
var lastSeenMsgTime = null;
var focusLost = false;

function getClearedAtMap() {
    try { return JSON.parse(localStorage.getItem('ircfiber:clearedAt') || '{}'); }
    catch (e) { return {}; }
}
function setClearedAtMap(map) {
    localStorage.setItem('ircfiber:clearedAt', JSON.stringify(map));
}
function getBufferClearedAt(networkId, bufferName) {
    return getClearedAtMap()[networkId + ':' + bufferName] || null;
}
function setBufferClearedAt(networkId, bufferName) {
    var map = getClearedAtMap();
    map[networkId + ':' + bufferName] = Date.now();
    setClearedAtMap(map);
}
function clearBufferClearedAt(networkId, bufferName) {
    var map = getClearedAtMap();
    delete map[networkId + ':' + bufferName];
    setClearedAtMap(map);
}

document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        focusLost = true;
    } else {
        insertFocusSeenDivider();
        focusLost = false;
    }
});

function getActiveNetwork() {
    return state.buffers.find(function(n) { return n.networkId === activeBuffer.networkId; });
}

function clearMessages() {
    var container = document.getElementById('messages');
    if (!container) return;
    var header = document.getElementById('scroll-date-header');
    container.innerHTML = '';
    if (header) container.appendChild(header);
    window.lastMessageDate = null;
    var headerEl = document.getElementById('scroll-date-header');
    if (headerEl) headerEl.classList.remove('visible');
}

function getActiveBufferObj() {
    var net = getActiveNetwork();
    if (!net) return null;
    return net.buffers.find(function(b) { return b.name === activeBuffer.bufferName; });
}

function isAddNetworkRoute() {
    return window.location.search.indexOf('/addNetwork') >= 0 || window.location.hash.indexOf('/addNetwork') >= 0;
}

function showAddNetworkPage() {
    var app = document.getElementById('app');
    if (app) app.classList.add('add-network-active');
    var container = document.getElementById('add-network-container');
    if (container) container.classList.add('show');
    var heading = document.getElementById('addNetworkHeading');
    if (heading) heading.textContent = 'Join a new network';
    var form = document.getElementById('network-form');
    if (form) {
        form.reset();
        form.dataset.mode = 'add';
        form.networkId.value = '';
    }
    var error = document.getElementById('add-network-error');
    if (error) error.textContent = '';
    if (window.location.search.indexOf('/addNetwork') < 0) {
        history.pushState({ page: 'addNetwork' }, '', '/?/addNetwork');
    }
}

function showEditNetworkPage() {
    var app = document.getElementById('app');
    if (app) app.classList.add('add-network-active');
    var container = document.getElementById('add-network-container');
    if (container) container.classList.add('show');
    var heading = document.getElementById('addNetworkHeading');
    if (heading) heading.textContent = 'Edit network';
    var error = document.getElementById('add-network-error');
    if (error) error.textContent = '';
}

function hideAddNetworkPage() {
    var app = document.getElementById('app');
    if (app) app.classList.remove('add-network-active');
    var container = document.getElementById('add-network-container');
    if (container) container.classList.remove('show');
    if (window.location.search.indexOf('/addNetwork') >= 0) {
        history.pushState({ page: 'home' }, '', '/');
    }
}

function getNetworkByName(name) {
    var net = state.buffers.find(function(n) { return n.name === name; });
    if (net) return net;
    var lower = name.toLowerCase();
    return state.buffers.find(function(n) { return n.name.toLowerCase() === lower; }) || null;
}

function updateRoute(networkId, bufferName) {
    var net = state.buffers.find(function(n) { return n.networkId === networkId; });
    if (!net) return;
    var path;
    if (bufferName === '_server') {
        path = '/irc/' + encodeURIComponent(net.name);
    } else if (bufferName.length > 0 && bufferName[0] === '#') {
        path = '/irc/' + encodeURIComponent(net.name) + '/channel/' + encodeURIComponent(bufferName.substring(1));
    } else {
        path = '/irc/' + encodeURIComponent(net.name) + '/messages/' + encodeURIComponent(bufferName);
    }
    if (window.location.pathname + window.location.search + window.location.hash !== path) {
        history.pushState({ networkId: networkId, bufferName: bufferName }, '', path);
    }
}

function parseIrcRoute() {
    var path = window.location.pathname;
    var m = path.match(/^\/irc\/([^\/]+)(?:\/(channel|messages)\/([^\/]+))?\/?$/);
    if (!m) return false;
    var netName = decodeURIComponent(m[1]);
    var type = m[2];
    var target = m[3] ? decodeURIComponent(m[3]) : '';
    var net = getNetworkByName(netName);
    if (!net) return false;
    var bufferName = '_server';
    if (type === 'channel') {
        bufferName = target.length > 0 && target[0] === '#' ? target : '#' + target;
    } else if (type === 'messages') {
        bufferName = target;
    }
    switchBuffer(net.networkId, bufferName);
    return true;
}

function checkRoute() {
    if (isAddNetworkRoute()) {
        showAddNetworkPage();
    } else if (window.location.pathname.indexOf('/irc/') === 0) {
        hideAddNetworkPage();
        parseIrcRoute();
    } else {
        hideAddNetworkPage();
    }
}

function setActiveBuffer(networkId, bufferName) {
    bufferName = normalizeChannelName(bufferName);
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
    bufferName = normalizeChannelName(bufferName);
    var flat = computeFlatBuffers();
    for (var i = 0; i < flat.length; i++) {
        if (flat[i].networkId === networkId && flat[i].bufferName === bufferName) return i;
    }
    return -1;
}

function findBuffer(networkId, bufferName) {
    bufferName = normalizeChannelName(bufferName);
    var net = state.buffers.find(function(n) { return n.networkId === networkId; });
    if (!net) return null;
    return net.buffers.find(function(b) { return b.name === bufferName; }) || null;
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

function requestStateSync() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd: 'sync' }));
    }
}

function connectWebSocket() {
    var wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
    socket = new WebSocket(wsUrl);
    var syncInterval = null;

    socket.addEventListener('open', function() {
        var statusEl = document.getElementById('ws-status');
        if (statusEl) statusEl.textContent = 'Connected';
        syncInterval = setInterval(function() {
            if (socket && socket.readyState === WebSocket.OPEN) {
                requestStateSync();
            }
        }, 10000);
    });

    socket.addEventListener('close', function() {
        var statusEl = document.getElementById('ws-status');
        if (statusEl) statusEl.textContent = 'Disconnected';
        if (syncInterval) clearInterval(syncInterval);
        setTimeout(connectWebSocket, 3000);
    });

    socket.addEventListener('message', function(event) {
        try {
            console.log('WS MESSAGE RAW:', event.data.substring(0, 200));
            var data = JSON.parse(event.data);
            console.log('WS MESSAGE PARSED:', data.type || data.y || 'unknown');
            if (Array.isArray(data)) {
                handleIRCEvents(data);
            } else if (data.type === 'sync') {
                var incoming = data.networks || [];
                var newBuffers = [];
                incoming.forEach(function(net) {
                    if (net.id && !net.networkId) net.networkId = net.id;
                    var existing = state.buffers.find(function(n) { return n.networkId === net.networkId; });
                    if (existing) {
                        existing.name = net.name;
                        existing.host = net.host;
                        existing.port = net.port;
                        existing.tls = net.tls;
                        existing.verifyTls = net.verifyTls;
                        existing.nick = net.nick;
                        existing.realName = net.realName;
                        if (!(existing._optimisticUntil && Date.now() < existing._optimisticUntil)) {
                            existing.connected = net.connected;
                        }
                        existing.status = net.status;
                        existing.currentNick = net.currentNick;
                        existing.disconnectReason = (typeof net.disconnectReason === 'string') ? net.disconnectReason : existing.disconnectReason;
                        var mergedBuffers = [];
                        (net.buffers || []).forEach(function(incomingBuf) {
                            incomingBuf.name = normalizeChannelName(incomingBuf.name);
                            var existingBuf = existing.buffers.find(function(b) { return b.name === incomingBuf.name; });
                            if (existingBuf) {
                                incomingBuf.unreadCount = existingBuf.unreadCount || 0;
                                incomingBuf.highlight = existingBuf.highlight || false;
                                incomingBuf.isPinned = existingBuf.isPinned || false;
                                if ((!incomingBuf.users || incomingBuf.users.length === 0) && existingBuf.users && existingBuf.users.length > 0) {
                                    incomingBuf.users = existingBuf.users;
                                }
                                if ((!incomingBuf.topic || incomingBuf.topic.length === 0) && existingBuf.topic && existingBuf.topic.length > 0) {
                                    incomingBuf.topic = existingBuf.topic;
                                }
                            }
                            mergedBuffers.push(incomingBuf);
                        });
                        existing.buffers.forEach(function(existingBuf) {
                            existingBuf.name = normalizeChannelName(existingBuf.name);
                            var inIncoming = (net.buffers || []).some(function(b) { return b.name === existingBuf.name; });
                            if (!inIncoming) {
                                mergedBuffers.push(existingBuf);
                            }
                        });
                        existing.buffers = mergedBuffers;
                        newBuffers.push(existing);
                    } else {
                        if (!net.buffers) net.buffers = [];
                        net.buffers.forEach(function(b) { b.name = normalizeChannelName(b.name); });
                        if (net.buffers.length === 0 || net.buffers[0].type !== 'server') {
                            net.buffers.unshift({ name: '_server', type: 'server', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] });
                        }
                        if (typeof net.collapsed === 'undefined') net.collapsed = false;
                        if (!net.disconnectReason) net.disconnectReason = '';
                        newBuffers.push(net);
                    }
                });
                state.buffers = newBuffers;
                renderSidebar();
                var activeNet = getActiveNetwork();
                if (activeNet && activeBuffer.bufferName === '_server') {
                    updateConnectionStatusCell(activeNet);
                    updateConnectionActionButton(activeNet);
                }
                fetchMe();
                if (window.location.pathname.indexOf('/irc/') === 0) {
                    parseIrcRoute();
                } else if (!activeBuffer.networkId && state.buffers.length > 0) {
                    var first = state.buffers[0];
                    if (first.buffers.length > 0) {
                        switchBuffer(first.networkId, first.buffers[0].name);
                    }
                }
            } else if (data.type === 'irc_event' || data.y === 'irc_event') {
                handleIRCEvent(data);
            }
        } catch(e) { console.error(e); }
    });
}

var lastHealthOk = true;

function pollHealth() {
    fetch('/api/health')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var bar = document.getElementById('service-status-bar');
            var text = document.getElementById('service-status-text');
            if (!bar || !text) return;

            var ok = data.status === 'healthy';
            if (!ok && data.services) {
                var failed = [];
                if (!data.services.mongo || !data.services.mongo.ok) failed.push('MongoDB');
                if (!data.services.redis || !data.services.redis.ok) failed.push('Redis');
                text.textContent = '⚠ ' + failed.join(' + ') + ' is unavailable. Run `docker compose up -d mongo redis` to start services.';
                bar.style.display = 'block';
            } else {
                bar.style.display = 'none';
            }

            if (!lastHealthOk && ok) {
                // Services recovered: reconnect WS and sync state
                if (socket && socket.readyState !== WebSocket.OPEN) {
                    connectWebSocket();
                } else {
                    requestStateSync();
                }
            }
            lastHealthOk = ok;
        })
        .catch(function() {
            var bar = document.getElementById('service-status-bar');
            var text = document.getElementById('service-status-text');
            if (bar && text) {
                text.textContent = '⚠ Backend is unreachable. Check that the IRC Fiber container is running.';
                bar.style.display = 'block';
            }
            lastHealthOk = false;
        });
}

function renderSidebar() {
    var container = document.getElementById('networks');
    var html = '';

    var pinned = [];
    state.buffers.forEach(function(net) {
        net.buffers.forEach(function(buf) {
            if (buf.name !== '_server' && buf.isPinned && buf.isJoined !== false) {
                pinned.push({ networkId: net.networkId, buffer: buf, network: net });
            }
        });
    });

    if (pinned.length > 0) {
        html += '<div class="sidebar-section-header">Pinned</div>';
        html += '<ul class="buffers pinned-channels">';
        pinned.forEach(function(p) {
            var isActive = (p.networkId === activeBuffer.networkId && p.buffer.name === activeBuffer.bufferName);
            var activeClass = isActive ? 'active' : '';
            var displayName = stripHash(p.buffer.name);
            var label = (p.buffer.type === 'query' ? '' : '#') + escapeHtml(displayName);
            var jsSafeName = p.buffer.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            var safeNetId = p.networkId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            html += '<li class="buffer channel buffer-item ' + activeClass + ' ' + (p.buffer.highlight ? 'highlight' : '') + '" data-network="' + escapeHtml(p.networkId) + '" data-channel="' + escapeHtml(p.buffer.name) + '" onclick="switchBuffer(\'' + safeNetId + '\', \'' + jsSafeName + '\')">';
            html += '<span class="buffer" role="tab" tabindex="0">';
            html += '<span class="label buffer-name">&#128204; ' + label + '</span>';
            if (p.buffer.unreadCount > 0) {
                html += '<span class="unread buffer-unread">' + p.buffer.unreadCount + '</span>';
            }
            html += '</span></li>';
        });
        html += '</ul>';
    }

    state.buffers.forEach(function(net) {
        var visibleBuffers = net.buffers.filter(function(b) { return b.isJoined !== false; });
        var netUnread = visibleBuffers.reduce(function(sum, b) { return sum + (b.unreadCount || 0); }, 0);
        var netHighlight = visibleBuffers.some(function(b) { return b.highlight; });
        var collapsed = net.collapsed;
        var chevron = collapsed ? '▶' : '▼';
        var isActiveNet = activeBuffer.networkId === net.networkId && activeBuffer.bufferName === '_server';
        var netActiveClass = isActiveNet ? 'active' : '';
        var safeNetId = net.networkId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        html += '<li class="network connection ' + (net.connected ? 'connected' : 'disconnected') + '">';
        html += '<h2 class="network-header buffer ' + netActiveClass + '" onclick="switchBuffer(\'' + safeNetId + '\', \'_server\')">';
        html += '<span class="network-chevron" onclick="event.stopPropagation(); toggleNetwork(\'' + safeNetId + '\')">' + chevron + '</span>';
        html += '<span class="network-status ' + (net.connected ? '' : 'disconnected') + '"></span>';
        html += '<span class="network-name-text label">' + escapeHtml(net.name) + '</span>';
        if (netUnread > 0) {
            html += '<span class="unread network-unread ' + (netHighlight ? 'highlight' : '') + '">' + netUnread + '</span>';
        }
        html += '</h2>';

        if (!collapsed) {
            html += '<ul class="buffers channels network-buffers">';
            net.buffers.forEach(function(buf) {
                if (buf.name === '_server') return;
                if (buf.isJoined === false) return;
                var isActive = (net.networkId === activeBuffer.networkId && buf.name === activeBuffer.bufferName);
                var activeClass = isActive ? 'active' : '';
                var displayName = stripHash(buf.name);
                var label = (buf.type === 'query' ? '' : '#') + escapeHtml(displayName);
                var jsSafeName = buf.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                html += '<li class="buffer channel buffer-item ' + activeClass + ' ' + (buf.highlight ? 'highlight' : '') + '" data-network="' + escapeHtml(net.networkId) + '" data-channel="' + escapeHtml(buf.name) + '" onclick="switchBuffer(\'' + safeNetId + '\', \'' + jsSafeName + '\')">';
                html += '<span class="buffer" role="tab" tabindex="0">';
                html += '<span class="label buffer-name">' + label + '</span>';
                if (buf.unreadCount > 0) {
                    html += '<span class="unread buffer-unread">' + buf.unreadCount + '</span>';
                }
                html += '</span></li>';
            });
            html += '</ul>';
        }
        html += '</li>';
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

function getUserModePrefix(nick) {
    if (nick.startsWith('~')) return { prefix: '~', cls: 'owner', category: 'ops' };
    if (nick.startsWith('&')) return { prefix: '&', cls: 'owner', category: 'ops' };
    if (nick.startsWith('@')) return { prefix: '@', cls: 'op', category: 'ops' };
    if (nick.startsWith('%')) return { prefix: '%', cls: 'halfop', category: 'halfops' };
    if (nick.startsWith('+')) return { prefix: '+', cls: 'voice', category: 'voiced' };
    return { prefix: '', cls: '', category: 'members' };
}

function stripPrefix(nick) {
    return nick.replace(/^[~&@%+]/, '');
}

function getAvatarColor(nick) {
    var colors = ['#e96c5f','#e07d48','#c4b01d','#5ba25b','#25a2a2','#428fbf',
                  '#8562b4','#b35c94','#e34d78','#2aab97','#6e8eb5','#a07830'];
    var h = stringHash(nick);
    return colors[h % colors.length];
}

function fetchMe() {
    fetch('/api/me')
        .then(function(r) { if (!r.ok) throw new Error('Failed'); return r.json(); })
        .then(function(me) {
            state.me = me;
            var usernameEl = document.getElementById('account-menu-username');
            var emailEl = document.getElementById('account-menu-email');
            var menuAvatarEl = document.getElementById('account-menu-avatar');
            if (usernameEl) usernameEl.textContent = me.username || '';
            if (emailEl) emailEl.textContent = me.email || '';
            var initial = (me.username || '').charAt(0).toUpperCase();
            if (menuAvatarEl) menuAvatarEl.textContent = initial;
        })
        .catch(function() {});
}

function renderUsers() {
    var flatList = document.getElementById('flat-members');
    if (!flatList) return;

    var net = getActiveNetwork();
    if (!net || !activeBuffer.bufferName || activeBuffer.bufferName === '_server') {
        flatList.innerHTML = '';
        return;
    }

    var ch = net.buffers.find(function(c) { return c.name === activeBuffer.bufferName; });
    if (!ch || !ch.users) {
        flatList.innerHTML = '';
        return;
    }

    var buckets = { ops: [], halfops: [], voiced: [], members: [] };
    ch.users.forEach(function(u) {
        var info = getUserModePrefix(u);
        buckets[info.category].push(u);
    });

    var sortUsers = function(arr) {
        return arr.slice().sort(function(a, b) {
            return stripPrefix(a).toLowerCase().localeCompare(stripPrefix(b).toLowerCase());
        });
    };

    var groupLabels = { ops: 'Ops', halfops: 'Half ops', voiced: 'Voiced', members: 'Members' };
    var groupSymbols = { ops: '@', halfops: '%', voiced: '+', members: '' };
    var groupClasses = { ops: 'mode_OP', halfops: 'mode_HALFOP', voiced: 'mode_VOICED', members: '' };

    var html = '<div class="memberwrapper"><ul class="memberList">';
    ['ops', 'halfops', 'voiced', 'members'].forEach(function(cat) {
        var list = sortUsers(buckets[cat]);
        if (list.length === 0) return;
        var sym = groupSymbols[cat];
        var symCls = groupClasses[cat];
        html += '<li class="category ' + cat + '">';
        html += '<h2>' + groupLabels[cat];
        html += '<span class="memberExtras">';
        if (sym) {
            html += '<span class="mode_symbol ' + symCls + '">' + sym + '</span>';
            html += '<span class="mode_pill ' + symCls + '">•</span>';
        }
        html += '<span class="memberCount">' + list.length + '</span>';
        html += '</span></h2>';
        html += '<ul class="categoryMemberList">';
        list.forEach(function(u) {
            var name = stripPrefix(u);
            var colorClass = 'c' + (name.split('').reduce(function(a, b) { return a + b.charCodeAt(0); }, 0) % 27);
            html += '<li class="user"><button class="user ' + cat + ' ' + colorClass + '">' + escapeHtml(name) + '</button></li>';
        });
        html += '</ul></li>';
    });
    html += '</ul></div>';
    flatList.innerHTML = html;
}

function updateInputNick() {
    var net = getActiveNetwork();
    var nickEl = document.getElementById('input-nick');
    var avatarEl = document.getElementById('input-avatar');
    var nick = net ? (net.currentNick || net.nick || '') : '';
    if (nickEl) nickEl.textContent = nick;
    if (avatarEl) {
        avatarEl.textContent = nick ? nick.charAt(0).toUpperCase() : '?';
        avatarEl.style.backgroundColor = getAvatarColor(nick || 'Unknown');
    }
}

function updateInputTimestamp() {
    var el = document.getElementById('input-timestamp');
    if (el) {
        var now = new Date();
        var h = now.getHours();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12;
        h = h ? h : 12;
        var m = String(now.getMinutes()).padStart(2, '0');
        var s = String(now.getSeconds()).padStart(2, '0');
        el.textContent = h + ':' + m + ':' + s + ' ' + ampm;
    }
}

function updateConnectionStatusCell(net) {
    var cell = document.querySelector('.connectionstatuscell');
    var statusDiv = cell ? cell.querySelector('.connectionStatus') : null;
    var reasonSpan = statusDiv ? statusDiv.querySelector('.reason') : null;
    if (!cell || !statusDiv) return;
    if (net && !net.connected && net.disconnectReason) {
        if (reasonSpan) reasonSpan.textContent = net.disconnectReason;
        statusDiv.classList.add('connectionStatus--show', 'reconnect');
        cell.classList.add('show');
    } else {
        statusDiv.classList.remove('connectionStatus--show', 'reconnect');
        cell.classList.remove('show');
    }
}

function setReconnecting(net, value) {
    if (!net) return;
    net._reconnecting = value;
    if (net._reconnectingTimeout) {
        clearTimeout(net._reconnectingTimeout);
        net._reconnectingTimeout = null;
    }
    if (value) {
        net._reconnectingTimeout = setTimeout(function() {
            net._reconnecting = false;
            updateConnectionActionButton(net);
        }, 2500);
    }
    updateConnectionActionButton(net);
}

function updateConnectionActionButton(net) {
    var btn = document.getElementById('connection-action-btn');
    if (!btn || !net) return;
    if (net._reconnecting) {
        btn.textContent = 'Reconnecting...';
        btn.className = 'btn-primary reconnecting';
        btn.disabled = true;
    } else if (net.connected || net.connecting) {
        btn.textContent = 'Disconnect';
        btn.className = 'btn-secondary';
        btn.disabled = false;
    } else {
        btn.textContent = 'Reconnect';
        btn.className = 'btn-primary';
        btn.disabled = false;
    }
}

function switchBuffer(networkId, bufferName) {
    bufferName = normalizeChannelName(bufferName);
    setActiveBuffer(networkId, bufferName);
    var serverCtxMenu = document.getElementById('server-context-menu');
    var serverOptionsBtn = document.getElementById('server-options-btn');
    if (serverCtxMenu) serverCtxMenu.style.display = 'none';
    if (serverOptionsBtn) serverOptionsBtn.setAttribute('aria-expanded', 'false');
    var net = getActiveNetwork();
    var isServer = bufferName === '_server';

    var channelNameEl = document.getElementById('channel-name');
    var channelTopicEl = document.getElementById('channel-topic');
    var bufObj = findBuffer(networkId, bufferName);
    var isQuery = bufObj && bufObj.type === 'query';
    if (channelNameEl) channelNameEl.textContent = bufferName === '_server' ? (net ? net.name : 'Server') : (isQuery ? '' : '#') + stripHash(bufferName);
    if (channelTopicEl) channelTopicEl.textContent = (bufObj && bufObj.topic) ? bufObj.topic : '';

    var channelName = document.getElementById('current-channel');
    var channelHost = document.getElementById('channel-host');
    var networkNick = document.getElementById('network-nick');
    var networkRealname = document.getElementById('network-realname');
    var editBtn = document.getElementById('edit-network-btn');
    var actionBtn = document.getElementById('connection-action-btn');
    var memberCountBtn = document.getElementById('member-count-btn');

    if (isServer && net) {
        var tlsIcon = (net.tls && net.tls !== 'disabled') ? '🔒 ' : '';
        channelName.textContent = tlsIcon + net.name;
        channelHost.textContent = net.host + ':' + net.port;
        networkNick.textContent = net.currentNick || net.nick || '';
        networkRealname.textContent = net.realName || '';
        if (editBtn) editBtn.style.display = 'inline-block';
        if (actionBtn) actionBtn.style.display = 'inline-block';
        updateConnectionActionButton(net);
        if (memberCountBtn) memberCountBtn.style.display = 'none';
        updateConnectionStatusCell(net);
    } else {
        channelName.textContent = (isQuery ? '' : '#') + stripHash(bufferName);
        channelHost.textContent = (bufObj && bufObj.topic) ? bufObj.topic : (net ? net.host + ':' + net.port : '');
        networkNick.textContent = net ? (net.currentNick || net.nick || '') : '';
        networkRealname.textContent = net ? (net.realName || '') : '';
        if (editBtn) editBtn.style.display = 'none';
        if (actionBtn) actionBtn.style.display = 'none';
        if (memberCountBtn) memberCountBtn.style.display = 'inline-flex';
        updateConnectionStatusCell(null);
    }

    var compose = document.getElementById('compose');
    if (compose) {
        compose.querySelector('input[name="network"]').value = networkId;
        compose.querySelector('input[name="target"]').value = isServer ? '' : bufferName;
    }

    var memberSidebar = document.getElementById('member-sidebar');
    var bufferInput = document.querySelector('.bufferinputcell');
    if (isServer || (bufObj && bufObj.type === 'query')) {
        if (memberSidebar) memberSidebar.classList.remove('show');
        if (bufferInput) bufferInput.style.display = 'flex';
    } else {
        if (memberSidebar) memberSidebar.classList.add('show');
        if (bufferInput) bufferInput.style.display = 'flex';
    }

    updateInputNick();
    updateInputTimestamp();
    renderSidebar();
    renderUsers();
    clearMessages();
    loadHistory(networkId, bufferName);
    // Remove old seen dividers when switching buffers
    var container = document.getElementById('messages');
    if (container) {
        container.querySelectorAll('.seenDivider').forEach(function(el) { el.remove(); });
    }
    lastSeenMsgTime = Date.now();
    focusLost = false;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd: 'buffer', network: networkId, channel: bufferName }));
    }
    updateRoute(networkId, bufferName);
}

function ensureLoadMoreButton(networkId, bufferName) {
    var container = document.getElementById('messages');
    if (!container) return;
    if (container.querySelector('.row.loadMore')) return;
    var loadMore = document.createElement('div');
    loadMore.className = 'row loadMore';
    loadMore.innerHTML = '<button class="loadMore__button" tabindex="-1"><span>Load more backlog…</span></button>';
    loadMore.querySelector('button').addEventListener('click', function() {
        loadMoreHistory(networkId, bufferName);
    });
    var header = document.getElementById('scroll-date-header');
    if (header && header.nextSibling) {
        container.insertBefore(loadMore, header.nextSibling);
    } else if (header) {
        container.appendChild(loadMore);
    } else {
        container.insertBefore(loadMore, container.firstChild);
    }
}

function removeLoadMoreButton() {
    var container = document.getElementById('messages');
    if (!container) return;
    var existing = container.querySelector('.row.loadMore');
    if (existing) existing.remove();
}

function loadHistory(networkId, bufferName) {
    var clearedAt = getBufferClearedAt(networkId, bufferName);
    var url = '/api/channels/' + encodeURIComponent(networkId) + '/' + encodeURIComponent(bufferName) + '/messages';
    if (clearedAt) {
        url += '?count=50&after=' + clearedAt;
    } else {
        url += '?count=100';
    }

    fetch(url)
        .then(function(r) {
            if (!r.ok) {
                return r.json().then(function(err) {
                    throw new Error(err.error || ('HTTP ' + r.status));
                });
            }
            return r.json();
        })
        .then(function(msgs) {
            if (!Array.isArray(msgs)) {
                throw new Error('Invalid response from server');
            }
            if (activeBuffer.networkId !== networkId || activeBuffer.bufferName !== bufferName) {
                return;
            }
            var container = document.getElementById('messages');
            var lastDate = null;
            var frag = document.createDocumentFragment();
            var grouped = groupMOTDLines(msgs);
            grouped.forEach(function(msg) {
                var ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
                var d = ts ? ts.split('T')[0] : '';
                if (d && d !== lastDate) {
                    var dayDiv = document.createElement('div');
                    dayDiv.className = 'row dateChange';
                    dayDiv.innerHTML = '<h3>' + formatDate(d) + '</h3>';
                    frag.appendChild(dayDiv);
                    lastDate = d;
                }
                var el = buildMessageElement(msg, msg.highlight);
                if (el) frag.appendChild(el);
            });
            container.appendChild(frag);
            window.lastMessageDate = lastDate;
            container.scrollTop = container.scrollHeight;

            if (clearedAt || msgs.length >= 100) {
                ensureLoadMoreButton(networkId, bufferName);
            }
        })
        .catch(function(err) {
            var container = document.getElementById('messages');
            container.innerHTML = '<div class="row messageRow status monospace type_error userParent"><span class="date"><span class="timestamp">--:--:--</span></span><span class="g">&nbsp;</span><span class="message"><span class="content">Failed to load history: ' + escapeHtml(err.message) + '</span></span></div>';
        });
}

function loadMoreHistory(networkId, bufferName) {
    var container = document.getElementById('messages');
    if (!container) return;

    var rows = container.querySelectorAll('[data-time]');
    var oldestTimestamp = null;
    for (var i = 0; i < rows.length; i++) {
        var t = parseInt(rows[i].getAttribute('data-time'), 10);
        if (!isNaN(t)) {
            if (oldestTimestamp === null || t < oldestTimestamp) oldestTimestamp = t;
        }
    }

    var clearedAt = getBufferClearedAt(networkId, bufferName);
    var before = oldestTimestamp !== null ? oldestTimestamp : (clearedAt ? clearedAt : Date.now());
    var url = '/api/channels/' + encodeURIComponent(networkId) + '/' + encodeURIComponent(bufferName) + '/messages?count=50&before=' + before;

    fetch(url)
        .then(function(r) {
            if (!r.ok) return r.json().then(function(err) { throw new Error(err.error); });
            return r.json();
        })
        .then(function(msgs) {
            if (!Array.isArray(msgs) || msgs.length === 0) {
                removeLoadMoreButton();
                return;
            }

            var loadMore = container.querySelector('.row.loadMore');
            var frag = document.createDocumentFragment();
            var grouped = groupMOTDLines(msgs);
            var prevDate = null;
            grouped.forEach(function(msg) {
                var ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
                var d = ts ? ts.split('T')[0] : '';
                if (d && d !== prevDate) {
                    var dayDiv = document.createElement('div');
                    dayDiv.className = 'row dateChange';
                    dayDiv.innerHTML = '<h3>' + formatDate(d) + '</h3>';
                    frag.appendChild(dayDiv);
                    prevDate = d;
                }
                var el = buildMessageElement(msg, msg.highlight);
                if (el) frag.appendChild(el);
            });

            if (loadMore && loadMore.nextSibling) {
                container.insertBefore(frag, loadMore.nextSibling);
            } else if (loadMore) {
                container.appendChild(frag);
            } else {
                container.insertBefore(frag, container.firstChild);
            }

            var dates = container.querySelectorAll('.row.dateChange');
            var seenDates = {};
            for (var j = 0; j < dates.length; j++) {
                var txt = dates[j].textContent;
                if (seenDates[txt]) {
                    dates[j].remove();
                } else {
                    seenDates[txt] = true;
                }
            }

            if (msgs.length < 50) {
                removeLoadMoreButton();
            }
        })
        .catch(function() {
            // leave button in place on error
        });
}

function handleIRCEvent(data) {
    var result = processIRCEvent(data);
    if (result.needsRender) renderSidebar();
    var container = document.getElementById('messages');
    container.scrollTop = container.scrollHeight;
}

function handleIRCEvents(events) {
    var grouped = groupDisconnects(events);
    var needsRender = false;
    var container = document.getElementById('messages');
    grouped.forEach(function(item) {
        if (item.type === 'discoGroup') {
            var el = buildDiscoGroupElement(item.group.head, item.group.items);
            if (el) container.appendChild(el);
            needsRender = true;
        } else {
            var r = processIRCEvent(item.msg, null);
            if (r.needsRender) needsRender = true;
        }
    });
    var isScrolledNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    if (!isScrolledNearBottom && events.length > 0) {
        insertSeenDivider('lastSeen');
    }
    container.scrollTop = container.scrollHeight;
    if (needsRender) renderSidebar();
}

function updateChannelUsers(net, bufferName, cmd, data) {
    if (!net) return;
    var buf = net.buffers.find(function(b) { return b.name === bufferName; });
    if (!buf) return;
    if (!buf.users) buf.users = [];

    var nick = data.nick || data.n || '';
    var params = data.params || data.p || [];
    var text = data.text || data.x || '';

    if (cmd === '353') {
        var nicks = text ? text.split(' ') : (params.length > 0 ? params[params.length - 1].split(' ') : []);
        nicks.forEach(function(n) {
            if (n.length > 0 && !buf.users.some(function(u) { return stripPrefix(u) === stripPrefix(n); })) {
                buf.users.push(n);
            }
        });
    } else if (cmd === 'JOIN' && nick && nick !== net.currentNick) {
        if (!buf.users.some(function(u) { return stripPrefix(u) === stripPrefix(nick); })) {
            buf.users.push(nick);
        }
    } else if (cmd === 'PART' && nick === net.currentNick) {
        buf.isJoined = false;
    } else if (cmd === 'PART' && nick && nick !== net.currentNick) {
        buf.users = buf.users.filter(function(u) { return stripPrefix(u) !== stripPrefix(nick); });
    } else if (cmd === 'KICK' && params.length >= 2) {
        var kickedNick = params[1];
        if (kickedNick === net.currentNick) {
            buf.isJoined = false;
        } else {
            buf.users = buf.users.filter(function(u) { return stripPrefix(u) !== stripPrefix(kickedNick); });
        }
    } else if (cmd === 'QUIT' && nick) {
        buf.users = buf.users.filter(function(u) { return stripPrefix(u) !== stripPrefix(nick); });
    } else if (cmd === 'NICK' && nick && params.length > 0) {
        var newNick = params[params.length - 1];
        buf.users = buf.users.map(function(u) {
            return stripPrefix(u) === stripPrefix(nick) ? (getUserModePrefix(u).prefix + newNick) : u;
        });
    }
}

function processIRCEvent(data, batchFrag) {
    var net = state.buffers.find(function(n) { return n.name === data.network; });
    if (!net) return { needsRender: false };
    var bufferName = data.channel || data.ch || '_server';
    bufferName = normalizeChannelName(bufferName);
    var cmd = data.command || data.c || '';
    var text = data.text || data.x || '';
    var isHighlight = false;
    if ((cmd === 'PRIVMSG' || cmd === 'NOTICE') && text && net.currentNick) {
        var re = new RegExp('\\b' + escapeRegex(net.currentNick) + '\\b', 'i');
        if (re.test(text)) isHighlight = true;
    }
    incrementUnread(net.networkId, bufferName, isHighlight);
    if (cmd === 'JOIN' && bufferName !== '_server') {
        var joinedBuf = net.buffers.find(function(b) { return b.name === bufferName; });
        if (joinedBuf) joinedBuf.isJoined = true;
    }
    updateChannelUsers(net, bufferName, cmd, data);
    if (cmd === 'JOIN' && bufferName !== '_server') {
        requestStateSync();
    }
    if (cmd === '366') {
        renderUsers();
        requestStateSync();
    }
    var isActive = (net.networkId === activeBuffer.networkId && bufferName === activeBuffer.bufferName);
    if (isActive) {
        var msg = {
            timestamp: data.timestamp || (data.t ? new Date(data.t).toISOString() : null),
            nick: data.nick || data.n || '',
            text: text,
            command: cmd,
            params: data.params || data.p
        };
        if (cmd === '001' || cmd === 'CONNECT') {
            net.connected = true;
            net.connecting = false;
            net.wasDisconnected = false;
            net.disconnectReason = '';
            setReconnecting(net, false);
        }
        if (cmd === 'DISCONNECT') {
            net.connected = false;
            net.connecting = false;
            net.wasDisconnected = true;
            net.disconnectReason = text || 'Disconnected';
            setReconnecting(net, false);
        }
        if (cmd === 'NOTICE' && bufferName === '_server' && text && text.indexOf('Connecting to') >= 0) {
            net.connecting = true;
            updateConnectionActionButton(net);
            updateConnectionStatusCell(net);
        }
        if ((cmd === '001' || cmd === 'CONNECT' || cmd === 'DISCONNECT') && bufferName === '_server') {
            updateConnectionStatusCell(net);
            updateConnectionActionButton(net);
        }
        var container = document.getElementById('messages');
        var target = batchFrag || container;
        var msgDate = getMsgDate(msg);
        if (msgDate) insertDayDividerIfNeeded(msgDate, target);
        var el = buildMessageElement(msg, isHighlight);
        if (el) {
            if (batchFrag) batchFrag.appendChild(el);
            else container.appendChild(el);
        }
    } else {
        if (cmd === '001' || cmd === 'CONNECT') {
            net.connected = true;
            net.connecting = false;
            net.wasDisconnected = false;
            net.disconnectReason = '';
            setReconnecting(net, false);
        }
        if (cmd === 'DISCONNECT') {
            net.connected = false;
            net.connecting = false;
            net.wasDisconnected = true;
            net.disconnectReason = text || 'Disconnected';
            setReconnecting(net, false);
        }
        if (cmd === 'NOTICE' && bufferName === '_server' && text && text.indexOf('Connecting to') >= 0) {
            net.connecting = true;
        }
    }
    return { needsRender: true };
}

function ensureQueryBuffer(networkId, nick) {
    var net = state.buffers.find(function(n) { return n.networkId === networkId; });
    if (!net) return null;
    var buf = net.buffers.find(function(b) { return b.name === nick; });
    if (!buf) {
        buf = { name: nick, type: 'query', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] };
        net.buffers.push(buf);
    }
    return buf;
}

function incrementUnread(networkId, bufferName, isHighlight) {
    if (activeBuffer.networkId === networkId && activeBuffer.bufferName === bufferName) return;
    var net = state.buffers.find(function(n) { return n.networkId === networkId; });
    if (!net) return;
    var buf = net.buffers.find(function(b) { return b.name === bufferName; });
    if (!buf) {
        if (bufferName === '_server') {
            return;
        }
        buf = {
            name: bufferName,
            type: bufferName[0] === '#' ? 'channel' : 'query',
            isJoined: true,
            unreadCount: 0,
            highlight: false,
            topic: '',
            users: []
        };
        net.buffers.push(buf);
    }
    buf.unreadCount = (buf.unreadCount || 0) + 1;
    if (isHighlight) buf.highlight = true;
}

function formatNumericText(cmd, params, text) {
    if (!cmd) return text || '';
    var p = params || [];
    switch (cmd) {
        case '001': return text || 'Welcome';
        case '002': return text || 'Your host';
        case '003': return text || 'Server created';
        case '004':
            if (text) return text;
            if (p.length >= 4) return 'Server ' + p[1] + ' running ' + p[2] + ' (user modes: ' + p[3] + (p.length > 4 ? ', channel modes: ' + p[4] : '') + ')';
            return cmd;
        case '005':
            if (p.length > 1) {
                var tokens = p.slice(1);
                var last = tokens[tokens.length - 1];
                if (last && last.indexOf('supported by this server') >= 0) tokens.pop();
                return 'Supported: ' + tokens.join(' ');
            }
            return text || cmd;
        case '251': case '252': case '253': case '254': case '255':
        case '265': case '266': case '250': case '042': case '221':
            return text || cmd;
        case '375': return text || '';
        case '372': return text || '';
        case '376': return null;
        case '422': return null;
        case 'MODE':
            if (p.length >= 2) {
                var target = p[0];
                var modes = p.slice(1).join(' ');
                if (target.length > 0 && target[0] !== '#') {
                    return 'Your user mode changed: ' + modes + (text ? ' ' + text : '');
                }
                return target + ' ' + modes + (text ? ' ' + text : '');
            }
            return text || cmd;
        case 'CAP':
            if (p.length >= 2) {
                var sub = p[0];
                var capList = [];
                for (var k = 1; k < p.length; k++) {
                    if (p[k] === '*') continue;
                    var piece = p[k];
                    if (piece.charCodeAt(0) === 0x3A) piece = piece.slice(1);
                    piece.split(' ').forEach(function(s){ if (s) capList.push(s); });
                }
                var caps = capList.join(' | ');
                if (sub === 'LS' || sub === 'LIST') return 'CAP Server supports: ' + caps;
                if (sub === 'REQ') return 'CAP Requesting: ' + caps;
                if (sub === 'ACK') return 'CAP Acknowledged: ' + caps;
                if (sub === 'NEW') return 'CAP Server added: ' + caps;
                if (sub === 'DEL') return 'CAP Server removed: ' + caps;
            }
            return text || cmd;
        default:
            if (/^\d{3}$/.test(cmd)) {
                if (p.length > 1) return p.slice(1).join(' ') + (text ? ' ' + text : '');
                return text || cmd;
            }
            return text || '';
    }
}

function formatTime12Hour(d) {
    var h = d.getHours();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s + ' ' + ampm;
}

function formatDateTimeTitle(d) {
    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + formatTime12Hour(d);
}

function getIrcCloudTypeClass(cmd, msg) {
    if (!cmd) return '';
    var p = (msg && (msg.params || msg.p)) || [];
    switch (cmd) {
        case '001': return 'type_server_welcome';
        case '002': return 'type_server_yourhost';
        case '003': return 'type_server_created';
        case '004': return 'type_myinfo';
        case '005': return 'type_server_supports';
        case '251': return 'type_server_luserclient';
        case '252': return 'type_server_luserop';
        case '253': return 'type_server_luserunknown';
        case '254': return 'type_server_luserchannels';
        case '255': return 'type_server_luserme';
        case '265': return 'type_server_n_local';
        case '266': return 'type_server_n_global';
        case '396': return 'type_hidden_host_set';
        case '372': return 'type_motd_response';
        case '375': return 'type_motd_start';
        case '376': return 'type_motd_end';
        case '422': return 'type_motd_missing';
        case '221': return 'type_user_mode';
        case 'MODE':
            if (p.length >= 1 && p[0].length > 0 && p[0][0] !== '#') return 'type_user_mode';
            return 'type_channel_mode';
        case 'CAP':
            if (p[0] === 'LS' || p[0] === 'LIST') return 'type_cap_ls';
            if (p[0] === 'REQ') return 'type_cap_req';
            if (p[0] === 'ACK') return 'type_cap_ack';
            if (p[0] === 'NEW') return 'type_cap_new';
            if (p[0] === 'DEL') return 'type_cap_del';
            if (p[0] === 'NAK') return 'type_cap_nak';
            return 'type_cap';
        case 'NOTICE': return 'type_notice';
        case 'PRIVMSG':
            if (msg && (msg.type === 'action' || msg.y === 'a')) return 'type_action';
            return 'type_privmsg';
        case 'JOIN': return 'type_join';
        case 'PART': return 'type_part';
        case 'QUIT': return 'type_quit';
        case 'NICK': return 'type_nick';
        case 'TOPIC': return 'type_topic';
        case 'DISCONNECT': return 'type_quit_server';
        case 'ERROR': return 'type_error';
        case 'CONNECT': return 'type_connecting';
        case 'INVITE': return 'type_channel_invite';
        case 'KICK': return 'type_kick';
        default:
            if (/^\d{3}$/.test(cmd)) return 'type_numeric_' + cmd;
            return '';
    }
}

function groupMOTDLines(msgs) {
    var result = [];
    var motdGroup = null;
    msgs.forEach(function(msg) {
        var cmd = msg.command || msg.c || '';
        if (cmd === '372' || cmd === '375') {
            if (!motdGroup) {
                motdGroup = {
                    command: 'MOTD_GROUP',
                    timestamp: (msg.timestamp ? new Date(msg.timestamp).toISOString() : null) || (msg.t ? new Date(msg.t).toISOString() : null),
                    lines: []
                };
            }
            var text = formatNumericText(cmd, msg.params || msg.p, msg.text || msg.x);
            if (text) motdGroup.lines.push(text);
        } else if (cmd === '376' || cmd === '422') {
            if (motdGroup) {
                result.push(motdGroup);
                motdGroup = null;
            }
        } else {
            if (motdGroup) {
                result.push(motdGroup);
                motdGroup = null;
            }
            result.push(msg);
        }
    });
    if (motdGroup) result.push(motdGroup);
    return result;
}

function parseIrcFormatting(text) {
    if (!text) return '';
    var i = 0;
    var out = '';
    var bold = false, italic = false, underline = false, reverse = false;
    var fg = null, bg = null, hexFg = null, hexBg = null;
    var openStack = 0;

    function makeOpen() {
        var classes = [];
        if (bold) classes.push('bold');
        if (italic) classes.push('italic');
        if (underline) classes.push('underline');
        if (reverse) classes.push('reverse');
        if (fg !== null) classes.push('irccolor color-' + fg);
        if (bg !== null) classes.push('irccolor-bg bg-' + bg);
        var style = '';
        if (hexFg !== null) style += 'color:#' + hexFg + ';';
        if (hexBg !== null) style += 'background-color:#' + hexBg + ';';
        if (classes.length === 0 && !style) return '';
        var cls = classes.length ? ' class="' + classes.join(' ') + '"' : '';
        var sty = style ? ' style="' + style + '"' : '';
        return '<span' + cls + sty + '>';
    }

    while (i < text.length) {
        var ch = text.charCodeAt(i);
        var stateChanged = false;
        if (ch === 0x02) { bold = !bold; stateChanged = true; i++; }
        else if (ch === 0x1D) { italic = !italic; stateChanged = true; i++; }
        else if (ch === 0x1F) { underline = !underline; stateChanged = true; i++; }
        else if (ch === 0x16) { reverse = !reverse; stateChanged = true; i++; }
        else if (ch === 0x0F) {
            bold = false; italic = false; underline = false; reverse = false;
            fg = null; bg = null; hexFg = null; hexBg = null;
            stateChanged = true; i++;
        } else if (ch === 0x03) {
            i++;
            var fnum = '';
            for (var k = 0; k < 2 && i < text.length; k++) {
                var c = text.charCodeAt(i);
                if (c >= 0x30 && c <= 0x39) { fnum += text[i]; i++; } else break;
            }
            var hadComma = false;
            var bnum = '';
            if (i < text.length && text.charCodeAt(i) === 0x2C) {
                hadComma = true;
                i++;
                for (var k = 0; k < 2 && i < text.length; k++) {
                    var c = text.charCodeAt(i);
                    if (c >= 0x30 && c <= 0x39) { bnum += text[i]; i++; } else break;
                }
            }
            if (fnum.length > 0) fg = parseInt(fnum, 10);
            else if (!hadComma) fg = null;
            if (hadComma) bg = bnum.length > 0 ? parseInt(bnum, 10) : null;
            if (fnum.length === 0 && !hadComma) { fg = null; bg = null; }
            hexFg = null; hexBg = null;
            stateChanged = true;
        } else if (ch === 0x04) {
            i++;
            var hf = '', hb = '';
            for (var k = 0; k < 6 && i < text.length; k++) {
                var c = text.charCodeAt(i);
                if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
                    hf += text[i]; i++;
                } else break;
            }
            if (i < text.length && text.charCodeAt(i) === 0x2C) {
                i++;
                for (var k = 0; k < 6 && i < text.length; k++) {
                    var c = text.charCodeAt(i);
                    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
                        hb += text[i]; i++;
                    } else break;
                }
            }
            hexFg = hf.length === 6 ? hf : null;
            hexBg = hb.length === 6 ? hb : null;
            fg = null; bg = null;
            stateChanged = true;
        } else {
            out += escapeHtml(text[i]);
            i++;
        }

        if (stateChanged) {
            if (openStack > 0) {
                for (var k = 0; k < openStack; k++) out += '</span>';
                openStack = 0;
            }
            var openTag = makeOpen();
            if (openTag) {
                out += openTag;
                openStack = 1;
            }
        }
    }
    if (openStack > 0) {
        for (var k = 0; k < openStack; k++) out += '</span>';
    }
    return out;
}

function isDisconnectLike(cmd, text) {
    return cmd === 'DISCONNECT' || cmd === 'ERROR' || (text && text.toLowerCase().indexOf('failed to connect') >= 0);
}

function groupDisconnects(msgs) {
    var result = [];
    var group = null;
    msgs.forEach(function(msg) {
        var cmd = msg.command || msg.c || '';
        var text = msg.text || msg.x || '';
        if (isDisconnectLike(cmd, text)) {
            if (!group) group = { head: msg, items: [] };
            else group.items.push(msg);
        } else {
            if (group) {
                result.push({ type: 'discoGroup', group: group });
                group = null;
            }
            result.push({ type: 'msg', msg: msg });
        }
    });
    if (group) result.push({ type: 'discoGroup', group: group });
    return result;
}

function insertSeenDivider(type) {
    var container = document.getElementById('messages');
    if (!container) return;
    var existing = container.querySelector('.seenDivider.' + type);
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.className = 'row seenDivider ' + type;
    var text = type === 'focusSeen' ? 'New messages since you tabbed out' : 'New messages';
    div.innerHTML = '<hr><h4 class="divider-text-wrapper"><span class="divider-text">' + text + '</span></h4>';
    container.appendChild(div);
}

function insertFocusSeenDivider() {
    if (!focusLost) return;
    insertSeenDivider('focusSeen');
}

function buildMessageElement(msg, isHighlight) {
    var row = document.createElement('div');
    var cmd = msg.command || msg.c || '';
    var typeClass = 'row messageRow';
    var isSystem = (cmd === 'JOIN' || cmd === 'PART' || cmd === 'QUIT' || cmd === 'NICK' ||
                   cmd === 'TOPIC' || cmd === 'CONNECT' || cmd === 'DISCONNECT' ||
                   cmd === 'ERROR' || cmd === 'MODE' || /^\d{3}$/.test(cmd) || cmd === 'CAP' ||
                   cmd === 'MOTD_GROUP');
    if (isSystem) typeClass += ' status monospace';
    else if (msg.type === 'action' || msg.y === 'a') typeClass += ' action';

    var ircCloudType = getIrcCloudTypeClass(cmd, msg);
    if (ircCloudType) typeClass += ' ' + ircCloudType;
    typeClass += ' userParent';
    if (isHighlight || msg.highlight) typeClass += ' highlight';
    row.className = typeClass;
    if (msg.t) row.setAttribute('data-time', msg.t);

    var ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
    var timeStr = '--:--:--';
    var fullTitle = '';
    if (ts) {
        var d = new Date(ts);
        timeStr = formatTime12Hour(d);
        fullTitle = formatDateTimeTitle(d);
    }

    var nick = msg.nick || msg.n || '';
    var text = msg.text || msg.x || '';
    var params = msg.params || msg.p || [];

    if (cmd === 'DISCONNECT') {
        row.className = 'row messageRow status type_quit_server userParent';
        var display = '<span class="prefix">&#x21D0;</span> You disconnected';
        if (text && text !== 'You disconnected') display += ': ' + escapeHtml(text);
        row.innerHTML =
            '<span class="date"><span class="timestamp" title="' + escapeHtml(fullTitle) + '">' + timeStr + '</span></span>' +
            '<span class="g">&nbsp;</span>' +
            '<span class="message system"><span class="content">' + display + '</span></span>';
        return row;
    }

    if (cmd === 'MOTD_GROUP') {
        row.className = 'row messageRow type_motd_response userParent';
        var linesHtml = msg.lines.map(function(line) {
            return '<div class="groupedLines__line">' + parseIrcFormatting(line) + '</div>';
        }).join('');
        row.innerHTML =
            '<span class="date"><span class="timestamp" title="' + escapeHtml(fullTitle) + '">' + timeStr + '</span></span>' +
            '<span class="g">&nbsp;</span>' +
            '<span class="message"><div class="groupedLines">' + linesHtml + '</div></span>';
        return row;
    }

    var displayText = formatNumericText(cmd, params, text);
    if (displayText === null) return null;
    if (!displayText && cmd) displayText = cmd;

    var html =
        '<span class="date"><span class="timestamp" title="' + escapeHtml(fullTitle) + '">' + timeStr + '</span></span>' +
        '<span class="g">&nbsp;</span>' +
        '<span class="message' + (isSystem ? ' system' : '') + '">';

    if (!isSystem && nick) {
        var avatarColor = getAvatarColor(nick);
        var initial = nick.charAt(0).toUpperCase();
        html += '<span class="authorWrap">' +
                '<span class="avatar letterAvatar" style="background-color:' + avatarColor + '"><span role="presentation">' + escapeHtml(initial) + '</span></span>' +
                '<span class="g" aria-hidden="true">&lt;</span>' +
                '<span class="author" style="color:' + avatarColor + '">' + escapeHtml(nick) + '</span>' +
                '<span class="g" aria-hidden="true">&gt;</span>&nbsp;' +
                '</span>';
    }

    html += '<span class="content">' + parseIrcFormatting(displayText) + '</span>';
    html += '</span>';
    row.innerHTML = html;
    return row;
}

function buildDiscoGroupElement(groupHead, items) {
    var ts = groupHead.timestamp || (groupHead.t ? new Date(groupHead.t).toISOString() : null);
    var timeStr = '--:--:--';
    var fullTitle = '';
    if (ts) {
        var d = new Date(ts);
        timeStr = formatTime12Hour(d);
        fullTitle = formatDateTimeTitle(d);
    }
    var text = groupHead.text || groupHead.x || '';
    var count = items.length + 1;
    var suffix = count > 1 ? ' (x' + count + ')' : '';
    var sentence = escapeHtml(text) + suffix;

    var container = document.createElement('div');
    var head = document.createElement('div');
    head.className = 'row messageRow groupedDisco collapsedHead';
    head.innerHTML =
        '<span class="date"><span class="timestamp" title="' + escapeHtml(fullTitle) + '">' + timeStr + '</span></span>' +
        '<span class="g">&nbsp;</span>' +
        '<span class="message"><span class="collapseWidget" aria-label="Disconnections">' +
        '<i class="fa fa-minus-square-o collapseIcon"></i>' +
        '<i class="fa fa-plus-square-o expandIcon"></i>' +
        '<i class="fa fa-angle-right collapsedIcon"></i>' +
        '</span><span class="sentence">' + sentence + '</span></span>';
    container.appendChild(head);

    var groupDiv = document.createElement('div');
    groupDiv.className = 'collapseGroup discoGroup';
    items.forEach(function(it) {
        var el = buildMessageElement(it, false);
        if (el) groupDiv.appendChild(el);
    });
    container.appendChild(groupDiv);

    var part = document.createElement('div');
    part.className = 'row part groupedDiscoPart';
    part.innerHTML = '<hr>';
    container.appendChild(part);

    head.addEventListener('click', function() {
        var expanded = head.classList.contains('collapsedHead');
        if (expanded) {
            head.classList.remove('collapsedHead');
            groupDiv.style.display = 'block';
        } else {
            head.classList.add('collapsedHead');
            groupDiv.style.display = 'none';
        }
    });
    groupDiv.style.display = 'none';

    return container;
}

function appendMessage(msg, autoScroll, isHighlight) {
    var container = document.getElementById('messages');
    var div = buildMessageElement(msg, isHighlight);
    if (div) {
        container.appendChild(div);
        if (autoScroll) container.scrollTop = container.scrollHeight;
    }
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

function stripHash(name) {
    return (name && name.charAt(0) === '#') ? name.substring(1) : name;
}

function normalizeChannelName(name) {
    if (!name || name === '_server') return name;
    if (name.length > 0 && name.charAt(0) === '#') {
        return '#' + name.substring(1).toLowerCase();
    }
    return name;
}

function formatDate(isoDate) {
    var d = new Date(isoDate + 'T00:00:00');
    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dayName = days[d.getDay()];
    var monthName = months[d.getMonth()];
    var dayNum = d.getDate();
    var suffix = 'th';
    if (dayNum % 10 === 1 && dayNum !== 11) suffix = 'st';
    else if (dayNum % 10 === 2 && dayNum !== 12) suffix = 'nd';
    else if (dayNum % 10 === 3 && dayNum !== 13) suffix = 'rd';
    var year = d.getFullYear();
    return dayName + ', ' + monthName + ' ' + dayNum + suffix + ', ' + year;
}

function getMsgDate(msg) {
    var ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
    return ts ? ts.split('T')[0] : '';
}

function insertDayDividerIfNeeded(date, target) {
    if (!date) return;
    if (!window.lastMessageDate || window.lastMessageDate !== date) {
        var div = document.createElement('div');
        div.className = 'row dateChange';
        div.innerHTML = '<h3>' + formatDate(date) + '</h3>';
        target.appendChild(div);
        window.lastMessageDate = date;
    }
}

function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function updateScrollDateHeader() {
    var container = document.getElementById('messages');
    var header = document.getElementById('scroll-date-header');
    if (!container || !header) return;

    var dividers = container.querySelectorAll('.dateChange');
    if (dividers.length === 0) {
        header.classList.remove('visible');
        return;
    }

    var isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    var containerRect = container.getBoundingClientRect();
    var currentDateText = '';
    for (var i = 0; i < dividers.length; i++) {
        var rect = dividers[i].getBoundingClientRect();
        if (rect.top <= containerRect.top + 4) {
            currentDateText = dividers[i].textContent;
        } else {
            break;
        }
    }

    if (!currentDateText && !isNearBottom && dividers.length > 0) {
        currentDateText = dividers[0].textContent;
    }

    if (currentDateText && !isNearBottom) {
        header.textContent = currentDateText;
        header.classList.add('visible');
    } else {
        header.classList.remove('visible');
    }
}

window.addEventListener('popstate', function() {
    checkRoute();
});

document.addEventListener('DOMContentLoaded', function() {
    checkRoute();

    var messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
        messagesContainer.classList.add('time-right');
        connectWebSocket();
        messagesContainer.addEventListener('scroll', updateScrollDateHeader);
    }

    updateInputTimestamp();
    setInterval(updateInputTimestamp, 60000);
    pollHealth();
    setInterval(pollHealth, 5000);

    var compose = document.getElementById('compose');
    var textarea = document.getElementById('compose-input');
    if (compose && textarea) {
        textarea.addEventListener('input', function() {
            autoResizeTextarea(textarea);
        });
        textarea.addEventListener('keydown', function(evt) {
            if (evt.key === 'Enter' && !evt.shiftKey) {
                evt.preventDefault();
                compose.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
        });
        compose.addEventListener('submit', function(evt) {
            evt.preventDefault();
            var networkInput = compose.querySelector('input[name="network"]');
            var targetInput = compose.querySelector('input[name="target"]');
            var text = textarea.value;
            if (!text || !networkInput.value) return;

            var msgMatch = text.match(/^\/msg\s+(\S+)\s+([\s\S]+)$/);
            if (msgMatch) {
                var nick = msgMatch[1];
                var msgText = msgMatch[2];
                var buf = ensureQueryBuffer(networkInput.value, nick);
                if (buf) {
                    renderSidebar();
                    switchBuffer(networkInput.value, nick);
                    var net = getActiveNetwork();
                    if (net) {
                        appendMessage({
                            timestamp: new Date().toISOString(),
                            nick: net.currentNick || net.nick || '',
                            text: msgText,
                            command: 'PRIVMSG'
                        }, true, false);
                    }
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ cmd: 'msg', network: networkInput.value, target: nick, text: msgText }));
                    }
                    textarea.value = '';
                    textarea.style.height = 'auto';
                }
                return;
            }

            var joinMatch = text.match(/^\/join\s+(\S+)(?:\s+(\S+))?$/);
            if (joinMatch) {
                var channel = normalizeChannelName(joinMatch[1]);
                var key = joinMatch[2] || '';
                var net = getActiveNetwork();
                if (net) {
                    fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/join', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ channel: channel, key: key })
                    }).then(function(r) {
                        if (r.ok) {
                            var existingBuf = net.buffers.find(function(b) { return b.name === channel; });
                            if (existingBuf) {
                                existingBuf.isJoined = true;
                            } else {
                                net.buffers.push({ name: channel, type: 'channel', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] });
                            }
                            renderSidebar();
                            switchBuffer(net.networkId, channel);
                        } else {
                            alert('Failed to join channel');
                        }
                    });
                }
                textarea.value = '';
                textarea.style.height = 'auto';
                return;
            }

            var isServerBuf = !targetInput.value;
            if (text.charAt(0) === '/') {
                var rawLine = text.substring(1);
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ cmd: 'raw', network: networkInput.value, text: rawLine }));
                }
                textarea.value = '';
                textarea.style.height = 'auto';
                return;
            }
            if (isServerBuf) {
                // ignore plain text on server buffer
                return;
            }
            var net = getActiveNetwork();
            if (net) {
                appendMessage({
                    timestamp: new Date().toISOString(),
                    nick: net.currentNick || net.nick || '',
                    text: text,
                    command: 'PRIVMSG'
                }, true, false);
            }
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ cmd: 'msg', network: networkInput.value, target: targetInput.value, text: text }));
                textarea.value = '';
                textarea.style.height = 'auto';
            }
        });
    }

    var addBtn = document.getElementById('add-network-btn');
    if (addBtn) {
        addBtn.addEventListener('click', function() {
            showAddNetworkPage();
        });
    }
    var editBtn = document.getElementById('edit-network-btn');
    if (editBtn) {
        editBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            var form = document.getElementById('network-form');
            if (!form) return;
            form.dataset.mode = 'edit';
            form.networkId.value = net.networkId;
            form.name.value = net.name || '';
            form.host.value = net.host || '';
            form.port.value = net.port || 6697;
            form.nick.value = net.nick || '';
            form.realName.value = net.realName || '';
            form.tls.value = net.tls || 'enabled';
            form.verifyTls.checked = net.verifyTls !== false;
            form.autoJoinChannels.value = (net.autoJoinChannels || []).join(', ');
            showEditNetworkPage();
        });
    }
    var headerEditBtn = document.getElementById('header-edit-btn');
    if (headerEditBtn) {
        headerEditBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            var form = document.getElementById('network-form');
            if (!form) return;
            form.dataset.mode = 'edit';
            form.networkId.value = net.networkId;
            form.name.value = net.name || '';
            form.host.value = net.host || '';
            form.port.value = net.port || 6697;
            form.nick.value = net.nick || '';
            form.realName.value = net.realName || '';
            form.tls.value = net.tls || 'enabled';
            form.verifyTls.checked = net.verifyTls !== false;
            form.autoJoinChannels.value = (net.autoJoinChannels || []).join(', ');
            showEditNetworkPage();
        });
    }
    var closeBtn = document.getElementById('close-add-network');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            hideAddNetworkPage();
        });
    }
    var advancedHeading = document.querySelector('.addNetworkAdvancedHeading a');
    if (advancedHeading) {
        advancedHeading.addEventListener('click', function(evt) {
            evt.preventDefault();
            var container = document.querySelector('.networkEditor__container');
            if (container) {
                container.classList.toggle('networkEditor__container--collapsed');
            }
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
                verifyTls: form.verifyTls.checked,
                nick: form.nick.value,
                realName: form.realName.value || form.nick.value,
                autoJoinChannels: channels
            };
            var isEdit = form.dataset.mode === 'edit';
            var url = isEdit ? ('/api/networks/' + form.networkId.value) : '/api/networks';
            var method = isEdit ? 'PATCH' : 'POST';
            fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(function(r) {
                if (r.ok) {
                    return r.json().then(function(data) {
                        if (isEdit) {
                            var net = state.buffers.find(function(n) { return n.networkId === form.networkId.value; });
                            if (net) {
                                net.name = data.name;
                                net.host = data.host;
                                net.port = data.port;
                                net.tls = data.tls;
                                net.verifyTls = data.verifyTls;
                                net.nick = data.nick;
                                net.realName = data.realName;
                                switchBuffer(net.networkId, activeBuffer.bufferName);
                            }
                        } else {
                            var net = data;
                            net.networkId = net.id;
                            net.connected = false;
                            net.status = 'disconnected';
                            net.currentNick = net.nick;
                            net.buffers = [{ name: '_server', type: 'server', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] }];
                            net.buffers = net.buffers.concat((net.autoJoinChannels || []).map(function(ch) {
                                return { name: ch, type: 'channel', topic: '', unreadCount: 0, highlight: false, isJoined: false, users: [] };
                            }));
                            state.buffers.push(net);
                        }
                        renderSidebar();
                        hideAddNetworkPage();
                        form.reset();
                    });
                } else {
                    alert('Failed to ' + (isEdit ? 'update' : 'add') + ' network');
                }
            });
        });
    }

    var actionBtn = document.getElementById('connection-action-btn');
    if (actionBtn) {
        actionBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            if (net.connected) {
                fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/disconnect', { method: 'POST' })
                    .then(function(r) {
                        if (r.ok) {
                            net.connected = false;
                            net.wasDisconnected = true;
                            net.disconnectReason = 'You disconnected';
                            net._optimisticUntil = Date.now() + 2000;
                            renderSidebar();
                            switchBuffer(net.networkId, '_server');
                        } else {
                            alert('Failed to disconnect');
                        }
                    });
            } else {
                setReconnecting(net, true);
                fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/reconnect', { method: 'POST' })
                    .then(function(r) {
                        if (r.ok) {
                            net.connected = true;
                            net.disconnectReason = '';
                            net._optimisticUntil = Date.now() + 5000;
                            renderSidebar();
                            updateConnectionStatusCell(net);
                        } else {
                            setReconnecting(net, false);
                            alert('Failed to reconnect');
                        }
                    })
                    .catch(function() {
                        setReconnecting(net, false);
                        alert('Failed to reconnect');
                    });
            }
        });
    }
    var headerDisconnectBtn = document.getElementById('header-disconnect-btn');
    if (headerDisconnectBtn) {
        headerDisconnectBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/disconnect', { method: 'POST' })
                .then(function(r) {
                    if (r.ok) {
                        net.connected = false;
                        net.wasDisconnected = true;
                        net.disconnectReason = 'You disconnected';
                        net._optimisticUntil = Date.now() + 2000;
                        renderSidebar();
                        switchBuffer(net.networkId, '_server');
                    } else {
                        alert('Failed to disconnect');
                    }
                });
        });
    }

    var headerReconnectBtn = document.getElementById('header-reconnect-btn');
    if (headerReconnectBtn) {
        headerReconnectBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            setReconnecting(net, true);
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/reconnect', { method: 'POST' })
                .then(function(r) {
                    if (r.ok) {
                        net.connected = true;
                        net.disconnectReason = '';
                        net._optimisticUntil = Date.now() + 5000;
                        renderSidebar();
                        updateConnectionStatusCell(net);
                    } else {
                        setReconnecting(net, false);
                        alert('Failed to reconnect');
                    }
                })
                .catch(function() {
                    setReconnecting(net, false);
                    alert('Failed to reconnect');
                });
        });
    }
    var connStatusReconnect = document.querySelector('.connectionstatuscell .reconnect');
    if (connStatusReconnect) {
        connStatusReconnect.addEventListener('click', function(evt) {
            evt.preventDefault();
            var net = getActiveNetwork();
            if (!net) return;
            setReconnecting(net, true);
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/reconnect', { method: 'POST' })
                .then(function(r) {
                    if (r.ok) {
                        net.connected = true;
                        net.disconnectReason = '';
                        net._optimisticUntil = Date.now() + 2000;
                        renderSidebar();
                        updateConnectionStatusCell(net);
                    } else {
                        setReconnecting(net, false);
                        alert('Failed to reconnect');
                    }
                })
                .catch(function() {
                    setReconnecting(net, false);
                    alert('Failed to reconnect');
                });
        });
    }

    var serverCtxMenu = document.getElementById('server-context-menu');
    var serverOptionsBtn = document.getElementById('server-options-btn');
    function hideContextMenu() {
        if (serverCtxMenu) serverCtxMenu.style.display = 'none';
        if (serverOptionsBtn) serverOptionsBtn.setAttribute('aria-expanded', 'false');
    }
    if (serverOptionsBtn && serverCtxMenu) {
        serverOptionsBtn.addEventListener('click', function(evt) {
            evt.stopPropagation();
            var rect = serverOptionsBtn.getBoundingClientRect();
            serverCtxMenu.style.top = (rect.bottom + 4) + 'px';
            serverCtxMenu.style.left = rect.left + 'px';
            serverCtxMenu.style.display = 'block';
            updateContextMenuState();
            serverOptionsBtn.setAttribute('aria-expanded', 'true');
        });
    }
    document.addEventListener('click', function(evt) {
        if (serverCtxMenu && !serverCtxMenu.contains(evt.target)) {
            hideContextMenu();
        }
    });
    function updateContextMenuState() {
        var net = getActiveNetwork();
        var isServer = activeBuffer.bufferName === '_server';
        var collapseLi = document.getElementById('ctx-collapse');
        var expandLi = document.getElementById('ctx-expand');
        if (collapseLi) collapseLi.parentElement.style.display = (net && !net.collapsed && !isServer) ? 'list-item' : 'none';
        if (expandLi) expandLi.parentElement.style.display = (net && net.collapsed && !isServer) ? 'list-item' : 'none';

        var reconnectLi = document.getElementById('ctx-reconnect');
        var editLi = document.getElementById('ctx-edit');
        var disconnectLi = document.getElementById('ctx-disconnect');
        var joinLi = document.getElementById('ctx-join');
        var deleteLi = document.getElementById('ctx-delete');

        if (reconnectLi) reconnectLi.parentElement.style.display = isServer ? 'list-item' : 'none';
        if (editLi) editLi.parentElement.style.display = isServer ? 'list-item' : 'none';
        if (disconnectLi) disconnectLi.parentElement.style.display = isServer ? 'list-item' : 'none';
        if (joinLi) joinLi.parentElement.style.display = 'list-item';
        if (deleteLi) deleteLi.parentElement.style.display = isServer ? 'list-item' : 'none';
    }

    var ctxReconnect = document.getElementById('ctx-reconnect');
    if (ctxReconnect) {
        ctxReconnect.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            setReconnecting(net, true);
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/reconnect', { method: 'POST' })
                .then(function(r) {
                    if (r.ok) {
                        net.connected = true;
                        net.disconnectReason = '';
                        net._optimisticUntil = Date.now() + 5000;
                        renderSidebar();
                        updateConnectionStatusCell(net);
                    } else {
                        setReconnecting(net, false);
                        alert('Failed to reconnect');
                    }
                })
                .catch(function() {
                    setReconnecting(net, false);
                    alert('Failed to reconnect');
                });
        });
    }
    var ctxJoin = document.getElementById('ctx-join');
    if (ctxJoin) {
        ctxJoin.addEventListener('click', function() {
            hideContextMenu();
            var modal = document.getElementById('join-channel-modal');
            if (modal) modal.style.display = 'flex';
        });
    }
    var ctxEdit = document.getElementById('ctx-edit');
    if (ctxEdit) {
        ctxEdit.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            var form = document.getElementById('network-form');
            if (!form) return;
            form.dataset.mode = 'edit';
            form.networkId.value = net.networkId;
            form.name.value = net.name || '';
            form.host.value = net.host || '';
            form.port.value = net.port || 6697;
            form.nick.value = net.nick || '';
            form.realName.value = net.realName || '';
            form.tls.value = net.tls || 'enabled';
            form.autoJoinChannels.value = (net.autoJoinChannels || []).join(', ');
            showEditNetworkPage();
        });
    }
    var ctxDisconnect = document.getElementById('ctx-disconnect');
    if (ctxDisconnect) {
        ctxDisconnect.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/disconnect', { method: 'POST' })
                .then(function(r) { if (r.ok) { net.connected = false; net.wasDisconnected = true; net.disconnectReason = 'You disconnected'; renderSidebar(); switchBuffer(net.networkId, '_server'); } else { alert('Failed to disconnect'); } });
        });
    }
    var ctxClear = document.getElementById('ctx-clear');
    if (ctxClear) {
        ctxClear.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            setBufferClearedAt(net.networkId, activeBuffer.bufferName);
            clearMessages();
            ensureLoadMoreButton(net.networkId, activeBuffer.bufferName);
        });
    }
    var ctxCollapse = document.getElementById('ctx-collapse');
    if (ctxCollapse) {
        ctxCollapse.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (net) { net.collapsed = true; renderSidebar(); }
        });
    }
    var ctxExpand = document.getElementById('ctx-expand');
    if (ctxExpand) {
        ctxExpand.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (net) { net.collapsed = false; renderSidebar(); }
        });
    }
    var ctxDelete = document.getElementById('ctx-delete');
    if (ctxDelete) {
        ctxDelete.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            if (!confirm('Delete network "' + net.name + '"?')) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId), { method: 'DELETE' })
                .then(function(r) {
                    if (r.ok) {
                        state.buffers = state.buffers.filter(function(n) { return n.networkId !== net.networkId; });
                        activeBuffer = { networkId: null, bufferName: null };
                        renderSidebar();
                        clearMessages();
                    } else {
                        alert('Failed to delete network');
                    }
                });
        });
    }

    var joinChannelModal = document.getElementById('join-channel-modal');
    var cancelJoinChannel = document.getElementById('cancel-join-channel');
    if (cancelJoinChannel && joinChannelModal) {
        cancelJoinChannel.addEventListener('click', function() {
            joinChannelModal.style.display = 'none';
        });
    }
    var joinChannelForm = document.getElementById('join-channel-form');
    if (joinChannelForm) {
        joinChannelForm.addEventListener('submit', function(evt) {
            evt.preventDefault();
            var net = getActiveNetwork();
            if (!net) return;
            var channel = evt.target.channel.value;
            var key = evt.target.key.value;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: channel, key: key })
            }).then(function(r) {
                if (r.ok) {
                    joinChannelModal.style.display = 'none';
                    evt.target.reset();
                    var existingBuf = net.buffers.find(function(b) { return b.name === channel; });
                    if (existingBuf) {
                        existingBuf.isJoined = true;
                    } else {
                        net.buffers.push({ name: channel, type: 'channel', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] });
                    }
                    renderSidebar();
                    switchBuffer(net.networkId, channel);
                } else {
                    alert('Failed to join channel');
                }
            });
        });
    }

    var accountBtn = document.getElementById('account-btn');
    var accountMenu = document.getElementById('account-menu');
    function hideAccountMenu() {
        if (accountMenu) accountMenu.style.display = 'none';
        if (accountBtn) accountBtn.setAttribute('aria-expanded', 'false');
    }
    if (accountBtn && accountMenu) {
        accountBtn.addEventListener('click', function(evt) {
            evt.stopPropagation();
            var shown = accountMenu.style.display === 'block';
            if (shown) {
                hideAccountMenu();
            } else {
                accountMenu.style.display = 'block';
                accountBtn.setAttribute('aria-expanded', 'true');
            }
        });
    }
    document.addEventListener('click', function(evt) {
        if (accountMenu && !accountMenu.contains(evt.target) && evt.target !== accountBtn) {
            hideAccountMenu();
        }
    });

    var bufferCtxMenu = document.getElementById('buffer-context-menu');
    var bufferContextTarget = null;
    function hideBufferContextMenu() {
        if (bufferCtxMenu) bufferCtxMenu.style.display = 'none';
        bufferContextTarget = null;
    }
    var networksContainer = document.getElementById('networks');
    if (networksContainer && bufferCtxMenu) {
        networksContainer.addEventListener('contextmenu', function(evt) {
            var item = evt.target.closest('.buffer-item');
            if (!item) return;
            evt.preventDefault();
            bufferContextTarget = {
                networkId: item.getAttribute('data-network'),
                channel: item.getAttribute('data-channel')
            };
            var pinId = bufferContextTarget.networkId + ':' + bufferContextTarget.channel;
            var isPinned = state.me && state.me.pinnedChannels && state.me.pinnedChannels.indexOf(pinId) >= 0;
            var pinLi = document.getElementById('ctx-pin');
            var unpinLi = document.getElementById('ctx-unpin');
            if (pinLi) pinLi.parentElement.style.display = isPinned ? 'none' : 'list-item';
            if (unpinLi) unpinLi.parentElement.style.display = isPinned ? 'list-item' : 'none';
            var rect = networksContainer.getBoundingClientRect();
            bufferCtxMenu.style.top = (evt.clientY - rect.top + networksContainer.scrollTop) + 'px';
            bufferCtxMenu.style.left = (evt.clientX - rect.left) + 'px';
            bufferCtxMenu.style.display = 'block';
        });
    }
    document.addEventListener('click', function(evt) {
        if (bufferCtxMenu && !bufferCtxMenu.contains(evt.target)) {
            hideBufferContextMenu();
        }
    });
    var ctxPin = document.getElementById('ctx-pin');
    if (ctxPin) {
        ctxPin.addEventListener('click', function() {
            hideBufferContextMenu();
            if (!bufferContextTarget) return;
            fetch('/api/me/pins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ network: bufferContextTarget.networkId, channel: bufferContextTarget.channel })
            }).then(function(r) {
                if (r.ok) {
                    var pinId = bufferContextTarget.networkId + ':' + bufferContextTarget.channel;
                    if (state.me) {
                        if (!state.me.pinnedChannels) state.me.pinnedChannels = [];
                        if (state.me.pinnedChannels.indexOf(pinId) < 0) state.me.pinnedChannels.push(pinId);
                    }
                    state.buffers.forEach(function(net) {
                        if (net.networkId !== bufferContextTarget.networkId) return;
                        net.buffers.forEach(function(buf) {
                            if (buf.name === bufferContextTarget.channel) buf.isPinned = true;
                        });
                    });
                    renderSidebar();
                }
            });
        });
    }
    var ctxUnpin = document.getElementById('ctx-unpin');
    if (ctxUnpin) {
        ctxUnpin.addEventListener('click', function() {
            hideBufferContextMenu();
            if (!bufferContextTarget) return;
            fetch('/api/me/pins/' + encodeURIComponent(bufferContextTarget.networkId) + '/' + encodeURIComponent(bufferContextTarget.channel), {
                method: 'DELETE'
            }).then(function(r) {
                if (r.ok) {
                    var pinId = bufferContextTarget.networkId + ':' + bufferContextTarget.channel;
                    if (state.me && state.me.pinnedChannels) {
                        var idx = state.me.pinnedChannels.indexOf(pinId);
                        if (idx >= 0) state.me.pinnedChannels.splice(idx, 1);
                    }
                    state.buffers.forEach(function(net) {
                        if (net.networkId !== bufferContextTarget.networkId) return;
                        net.buffers.forEach(function(buf) {
                            if (buf.name === bufferContextTarget.channel) buf.isPinned = false;
                        });
                    });
                    renderSidebar();
                }
            });
        });
    }

    document.addEventListener('keydown', function(evt) {
        if (evt.key === 'Escape') {
            hideAccountMenu();
            hideBufferContextMenu();
        }
        var addNetContainer = document.getElementById('add-network-container');
        if (evt.key === 'Escape' && addNetContainer && addNetContainer.classList.contains('show')) {
            hideAddNetworkPage();
            return;
        }
        var joinModal = document.getElementById('join-channel-modal');
        if (evt.key === 'Escape' && joinModal && joinModal.style.display === 'flex') {
            joinModal.style.display = 'none';
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
