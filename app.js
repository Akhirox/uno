// --- VARIABLES GLOBALES ---
const ASSETS_PATH = 'assets/cards/';
const LOBBY_PREFIX = 'akhirox-uno-lobby-';
const CARD_BACK = 'uno_card.png';

let myPseudo = '';
let myAvatar = '';
let myPeer = null;
let isHost = false;

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
        ], {
            duration: 400,
            easing: 'cubic-bezier(0.25, 1, 0.5, 1)'
        });

        animation.onfinish = () => {
            flyingCard.remove();
            resolve();
        };
    });
}

async function processStateQueue() {
    if(isAnimating || stateQueue.length === 0) return;
    isAnimating = true;
    
    const payload = stateQueue.shift();
    const nextState = payload.state;
    const action = payload.action;

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
                const cardImage = (isMe && pendingDrawnCards.length > 0) ? pendingDrawnCards.shift() : CARD_BACK;
                flyCard(startEl, endEl, cardImage);
                await new Promise(r => setTimeout(r, 150)); 
            }
            await new Promise(r => setTimeout(r, 300)); 
        }
    }
    
    gameState = nextState;
    updateUI();
    isAnimating = false;
    processStateQueue();
}

function handleStatePayload(payload) {
    if (payload.type === 'RECEIVE_CARDS') {
        pendingDrawnCards.push(...payload.data.cards);
        myHand.push(...payload.data.cards);
    }
    if (payload.type === 'STATE_UPDATE') {
        stateQueue.push(payload.data);
        processStateQueue();
    }
}

// --- INITIALISATION DU MENU ---
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
        if(btn.id !== 'btn-start-game') {
            btn.addEventListener('click', () => {
                const pseudoInput = document.getElementById('pseudo').value.trim();
                if (!pseudoInput) return alert("N'oublie pas ton pseudo !");
                myPseudo = pseudoInput;
                myAvatar = document.querySelector('.avatar-option.selected').getAttribute('data-avatar');
                joinLobby(btn.getAttribute('data-lobby'));
            });
        }
    });

    document.getElementById('btn-start-game').addEventListener('click', startGameHost);
});

// --- PEERJS: CONNEXION ---
function joinLobby(lobbyNumber) {
    const statusText = document.getElementById('connection-status');
    statusText.innerText = "Connexion en cours...";
    const targetLobbyId = LOBBY_PREFIX + lobbyNumber;

    myPeer = new Peer(targetLobbyId);

    myPeer.on('open', (id) => {
        isHost = true;
        statusText.innerText = "Lobby créé ! Tu es l'hôte.";
        document.querySelector('.lobby-buttons').style.display = 'none';
        document.getElementById('btn-start-game').style.display = 'block';
        addPlayerToState(id, myPseudo, myAvatar);
    });

    myPeer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            myPeer = new Peer();
            myPeer.on('open', (myId) => {
                statusText.innerText = "Rejoindre le lobby existant...";
                hostConnection = myPeer.connect(targetLobbyId, { reliable: true });
                
                hostConnection.on('open', () => {
                    hostConnection.send({ type: 'JOIN', data: { pseudo: myPseudo, avatar: myAvatar } });
                    showGameScreen();
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
        sendCards(id, hand);
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

function handleDataFromClient(clientId, payload) {
    if (payload.type === 'JOIN') addPlayerToState(clientId, payload.data.pseudo, payload.data.avatar);
    if(gameState.status !== 'PLAYING') return;

    if (payload.type === 'PLAY_CARD') processPlayCard(clientId, payload.data.card, payload.data.chosenColor);
    if (payload.type === 'DRAW_CARD') processDrawCard(clientId);
    if (payload.type === 'SAY_UNO') {
        gameState.players[clientId].unoVulnerable = false;
        broadcastState();
    }
    if (payload.type === 'DENOUNCE_UNO') {
        const targetId = payload.data.targetId;
        if(gameState.players[targetId].unoVulnerable) {
            const penalties = drawCardsFromDeck(4);
            gameState.players[targetId].handCount += 4;
            gameState.players[targetId].unoVulnerable = false;
            sendCards(targetId, penalties);
            broadcastState({ type: 'DRAW', playerId: targetId, amount: 4 });
        }
    }
}

function processPlayCard(playerId, cardPlayed, chosenColor) {
    const expectedPlayerId = gameState.playerOrder[gameState.currentTurnIndex];
    if(playerId !== expectedPlayerId) return; 

    if(!isCardPlayable(cardPlayed, gameState)) return; 

    gameState.discardPile.push(cardPlayed);
    gameState.players[playerId].handCount--;
    
    const parsed = parseCard(cardPlayed);
    gameState.currentColor = parsed.color === 'none' ? chosenColor : parsed.color;
    gameState.currentValue = parsed.value;

    clearVulnerabilities();

    if(gameState.players[playerId].handCount === 1) {
        gameState.players[playerId].unoVulnerable = true; 
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

    checkWinCondition(playerId);
    if(gameState.status === 'PLAYING') {
        advanceTurn(skipNext ? 2 : 1);
    }
    
    broadcastState({ type: 'PLAY', playerId, card: cardPlayed });
}

function processDrawCard(playerId) {
    const expectedPlayerId = gameState.playerOrder[gameState.currentTurnIndex];
    if(playerId !== expectedPlayerId) return;
    
    clearVulnerabilities();
    const card = drawCardsFromDeck(1);
    gameState.players[playerId].handCount += 1;
    sendCards(playerId, card);
    
    advanceTurn(1);
    broadcastState({ type: 'DRAW', playerId, amount: 1 });
}

function applyPenaltyToNext(amount) {
    let nextIndex = (gameState.currentTurnIndex + gameState.direction + gameState.playerOrder.length) % gameState.playerOrder.length;
    let targetId = gameState.playerOrder[nextIndex];
    let cards = drawCardsFromDeck(amount);
    gameState.players[targetId].handCount += amount;
    sendCards(targetId, cards);
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

function checkWinCondition(playerId) {
    if(gameState.players[playerId].handCount === 0) {
        gameState.status = 'FINISHED';
        setTimeout(() => alert(gameState.players[playerId].pseudo + " a gagné la partie !"), 1000);
    }
}

function sendCards(targetId, cards) {
    if(targetId === myPeer.id) {
        handleStatePayload({ type: 'RECEIVE_CARDS', data: { cards } });
    } else {
        connections[targetId].send({ type: 'RECEIVE_CARDS', data: { cards } });
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
    document.getElementById('menu-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('my-pseudo').innerText = myPseudo;
    document.getElementById('my-avatar').src = `assets/avatars/${myAvatar}`;
}

function updateUI() {
    if(gameState.status !== 'PLAYING') return;

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

    const oppContainer = document.getElementById('opponents-container');
    oppContainer.innerHTML = '';
    
    const opponents = gameState.playerOrder.filter(id => id !== myId);
    const oppCount = opponents.length;

    opponents.forEach((id, index) => {
        const p = gameState.players[id];
        const isTurn = id === currentTurnId;
        
        // Calcul pour placer en arc de cercle
        const minAngle = 20;
        const maxAngle = 160;
        let angle = 90;
        if (oppCount > 1) {
            angle = maxAngle - ((maxAngle - minAngle) / (oppCount - 1)) * index;
        }
        const rad = angle * (Math.PI / 180);
        const leftPercent = 50 + 40 * Math.cos(rad);
        const topPercent = 35 - 30 * Math.sin(rad); // On les garde bien espacés du centre

        const oppDiv = document.createElement('div');
        oppDiv.className = `opponent ${isTurn ? 'active-turn' : ''}`;
        oppDiv.style.left = `${leftPercent}%`;
        oppDiv.style.top = `${topPercent}%`;

        // Génération des mini-cartes
        let cardsHTML = '';
        for(let i=0; i<p.handCount; i++) {
            cardsHTML += `<div class="mini-card"></div>`;
        }

        oppDiv.innerHTML = `
            <img id="avatar-${id}" src="assets/avatars/${p.avatar}" alt="${p.pseudo}">
            <div class="opponent-info">
                <span class="glow">${p.pseudo}</span>
                <div class="opponent-hand">${cardsHTML}</div>
                <button class="btn-uno" onclick="denounceUno('${id}')" ${!p.unoVulnerable ? 'disabled' : ''}>Dénoncer</button>
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
    
    if(myHand.length === 1 && amIProtectedUNO) {
        sendAction({ type: 'SAY_UNO' });
        amIProtectedUNO = false;
    }

    sendAction({ type: 'PLAY_CARD', data: { card: cardPlayed, chosenColor } });
    renderMyHand(); 
}

document.getElementById('draw-pile').addEventListener('click', () => {
    if(gameState.playerOrder[gameState.currentTurnIndex] === myPeer.id) {
        sendAction({ type: 'DRAW_CARD' });
    }
});

document.getElementById('btn-say-uno').addEventListener('click', () => {
    amIProtectedUNO = true;
    if(myHand.length === 1 || myHand.length === 2) {
        sendAction({ type: 'SAY_UNO' });
    }
});

function denounceUno(targetId) {
    sendAction({ type: 'DENOUNCE_UNO', data: { targetId } });
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