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
                        existing.nick = net.nick;
                        existing.realName = net.realName;
                        existing.connected = net.connected;
                        existing.status = net.status;
                        existing.currentNick = net.currentNick;
                        newBuffers.push(existing);
                    } else {
                        if (!net.buffers) net.buffers = [];
                        if (net.buffers.length === 0 || net.buffers[0].type !== 'server') {
                            net.buffers.unshift({ name: '_server', type: 'server', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] });
                        }
                        if (typeof net.collapsed === 'undefined') net.collapsed = false;
                        newBuffers.push(net);
                    }
                });
                state.buffers = newBuffers;
                renderSidebar();
                if (!activeBuffer.networkId && state.buffers.length > 0) {
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

function renderSidebar() {
    var container = document.getElementById('networks');
    var html = '';
    state.buffers.forEach(function(net) {
        var netUnread = net.buffers.reduce(function(sum, b) { return sum + (b.unreadCount || 0); }, 0);
        var netHighlight = net.buffers.some(function(b) { return b.highlight; });
        var collapsed = net.collapsed;
        var chevron = collapsed ? '▶' : '▼';

        html += '<div class="network">';
        html += '<div class="network-header">';
        html += '<span class="network-chevron" onclick="event.stopPropagation(); toggleNetwork(\'' + net.networkId + '\')">' + chevron + '</span>';
        html += '<span class="network-name-area" onclick="switchBuffer(\'' + net.networkId + '\', \'_server\')">';
        html += '<span class="network-status ' + (net.connected ? '' : 'disconnected') + '"></span>';
        html += '<span class="network-name-text">' + escapeHtml(net.name) + '</span>';
        if (netUnread > 0) {
            html += '<span class="unread network-unread ' + (netHighlight ? 'highlight' : '') + '">' + netUnread + '</span>';
        }
        html += '</span>';
        html += '</div>';

        if (!collapsed) {
            html += '<div class="network-buffers">';
            net.buffers.forEach(function(buf) {
                if (buf.name === '_server') return;
                var isActive = (net.networkId === activeBuffer.networkId && buf.name === activeBuffer.bufferName);
                var activeClass = isActive ? 'active' : '';
                var label = escapeHtml(buf.name);
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
    var net = getActiveNetwork();
    var bufObj = getActiveBufferObj();
    var isServer = bufferName === '_server';

    var channelName = document.getElementById('channel-name');
    var channelHost = document.getElementById('channel-host');
    var networkNick = document.getElementById('network-nick');
    var networkRealname = document.getElementById('network-realname');
    var editBtn = document.getElementById('edit-network-btn');
    var reconnectBtn = document.getElementById('reconnect-network-btn');
    var disconnectBtn = document.getElementById('disconnect-network-btn');

    if (isServer && net) {
        var tlsIcon = (net.tls && net.tls !== 'disabled') ? '🔒 ' : '';
        channelName.textContent = tlsIcon + net.name;
        channelHost.textContent = net.host + ':' + net.port;
        networkNick.textContent = net.currentNick || net.nick || '';
        networkRealname.textContent = net.realName || '';
        if (editBtn) editBtn.style.display = 'inline-block';
        if (reconnectBtn) reconnectBtn.style.display = 'inline-block';
        if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
    } else {
        channelName.textContent = bufferName;
        channelHost.textContent = (bufObj && bufObj.topic) ? bufObj.topic : (net ? net.host + ':' + net.port : '');
        networkNick.textContent = '';
        networkRealname.textContent = '';
        if (editBtn) editBtn.style.display = 'none';
        if (reconnectBtn) reconnectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
    }

    document.querySelector('#compose input[name="network"]').value = networkId;
    document.querySelector('#compose input[name="target"]').value = isServer ? '' : bufferName;
    document.getElementById('messages').innerHTML = '';
    window.lastMessageDate = null;

    var userList = document.getElementById('user-list-panel');
    var compose = document.getElementById('compose');
    if (isServer || (bufObj && bufObj.type === 'query')) {
        if (userList) userList.style.display = 'none';
        if (compose) compose.style.display = isServer ? 'none' : 'flex';
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
            window.lastMessageDate = null;
            var lastDate = null;
            var frag = document.createDocumentFragment();
            msgs.reverse().forEach(function(msg) {
                var ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
                var d = ts ? ts.split('T')[0] : '';
                if (d && d !== lastDate) {
                    var dayDiv = document.createElement('div');
                    dayDiv.className = 'day-divider';
                    dayDiv.innerHTML = '<span>' + formatDate(d) + '</span>';
                    frag.appendChild(dayDiv);
                    lastDate = d;
                }
                var el = buildMessageElement(msg, msg.highlight);
                if (el) frag.appendChild(el);
            });
            container.appendChild(frag);
            window.lastMessageDate = lastDate;
            container.scrollTop = container.scrollHeight;
        });
}

function handleIRCEvent(data) {
    var result = processIRCEvent(data);
    if (result.needsRender) renderSidebar();
}

function handleIRCEvents(events) {
    var needsRender = false;
    var frag = document.createDocumentFragment();
    events.forEach(function(data) {
        var r = processIRCEvent(data, frag);
        if (r.needsRender) needsRender = true;
    });
    if (frag.childNodes.length > 0) {
        var container = document.getElementById('messages');
        container.appendChild(frag);
        container.scrollTop = container.scrollHeight;
    }
    if (needsRender) renderSidebar();
}

function processIRCEvent(data, batchFrag) {
    var net = state.buffers.find(function(n) { return n.name === data.network; });
    if (!net) return { needsRender: false };
    var bufferName = data.channel || data.ch || '_server';
    var cmd = data.command || data.c || '';
    var text = data.text || data.x || '';
    var isHighlight = false;
    if ((cmd === 'PRIVMSG' || cmd === 'NOTICE') && text && net.currentNick) {
        var re = new RegExp('\\b' + escapeRegex(net.currentNick) + '\\b', 'i');
        if (re.test(text)) isHighlight = true;
    }
    incrementUnread(net.networkId, bufferName, isHighlight);
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
            net.wasDisconnected = false;
        }
        if (cmd === 'DISCONNECT') {
            net.connected = false;
            net.wasDisconnected = true;
        }
        var container = document.getElementById('messages');
        var target = batchFrag || container;
        var msgDate = getMsgDate(msg);
        if (msgDate) insertDayDividerIfNeeded(msgDate, target);
        var el = buildMessageElement(msg, isHighlight);
        if (el) {
            if (batchFrag) batchFrag.appendChild(el);
            else {
                container.appendChild(el);
                container.scrollTop = container.scrollHeight;
            }
        }
    } else {
        if (cmd === '001' || cmd === 'CONNECT') {
            net.connected = true;
            net.wasDisconnected = false;
        }
        if (cmd === 'DISCONNECT') {
            net.connected = false;
            net.wasDisconnected = true;
        }
    }
    return { needsRender: true };
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
                    timestamp: msg.timestamp || msg.t,
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

function buildMessageElement(msg, isHighlight) {
    var div = document.createElement('div');
    var cmd = msg.command || msg.c || '';
    var typeClass = 'message';
    if (cmd === 'JOIN' || cmd === 'PART' || cmd === 'QUIT' || cmd === 'NICK' || cmd === 'TOPIC' || cmd === 'CONNECT' || cmd === 'DISCONNECT' || cmd === 'ERROR' || cmd === 'MODE') typeClass += ' system';
    else if (msg.type === 'action' || msg.y === 'a') typeClass += ' action';
    if (isHighlight || msg.highlight) typeClass += ' highlight';
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
    var params = msg.params || msg.p || [];

    if (cmd === 'DISCONNECT') {
        div.className = 'message system disconnect-msg';
        var display = '&#x21D0; You disconnected';
        if (text && text !== 'You disconnected') {
            display += ': ' + escapeHtml(text);
        }
        div.innerHTML = '<span class="timestamp">' + time + '</span>' +
            '<span class="nick"></span>' +
            '<span class="text">' + display + '</span>';
        return div;
    }

    var displayText = formatNumericText(cmd, params, text);
    if (displayText === null) return null;
    if (!displayText && cmd) displayText = cmd;

    var nickColor = 'nick-color-' + (stringHash(nick) % 16);
    div.innerHTML = '<span class="timestamp">' + time + '</span>' +
        '<span class="nick ' + nickColor + '">' + escapeHtml(nick) + '</span>' +
        '<span class="text">' + parseIrcFormatting(displayText) + '</span>';
    return div;
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
        div.className = 'day-divider';
        div.innerHTML = '<span>' + formatDate(date) + '</span>';
        target.appendChild(div);
        window.lastMessageDate = date;
    }
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
    var modalTitle = document.getElementById('network-modal-title');
    var addBtn = document.getElementById('add-network-btn');
    if (addBtn && modal) {
        addBtn.addEventListener('click', function() {
            var form = document.getElementById('network-form');
            if (form) { form.reset(); form.dataset.mode = 'add'; form.networkId.value = ''; }
            if (modalTitle) modalTitle.textContent = 'Add Network';
            modal.style.display = 'flex';
        });
    }
    var editBtn = document.getElementById('edit-network-btn');
    if (editBtn && modal) {
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
            form.autoJoinChannels.value = (net.autoJoinChannels || []).join(', ');
            if (modalTitle) modalTitle.textContent = 'Edit Network';
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
                        modal.style.display = 'none';
                        form.reset();
                    });
                } else {
                    alert('Failed to ' + (isEdit ? 'update' : 'add') + ' network');
                }
            });
        });
    }

    var disconnectBtn = document.getElementById('disconnect-network-btn');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/disconnect', { method: 'POST' })
                .then(function(r) {
                    if (r.ok) {
                        net.connected = false;
                        net.wasDisconnected = true;
                        renderSidebar();
                        switchBuffer(net.networkId, '_server');
                    } else {
                        alert('Failed to disconnect');
                    }
                });
        });
    }

    var reconnectBtn = document.getElementById('reconnect-network-btn');
    if (reconnectBtn) {
        reconnectBtn.addEventListener('click', function() {
            var net = getActiveNetwork();
            if (!net) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/reconnect', { method: 'POST' })
                .then(function(r) {
                    if (r.ok) {
                        net.connected = true;
                        renderSidebar();
                    } else {
                        alert('Failed to reconnect');
                    }
                });
        });
    }

    var serverCtxMenu = document.getElementById('server-context-menu');
    var serverOptionsBtn = document.getElementById('server-options-btn');
    function hideContextMenu() {
        if (serverCtxMenu) serverCtxMenu.style.display = 'none';
    }
    if (serverOptionsBtn && serverCtxMenu) {
        serverOptionsBtn.addEventListener('click', function(evt) {
            evt.stopPropagation();
            var rect = serverOptionsBtn.getBoundingClientRect();
            serverCtxMenu.style.top = (rect.bottom + 4) + 'px';
            serverCtxMenu.style.left = rect.left + 'px';
            serverCtxMenu.style.display = 'block';
            updateContextMenuState();
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
    }

    var ctxReconnect = document.getElementById('ctx-reconnect');
    if (ctxReconnect) {
        ctxReconnect.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/reconnect', { method: 'POST' })
                .then(function(r) { if (r.ok) { net.connected = true; renderSidebar(); } else { alert('Failed to reconnect'); } });
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
            var modalTitle = document.getElementById('network-modal-title');
            if (modalTitle) modalTitle.textContent = 'Edit Network';
            var modal = document.getElementById('network-modal');
            if (modal) modal.style.display = 'flex';
        });
    }
    var ctxDisconnect = document.getElementById('ctx-disconnect');
    if (ctxDisconnect) {
        ctxDisconnect.addEventListener('click', function() {
            hideContextMenu();
            var net = getActiveNetwork();
            if (!net) return;
            fetch('/api/networks/' + encodeURIComponent(net.networkId) + '/disconnect', { method: 'POST' })
                .then(function(r) { if (r.ok) { net.connected = false; net.wasDisconnected = true; renderSidebar(); switchBuffer(net.networkId, '_server'); } else { alert('Failed to disconnect'); } });
        });
    }
    var ctxClear = document.getElementById('ctx-clear');
    if (ctxClear) {
        ctxClear.addEventListener('click', function() {
            hideContextMenu();
            var container = document.getElementById('messages');
            if (container) {
                container.innerHTML = '';
                window.lastMessageDate = null;
            }
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
                        document.getElementById('messages').innerHTML = '';
                        window.lastMessageDate = null;
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
                    if (!net.buffers.find(function(b) { return b.name === channel; })) {
                        net.buffers.push({ name: channel, type: 'channel', isJoined: true, unreadCount: 0, highlight: false, topic: '', users: [] });
                        renderSidebar();
                    }
                    switchBuffer(net.networkId, channel);
                } else {
                    alert('Failed to join channel');
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
