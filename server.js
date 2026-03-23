const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3000;
const R = 8, C = 10;

// === Static file server ===
const MIME = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml' };
const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8' });
        res.end(data);
    });
});

// === WebSocket ===
const wss = new WebSocket.Server({ server });
const rooms = new Map();

function genRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do { id = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
    while (rooms.has(id));
    return id;
}

function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendBoth(room, msg) {
    room.players.forEach(ws => { if (ws) send(ws, msg); });
}

// === Heartbeat (keep WebSocket alive through proxies) ===
const PING_INTERVAL = 25000; // 25s < nginx default 60s timeout
const pingTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, PING_INTERVAL);
wss.on('close', () => clearInterval(pingTimer));

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.roomId = null;
    ws.playerIdx = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        handle(ws, msg);
    });

    ws.on('close', () => {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const other = room.players[1 - ws.playerIdx];
        if (other) send(other, { type: 'opponent_disconnected' });
        // Clean up room after a while
        room.players[ws.playerIdx] = null;
        if (!room.players[0] && !room.players[1]) rooms.delete(ws.roomId);
    });
});

function handle(ws, msg) {
    switch (msg.type) {
        case 'create_room': {
            const id = genRoomId();
            const room = {
                id,
                players: [ws, null],
                boards: [null, null],
                ready: [false, false],
                phase: 'waiting', // waiting, setup, play, over
                attempts: [2, 2],
                histories: [[], []], // track fired positions per player
                turn: 0, // Player 0 goes first
            };
            rooms.set(id, room);
            ws.roomId = id;
            ws.playerIdx = 0;
            send(ws, { type: 'room_created', roomId: id, playerIdx: 0 });
            break;
        }
        case 'join_room': {
            const room = rooms.get(msg.roomId);
            if (!room) { send(ws, { type: 'error', message: '방을 찾을 수 없습니다' }); return; }
            if (room.players[1]) { send(ws, { type: 'error', message: '방이 가득 찼습니다' }); return; }
            room.players[1] = ws;
            ws.roomId = msg.roomId;
            ws.playerIdx = 1;
            room.phase = 'setup';
            send(ws, { type: 'room_joined', roomId: msg.roomId, playerIdx: 1 });
            send(room.players[0], { type: 'opponent_joined' });
            // Both enter setup phase
            sendBoth(room, { type: 'phase', phase: 'setup' });
            break;
        }
        case 'setup_done': {
            const room = rooms.get(ws.roomId);
            if (!room || room.phase !== 'setup') return;
            const idx = ws.playerIdx;
            // Validate board
            if (!validateBoard(msg.board)) {
                send(ws, { type: 'error', message: '보드가 유효하지 않습니다' });
                return;
            }
            room.boards[idx] = msg.board;
            room.ready[idx] = true;
            send(ws, { type: 'setup_accepted' });
            const other = room.players[1 - idx];
            if (other) send(other, { type: 'opponent_ready' });
            // If both ready, start game
            if (room.ready[0] && room.ready[1]) {
                room.phase = 'play';
                room.turn = 0;
                sendBoth(room, { type: 'game_start', turn: 0 });
            }
            break;
        }
        case 'fire_wave': {
            const room = rooms.get(ws.roomId);
            if (!room || room.phase !== 'play') return;
            const idx = ws.playerIdx;
            // Turn check
            if (room.turn !== idx) {
                send(ws, { type: 'error', message: '상대방의 차례입니다' });
                return;
            }
            const oppBoard = room.boards[1 - idx];
            // Check if already fired this position
            const key = `${msg.edge}-${msg.index}`;
            if (room.histories[idx].includes(key)) {
                send(ws, { type: 'error', message: '이미 발사한 위치입니다' });
                return;
            }
            room.histories[idx].push(key);
            const result = fireWave(oppBoard, msg.edge, msg.index);
            if (result.absorbed) {
                send(ws, {
                    type: 'wave_result',
                    absorbed: true,
                    entryEdge: msg.edge,
                    entryIndex: msg.index,
                    colorName: result.colorName,
                    colorHex: result.colorHex,
                });
            } else {
                send(ws, {
                    type: 'wave_result',
                    entryEdge: msg.edge,
                    entryIndex: msg.index,
                    exitEdge: result.exitEdge,
                    exitIndex: result.exitIndex,
                    colorName: result.colorName,
                    colorHex: result.colorHex,
                });
            }
            // Switch turn
            room.turn = 1 - idx;
            sendBoth(room, { type: 'turn_change', turn: room.turn });
            break;
        }
        case 'submit_guess': {
            const room = rooms.get(ws.roomId);
            if (!room || room.phase !== 'play') return;
            const idx = ws.playerIdx;
            // Turn check
            if (room.turn !== idx) {
                send(ws, { type: 'error', message: '상대방의 차례입니다' });
                return;
            }
            const oppBoard = room.boards[1 - idx];
            // Compare cell by cell
            let correct = true;
            for (let r = 0; r < R; r++) {
                for (let c = 0; c < C; c++) {
                    if ((msg.board[r][c] || null) !== (oppBoard[r][c] || null)) {
                        correct = false; break;
                    }
                }
                if (!correct) break;
            }
            if (correct) {
                room.phase = 'over';
                send(ws, { type: 'you_win', opponentBoard: oppBoard });
                const other = room.players[1 - idx];
                if (other) send(other, { type: 'you_lose', opponentBoard: room.boards[idx] });
            } else {
                room.attempts[idx]--;
                if (room.attempts[idx] <= 0) {
                    room.phase = 'over';
                    send(ws, { type: 'you_lose', opponentBoard: oppBoard, reason: '기회 소진' });
                    const other = room.players[1 - idx];
                    if (other) send(other, { type: 'you_win', opponentBoard: room.boards[idx], reason: '상대 기회 소진' });
                } else {
                    // Calculate how many cells match
                    let matchCount = 0, totalCells = 0;
                    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
                        if (oppBoard[r][c]) totalCells++;
                        if ((msg.board[r][c] || null) === (oppBoard[r][c] || null) && oppBoard[r][c]) matchCount++;
                    }
                    // Switch turn on wrong guess
                    room.turn = 1 - idx;
                    send(ws, { type: 'guess_wrong', matchCount, totalCells, attemptsLeft: room.attempts[idx] });
                    sendBoth(room, { type: 'turn_change', turn: room.turn });
                }
            }
            break;
        }
    }
}

function validateBoard(board) {
    if (!board || board.length !== R) return false;
    let cellCount = 0;
    const colorCounts = {};
    for (let r = 0; r < R; r++) {
        if (!board[r] || board[r].length !== C) return false;
        for (let c = 0; c < C; c++) {
            if (board[r][c]) {
                cellCount++;
                colorCounts[board[r][c]] = (colorCounts[board[r][c]] || 0) + 1;
            }
        }
    }
    // 5 pieces: white(6+6=12), red(3), blue(4), yellow(3) = 22 cells
    return cellCount >= 18 && cellCount <= 28;
}

// === Wave simulation (server-side) ===
const DIR = { up: [-1,0], down: [1,0], left: [0,-1], right: [0,1] };

// Reflect direction based on cell fill type
function reflectDir(dir, fill) {
    if (fill === 'solid') {
        // Flat wall → 180° reverse
        return dir==='up'?'down':dir==='down'?'up':dir==='left'?'right':'left';
    }
    if (fill === 'bl' || fill === 'tr') {
        // ◣/◥ → \ mirror (diagonal top-left to bottom-right)
        return dir==='right'?'down':dir==='down'?'right':dir==='left'?'up':'left';
    }
    // tl/br → ◤/◢ → / mirror (diagonal bottom-left to top-right)
    return dir==='right'?'up':dir==='up'?'right':dir==='left'?'down':'left';
}

const MIX_MAP = {
    '':'무색/transparent','R':'적색파/#e74c3c','B':'청색파/#3498db','Y':'황색파/#f1c40f','W':'백색광/#ecf0f1',
    'BR':'자외선/#9b59b6','RY':'적외선/#e67e22','BY':'오로라/#2ecc71','BRY':'블랙홀/#000000',
};

function fireWave(board, edge, index) {
    let r, c, dir;
    if (edge==='top') { r=-1; c=index; dir='down'; }
    else if (edge==='bottom') { r=R; c=index; dir='up'; }
    else if (edge==='left') { r=index; c=-1; dir='right'; }
    else { r=index; c=C; dir='left'; }

    const path = [];
    const colorsHit = new Set();
    let bounces = 0;
    while (bounces < 50) {
        r += DIR[dir][0]; c += DIR[dir][1];
        if (r < 0 || r >= R || c < 0 || c >= C) break;
        const m = board[r][c];
        path.push({ r, c, hit: !!m });
        if (m) {
            const [color, fill] = m.split(':');
            colorsHit.add(color[0].toUpperCase());
            dir = reflectDir(dir, fill || 'solid');
            bounces++;
        }
    }

    let exitEdge, exitIndex;
    if (r < 0) { exitEdge='top'; exitIndex=c; }
    else if (r >= R) { exitEdge='bottom'; exitIndex=c; }
    else if (c < 0) { exitEdge='left'; exitIndex=r; }
    else { exitEdge='right'; exitIndex=r; }

    // White is ignored when mixed with other colors
    const nonW = [...colorsHit].filter(c => c !== 'W').sort().join('');
    const key = nonW || (colorsHit.has('W') ? 'W' : '');
    const mix = MIX_MAP[key] || MIX_MAP[''];
    const [colorName, colorHex] = mix.split('/');
    // Black hole: all 3 colors → absorbed, no exit info
    if (key === 'BRY') {
        return { absorbed: true, colorName, colorHex, entryEdge: edge, entryIndex: index };
    }
    return { exitEdge, exitIndex, colorName, colorHex, path };
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Stellar Veil server running on http://0.0.0.0:${PORT}`);
});
