// --- VARIABLES GLOBALES ---
const ASSETS_PATH = 'assets/cards/';
const LOBBY_PREFIX = 'akhirox-uno-lobby-';
const CARD_BACK = 'uno_card.png';

let myPseudo = '';
let myAvatar = '';
let myPeer = null;
let isHost = false;
let currentLobbyId = '';

// Variables Hôte
let connections = {}; 
let clients = []; 

// Variables Client & Animations
let hostConnection = null;
let myHand = [];
let amIProtectedUNO = false; 
let pendingDrawnCards = []; 
let stateQueue = []; 
let isAnimating = false;

// État Global du jeu
let gameState = {
    status: 'LOBBY',
    deck: [],
    discardPile: [],
    players: {}, 
    playerOrder: [], 
    currentTurnIndex: 0,
    direction: 1,
    currentColor: '',
    currentValue: ''
};

// --- UTILITAIRES UI (Toasts & Big Messages) ---
function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast glow';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showBigMessage(avatar, title, desc) {
    const overlay = document.getElementById('big-message-overlay');
    document.getElementById('big-msg-img').src = `assets/avatars/${avatar}`;
    document.getElementById('big-msg-title').innerText = title;
    document.getElementById('big-msg-desc').innerText = desc;
    overlay.classList.add('show');
    setTimeout(() => overlay.classList.remove('show'), 3500); 
}

function showEndScreen(player) {
    const overlay = document.getElementById('end-screen');
    document.getElementById('winner-img').src = `assets/avatars/${player.avatar}`;
    document.getElementById('winner-name').innerText = `${player.pseudo} remporte la partie !`;

    if (isHost) {
        document.getElementById('btn-restart-game').style.display = 'block';
        document.getElementById('end-waiting-text').style.display = 'none';
    } else {
        document.getElementById('btn-restart-game').style.display = 'none';
        document.getElementById('end-waiting-text').style.display = 'block';
    }

    overlay.style.display = 'flex';
    setTimeout(() => overlay.classList.add('show'), 10);
}

// --- UTILITAIRES CARTES ---
function parseCard(filename) {
    if(filename.includes('wild_plus4')) return { color: 'none', value: 'plus4', type: 'wild' };
    if(filename.includes('wild_card')) return { color: 'none', value: 'wild', type: 'wild' };
    let parts = filename.split('.')[0].split('_'); 
    return { color: parts[1], value: parts[0], type: 'normal' };
}

function isCardPlayable(cardFile, currentState) {
    const card = parseCard(cardFile);
    if(card.type === 'wild') return true; 
    return card.color === currentState.currentColor || card.value === currentState.currentValue;
}

// --- MOTEUR D'ANIMATION ---
function flyCard(startEl, endEl, cardFile) {
    return new Promise(resolve => {
        if(!startEl || !endEl) return resolve();
        const startRect = startEl.getBoundingClientRect();
        const endRect = endEl.getBoundingClientRect();

        const flyingCard = document.createElement('div');
        flyingCard.className = 'card flying-card';
        flyingCard.style.position = 'fixed';
        flyingCard.style.left = `${startRect.left}px`;
        flyingCard.style.top = `${startRect.top}px`;
        flyingCard.style.backgroundImage = `url('${ASSETS_PATH}${cardFile}')`;
        flyingCard.style.zIndex = '9999';
        document.body.appendChild(flyingCard);

        const deltaX = endRect.left - startRect.left;
        const deltaY = endRect.top - startRect.top;

        const animation = flyingCard.animate([
            { transform: 'translate(0, 0) scale(1) rotate(0deg)' },
            { transform: `translate(${deltaX}px, ${deltaY}px) scale(1.1) rotate(15deg)` } 
        ], { duration: 400, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' });

        animation.onfinish = () => { flyingCard.remove(); resolve(); };
    });
}

async function processStateQueue() {
    if(isAnimating || stateQueue.length === 0) return;
    isAnimating = true;
    
    const payload = stateQueue.shift();
    const nextState = payload.state;
    const action = payload.action;

    if (nextState.status === 'LOBBY') {
        gameState = nextState;
        updateLobbyUI();
        isAnimating = false;
        processStateQueue();
        return;
    }

    // LE CORRECTIF EST ICI : Fait passer les clients dans la partie visuellement !
    if (gameState.status === 'LOBBY' && nextState.status === 'PLAYING') {
        showGameScreen();
    }

    if (action) {
        if (action.type === 'PLAY') {
            const isMe = action.playerId === myPeer.id;
            const startEl = isMe ? document.getElementById('my-avatar') : document.getElementById(`avatar-${action.playerId}`);
            const endEl = document.getElementById('discard-pile');
            await flyCard(startEl, endEl, action.card);
        } 
        else if (action.type === 'DRAW') {
            const startEl = document.getElementById('draw-pile');
            const isMe = action.playerId === myPeer.id;
            const endEl = isMe ? document.getElementById('my-avatar') : document.getElementById(`avatar-${action.playerId}`);
            for(let i=0; i<action.amount; i++) {
                flyCard(startEl, endEl, CARD_BACK);
                await new Promise(r => setTimeout(r, 150)); 
            }
            await new Promise(r => setTimeout(r, 300)); 
        }
        else if (action.type === 'UNO_CALLED') {
            const p = nextState.players[action.playerId];
            showBigMessage(p.avatar, "UNO !", `${p.pseudo} a dit UNO !`);
            await new Promise(r => setTimeout(r, 2000));
        }
        else if (action.type === 'SUCCESSFUL_DENOUNCE') {
            const denouncer = nextState.players[action.denouncerId];
            const target = nextState.players[action.targetId];
            showBigMessage(denouncer.avatar, "DÉNONCÉ !", `${denouncer.pseudo} a dénoncé ${target.pseudo} !`);
            await new Promise(r => setTimeout(r, 2500));
            
            const startEl = document.getElementById('draw-pile');
            const isMe = action.targetId === myPeer.id;
            const endEl = isMe ? document.getElementById('my-avatar') : document.getElementById(`avatar-${action.targetId}`);
            for(let i=0; i<4; i++) {
                flyCard(startEl, endEl, CARD_BACK);
                await new Promise(r => setTimeout(r, 150));
            }
            await new Promise(r => setTimeout(r, 300));
        }
        else if (action.type === 'WIN') {
            const winner = nextState.players[action.playerId];
            showEndScreen(winner);
        }
        else if (action.type === 'RESTART') {
            document.getElementById('end-screen').classList.remove('show');
            setTimeout(() => { document.getElementById('end-screen').style.display = 'none'; }, 300);
            showToast("La partie recommence !");
            showGameScreen();
        }
    }
    
    gameState = nextState;
    if (gameState.status === 'PLAYING' || gameState.status === 'FINISHED') {
        updateUI();
    }
    
    isAnimating = false;
    processStateQueue();
}

function handleStatePayload(payload) {
    if (payload.type === 'DIRECT_ACTION') {
        if (payload.data.type === 'TOAST') {
            showToast(payload.data.message);
        }
    }
    else if (payload.type === 'RECEIVE_CARDS') {
        if (payload.data.override) {
            myHand = [...payload.data.cards];
            pendingDrawnCards = []; 
        } else {
            pendingDrawnCards.push(...payload.data.cards);
            myHand.push(...payload.data.cards);
        }
    }
    else if (payload.type === 'STATE_UPDATE') {
        stateQueue.push(payload.data);
        processStateQueue();
    }
}

// --- INITIALISATION DU MENU ET LOBBY ---
document.addEventListener('DOMContentLoaded', () => {
    const avatars = document.querySelectorAll('.avatar-option');
    avatars.forEach(img => {
        img.addEventListener('click', () => {
            avatars.forEach(a => a.classList.remove('selected'));
            img.classList.add('selected');
        });
    });

    const lobbyBtns = document.querySelectorAll('.btn-lobby');
    lobbyBtns.forEach(btn => {
        if(btn.id !== 'btn-start-game' && btn.id !== 'btn-restart-game') {
            btn.addEventListener('click', () => {
                const pseudoInput = document.getElementById('pseudo').value.trim();
                if (!pseudoInput) return alert("N'oublie pas ton pseudo !");
                myPseudo = pseudoInput;
                myAvatar = document.querySelector('.avatar-option.selected').getAttribute('data-avatar');
                currentLobbyId = btn.getAttribute('data-lobby');
                joinLobby(currentLobbyId);
            });
        }
    });

    document.getElementById('btn-start-game').addEventListener('click', startGameHost);
    document.getElementById('btn-restart-game').addEventListener('click', restartGameHost);
});

function showLobbyScreen() {
    document.getElementById('menu-screen').classList.remove('active');
    document.getElementById('game-screen').classList.remove('active');
    document.getElementById('lobby-screen').classList.add('active');
    document.getElementById('lobby-title').innerText = "Salle d'attente - Lobby " + currentLobbyId;

    if (isHost) {
        document.getElementById('btn-start-game').style.display = 'block';
        document.getElementById('lobby-waiting-text').style.display = 'none';
    } else {
        document.getElementById('btn-start-game').style.display = 'none';
        document.getElementById('lobby-waiting-text').style.display = 'block';
    }
}

function updateLobbyUI() {
    showLobbyScreen();
    const list = document.getElementById('lobby-players-list');
    list.innerHTML = '';
    Object.keys(gameState.players).forEach(id => {
        const p = gameState.players[id];
        const div = document.createElement('div');
        div.className = 'lobby-player-item glow';
        div.innerHTML = `<img src="assets/avatars/${p.avatar}" alt="${p.pseudo}"><span>${p.pseudo}</span>`;
        list.appendChild(div);
    });
}

// --- PEERJS: CONNEXION ---
function joinLobby(lobbyNumber) {
    const statusText = document.getElementById('connection-status');
    statusText.innerText = "Connexion en cours...";
    const targetLobbyId = LOBBY_PREFIX + lobbyNumber;

    myPeer = new Peer(targetLobbyId);

    myPeer.on('open', (id) => {
        isHost = true;
        showLobbyScreen();
        addPlayerToState(id, myPseudo, myAvatar);
    });

    myPeer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            myPeer = new Peer();
            myPeer.on('open', (myId) => {
                hostConnection = myPeer.connect(targetLobbyId, { reliable: true });
                
                hostConnection.on('open', () => {
                    hostConnection.send({ type: 'JOIN', data: { pseudo: myPseudo, avatar: myAvatar } });
                });
                hostConnection.on('data', handleStatePayload);
            });
        } else {
            statusText.innerText = "Erreur : " + err.type;
        }
    });

    myPeer.on('connection', (conn) => {
        if (!isHost) return;
        connections[conn.peer] = conn;
        if(!clients.includes(conn.peer)) clients.push(conn.peer);
        conn.on('data', (data) => handleDataFromClient(conn.peer, data));
    });
}

// --- LOGIQUE HÔTE ---
function sendDirectAction(targetId, action) {
    if (targetId === myPeer.id) {
        handleStatePayload({ type: 'DIRECT_ACTION', data: action });
    } else {
        connections[targetId].send({ type: 'DIRECT_ACTION', data: action });
    }
}

function addPlayerToState(id, pseudo, avatar) {
    gameState.players[id] = { pseudo, avatar, handCount: 0, unoVulnerable: false };
    if(!gameState.playerOrder.includes(id)) gameState.playerOrder.push(id);
    if(isHost) broadcastState();
}

function startGameHost() {
    gameState.status = 'PLAYING';
    gameState.deck = shuffle(generateDeck());
    
    gameState.playerOrder.forEach(id => {
        const hand = gameState.deck.splice(-7);
        gameState.players[id].handCount = 7;
        sendCards(id, hand, true); 
    });

    let firstCard;
    do { firstCard = gameState.deck.pop(); } while(firstCard.includes('wild_plus4'));
    
    gameState.discardPile.push(firstCard);
    const parsedFirst = parseCard(firstCard);
    gameState.currentColor = parsedFirst.color === 'none' ? 'red' : parsedFirst.color; 
    gameState.currentValue = parsedFirst.value;

    broadcastState();
    showGameScreen();
}

function restartGameHost() {
    document.getElementById('end-screen').classList.remove('show');
    setTimeout(() => document.getElementById('end-screen').style.display = 'none', 300);

    gameState.status = 'PLAYING';
    gameState.deck = shuffle(generateDeck());
    gameState.discardPile = [];
    gameState.currentTurnIndex = 0;
    gameState.direction = 1;

    gameState.playerOrder.forEach(id => {
        gameState.players[id].handCount = 7;
        gameState.players[id].unoVulnerable = false;
    });

    stateQueue = [];
    isAnimating = false;

    gameState.playerOrder.forEach(id => {
        const hand = gameState.deck.splice(-7);
        sendCards(id, hand, true); 
    });

    let firstCard;
    do { firstCard = gameState.deck.pop(); } while(firstCard.includes('wild_plus4'));

    gameState.discardPile.push(firstCard);
    const parsedFirst = parseCard(firstCard);
    gameState.currentColor = parsedFirst.color === 'none' ? 'red' : parsedFirst.color;
    gameState.currentValue = parsedFirst.value;

    broadcastState({ type: 'RESTART' });
}

function handleDataFromClient(clientId, payload) {
    if (payload.type === 'JOIN') addPlayerToState(clientId, payload.data.pseudo, payload.data.avatar);
    if(gameState.status !== 'PLAYING') return;

    if (payload.type === 'PLAY_CARD') processPlayCard(clientId, payload.data.card, payload.data.chosenColor, payload.data.declaredUno);
    if (payload.type === 'DRAW_CARD') processDrawCard(clientId);
    
    if (payload.type === 'SAY_UNO_LATE') {
        const p = gameState.players[clientId];
        if(p.handCount === 1) {
            p.unoVulnerable = false;
            broadcastState({ type: 'UNO_CALLED', playerId: clientId });
        }
    }
    
    if (payload.type === 'DENOUNCE_UNO') {
        const targetId = payload.data.targetId;
        const targetPlayer = gameState.players[targetId];

        if (targetPlayer.handCount > 1) {
            sendDirectAction(clientId, { type: 'TOAST', message: `${targetPlayer.pseudo} a plus d'une carte.` });
        } 
        else if (!targetPlayer.unoVulnerable) {
            sendDirectAction(clientId, { type: 'TOAST', message: `${targetPlayer.pseudo} est protégé !` });
        } 
        else {
            const penalties = drawCardsFromDeck(4);
            targetPlayer.handCount += 4;
            targetPlayer.unoVulnerable = false;
            sendCards(targetId, penalties, false);
            broadcastState({ type: 'SUCCESSFUL_DENOUNCE', denouncerId: clientId, targetId: targetId });
        }
    }
}

function processPlayCard(playerId, cardPlayed, chosenColor, declaredUno) {
    const expectedPlayerId = gameState.playerOrder[gameState.currentTurnIndex];
    if(playerId !== expectedPlayerId) return; 

    if(!isCardPlayable(cardPlayed, gameState)) return; 

    gameState.discardPile.push(cardPlayed);
    gameState.players[playerId].handCount--;
    
    const parsed = parseCard(cardPlayed);
    gameState.currentColor = parsed.color === 'none' ? chosenColor : parsed.color;
    gameState.currentValue = parsed.value;

    clearVulnerabilities();

    let triggerUnoCall = false;
    let isWin = false;

    if(gameState.players[playerId].handCount === 1) {
        if (declaredUno) {
            gameState.players[playerId].unoVulnerable = false;
            triggerUnoCall = true;
        } else {
            gameState.players[playerId].unoVulnerable = true; 
        }
    } else if (gameState.players[playerId].handCount === 0) {
        isWin = true;
        gameState.status = 'FINISHED';
    }

    let skipNext = false;
    if(parsed.value === 'reverse') {
        gameState.direction *= -1;
        if(gameState.playerOrder.length === 2) skipNext = true; 
    } else if (parsed.value === 'skip') {
        skipNext = true;
    } else if (parsed.value === 'plus2') {
        applyPenaltyToNext(2);
        skipNext = true;
    } else if (parsed.value === 'plus4') {
        applyPenaltyToNext(4);
        skipNext = true;
    }
    
    broadcastState({ type: 'PLAY', playerId, card: cardPlayed });

    if(triggerUnoCall) {
        broadcastState({ type: 'UNO_CALLED', playerId: playerId });
    }

    if (isWin) {
        broadcastState({ type: 'WIN', playerId: playerId });
    } else if (gameState.status === 'PLAYING') {
        advanceTurn(skipNext ? 2 : 1);
        broadcastState();
    }
}

function processDrawCard(playerId) {
    const expectedPlayerId = gameState.playerOrder[gameState.currentTurnIndex];
    if(playerId !== expectedPlayerId) return;
    
    clearVulnerabilities();
    const card = drawCardsFromDeck(1);
    gameState.players[playerId].handCount += 1;
    sendCards(playerId, card, false);
    
    advanceTurn(1);
    broadcastState({ type: 'DRAW', playerId, amount: 1 });
}

function applyPenaltyToNext(amount) {
    let nextIndex = (gameState.currentTurnIndex + gameState.direction + gameState.playerOrder.length) % gameState.playerOrder.length;
    let targetId = gameState.playerOrder[nextIndex];
    let cards = drawCardsFromDeck(amount);
    gameState.players[targetId].handCount += amount;
    sendCards(targetId, cards, false);
}

function drawCardsFromDeck(amount) {
    if(gameState.deck.length < amount) {
        const top = gameState.discardPile.pop();
        gameState.deck = shuffle(gameState.discardPile);
        gameState.discardPile = [top];
    }
    return gameState.deck.splice(-amount, amount);
}

function advanceTurn(steps) {
    let numPlayers = gameState.playerOrder.length;
    let move = (steps * gameState.direction) % numPlayers;
    gameState.currentTurnIndex = (gameState.currentTurnIndex + move + numPlayers) % numPlayers;
}

function clearVulnerabilities() {
    Object.keys(gameState.players).forEach(p => gameState.players[p].unoVulnerable = false);
}

function sendCards(targetId, cards, override = false) {
    if(targetId === myPeer.id) {
        handleStatePayload({ type: 'RECEIVE_CARDS', data: { cards, override } });
    } else {
        connections[targetId].send({ type: 'RECEIVE_CARDS', data: { cards, override } });
    }
}

function broadcastState(action = null) {
    const payload = { type: 'STATE_UPDATE', data: { state: gameState, action } };
    clients.forEach(id => {
        connections[id].send(payload);
    });
    handleStatePayload(JSON.parse(JSON.stringify(payload)));
}

// --- LOGIQUE CLIENT & UI ---
function showGameScreen() {
    document.getElementById('lobby-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('my-pseudo').innerText = myPseudo;
    document.getElementById('my-avatar').src = `assets/avatars/${myAvatar}`;
}

function updateUI() {
    if(gameState.status !== 'PLAYING' && gameState.status !== 'FINISHED') return;

    if(gameState.discardPile.length > 0) {
        const topCard = gameState.discardPile[gameState.discardPile.length - 1];
        document.getElementById('discard-pile').innerHTML = `<div class="card" style="background-image: url('${ASSETS_PATH}${topCard}')"></div>`;
    }
    
    const colorInd = document.getElementById('current-color-indicator');
    if(gameState.currentColor) {
        colorInd.style.display = 'block';
        const colorMap = { 'red':'#c1272d', 'blue':'#005a9e', 'green':'#2b7a0b', 'yellow':'#f7b731' };
        colorInd.style.backgroundColor = colorMap[gameState.currentColor];
    }

    const currentTurnId = gameState.playerOrder[gameState.currentTurnIndex];
    const myId = myPeer.id; 
    const isMyTurn = currentTurnId === myId;

    document.getElementById('turn-indicator').innerText = isMyTurn ? "C'est ton tour !" : `Tour de ${gameState.players[currentTurnId].pseudo}`;
    
    const myInfoBlock = document.getElementById('my-player-info');
    isMyTurn ? myInfoBlock.classList.add('active-turn') : myInfoBlock.classList.remove('active-turn');

    const myPlayerInfo = gameState.players[myId];
    const btnUno = document.getElementById('btn-say-uno');
    if (myPlayerInfo && myPlayerInfo.handCount === 1 && !myPlayerInfo.unoVulnerable) {
        btnUno.style.backgroundColor = '#2b7a0b'; 
        btnUno.innerText = "PROTÉGÉ";
        btnUno.disabled = true;
    } else {
        btnUno.style.backgroundColor = ''; 
        btnUno.innerText = "UNO !";
        btnUno.disabled = false;
    }

    const oppContainer = document.getElementById('opponents-container');
    oppContainer.innerHTML = '';
    
    const opponents = gameState.playerOrder.filter(id => id !== myId);
    const oppCount = opponents.length;

    opponents.forEach((id, index) => {
        const p = gameState.players[id];
        const isTurn = id === currentTurnId;
        const isProtected = p.handCount === 1 && !p.unoVulnerable;
        
        const minAngle = 20;
        const maxAngle = 160;
        let angle = 90;
        if (oppCount > 1) {
            angle = maxAngle - ((maxAngle - minAngle) / (oppCount - 1)) * index;
        }
        const rad = angle * (Math.PI / 180);
        const leftPercent = 50 + 40 * Math.cos(rad);
        const topPercent = 35 - 30 * Math.sin(rad); 

        const oppDiv = document.createElement('div');
        oppDiv.className = `opponent ${isTurn ? 'active-turn' : ''}`;
        oppDiv.style.left = `${leftPercent}%`;
        oppDiv.style.top = `${topPercent}%`;

        let cardsHTML = '';
        for(let i=0; i<p.handCount; i++) {
            cardsHTML += `<div class="mini-card"></div>`;
        }

        const badgeHTML = isProtected ? `<div class="uno-protected-badge">UNO!</div>` : '';
        const denounceDisabled = !p.unoVulnerable || p.handCount !== 1 ? 'disabled' : '';

        oppDiv.innerHTML = `
            <div style="position: relative;">
                <img id="avatar-${id}" src="assets/avatars/${p.avatar}" alt="${p.pseudo}">
                ${badgeHTML}
            </div>
            <div class="opponent-info">
                <span class="glow">${p.pseudo}</span>
                <div class="opponent-hand">${cardsHTML}</div>
                <button class="btn-uno" onclick="denounceUno('${id}')" ${denounceDisabled}>Dénoncer</button>
            </div>
        `;
        oppContainer.appendChild(oppDiv);
    });

    renderMyHand();
}

function renderMyHand() {
    const handDiv = document.getElementById('my-hand');
    handDiv.innerHTML = '';

    myHand.forEach((card, index) => {
        const cardEl = document.createElement('div');
        cardEl.className = 'card';
        cardEl.style.backgroundImage = `url('${ASSETS_PATH}${card}')`;
        cardEl.onclick = () => attemptPlayCard(index);
        handDiv.appendChild(cardEl);
    });
}

// --- ACTIONS DU JOUEUR ---
let pendingCardPlayIndex = -1;

function attemptPlayCard(index) {
    if (gameState.status !== 'PLAYING') return;
    const currentTurnId = gameState.playerOrder[gameState.currentTurnIndex];
    if (currentTurnId !== myPeer.id) return; 

    const card = myHand[index];
    if (!isCardPlayable(card, gameState)) return; 

    const parsed = parseCard(card);
    if(parsed.type === 'wild') {
        pendingCardPlayIndex = index;
        document.getElementById('color-picker-modal').style.display = 'flex';
    } else {
        finalizePlayCard(index, parsed.color);
    }
}

document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const color = btn.getAttribute('data-color');
        document.getElementById('color-picker-modal').style.display = 'none';
        finalizePlayCard(pendingCardPlayIndex, color);
    });
});

function finalizePlayCard(index, chosenColor) {
    const cardPlayed = myHand[index];
    myHand.splice(index, 1); 
    
    const declaredUno = amIProtectedUNO;
    amIProtectedUNO = false; 

    sendAction({ type: 'PLAY_CARD', data: { card: cardPlayed, chosenColor, declaredUno: declaredUno } });
    renderMyHand(); 
}

document.getElementById('draw-pile').addEventListener('click', () => {
    if(gameState.status === 'PLAYING' && gameState.playerOrder[gameState.currentTurnIndex] === myPeer.id) {
        sendAction({ type: 'DRAW_CARD' });
    }
});

document.getElementById('btn-say-uno').addEventListener('click', () => {
    if (gameState.status !== 'PLAYING') return;
    if (myHand.length > 2) {
        showToast("Tu as trop de cartes !");
    } else if (myHand.length === 2) {
        amIProtectedUNO = true;
        showToast("UNO préparé ! Joue vite ta carte.");
    } else if (myHand.length === 1) {
        sendAction({ type: 'SAY_UNO_LATE' });
    }
});

function denounceUno(targetId) {
    if (gameState.status === 'PLAYING') {
        sendAction({ type: 'DENOUNCE_UNO', data: { targetId } });
    }
}

function sendAction(payload) {
    if(isHost) {
        handleDataFromClient(myPeer.id, payload);
    } else {
        hostConnection.send(payload);
    }
}

// --- UTILITAIRES ---
function generateDeck() {
    const colors = ['blue', 'green', 'red', 'yellow'];
    let deck = [];
    colors.forEach(color => {
        deck.push(`0_${color}.png`);
        for(let i=1; i<=9; i++) { deck.push(`${i}_${color}.png`, `${i}_${color}.png`); }
        deck.push(`skip_${color}.png`, `skip_${color}.png`);
        deck.push(`reverse_${color}.png`, `reverse_${color}.png`);
        deck.push(`plus2_${color}.png`, `plus2_${color}.png`);
    });
    for(let i=0; i<4; i++) { deck.push('wild_card.png', 'wild_plus4.png'); }
    return deck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}