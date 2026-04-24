// --- VARIABLES GLOBALES ---
const ASSETS_PATH = 'assets/cards/';
const LOBBY_PREFIX = 'akhirox-uno-lobby-';

let myPseudo = '';
let myAvatar = '';
let myPeer = null;
let isHost = false;

// Variables Hôte
let connections = {}; // id -> connection
let clients = []; // Liste des IDs des clients connectés

// Variables Client
let hostConnection = null;
let myHand = [];
let amIProtectedUNO = false;

// État Global du jeu (Géré par l'Hôte et synchronisé)
let gameState = {
    status: 'LOBBY', // LOBBY, PLAYING, FINISHED
    deck: [],
    discardPile: [],
    players: {}, // id: { pseudo, avatar, handCount, unoVulnerable: false }
    playerOrder: [], // Tableau des IDs pour l'ordre
    currentTurnIndex: 0,
    direction: 1, // 1 ou -1
    currentColor: '',
    currentValue: ''
};

// --- UTILITAIRES CARTES ---
function parseCard(filename) {
    if(filename.includes('wild_plus4')) return { color: 'none', value: 'plus4', type: 'wild' };
    if(filename.includes('wild_card')) return { color: 'none', value: 'wild', type: 'wild' };
    
    let parts = filename.split('.')[0].split('_'); // ex: 7_red ou skip_blue
    return { color: parts[1], value: parts[0], type: 'normal' };
}

function isCardPlayable(cardFile, currentState) {
    const card = parseCard(cardFile);
    if(card.type === 'wild') return true; // Jouable n'importe quand
    return card.color === currentState.currentColor || card.value === currentState.currentValue;
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
                hostConnection.on('data', handleDataFromHost);
            });
        } else {
            statusText.innerText = "Erreur : " + err.type;
        }
    });

    myPeer.on('connection', (conn) => {
        if (!isHost) return;
        connections[conn.peer] = conn;
        clients.push(conn.peer);
        
        conn.on('data', (data) => handleDataFromClient(conn.peer, data));
        conn.on('close', () => { /* Gérer la déconnexion si besoin */ });
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
    
    // Distribution de 7 cartes
    gameState.playerOrder.forEach(id => {
        const hand = gameState.deck.splice(-7);
        gameState.players[id].handCount = 7;
        sendCards(id, hand);
    });

    // Carte initiale
    let firstCard;
    do {
        firstCard = gameState.deck.pop();
    } while(firstCard.includes('wild_plus4')); // On repose le +4 si c'est la première [cite: 41]
    
    gameState.discardPile.push(firstCard);
    const parsedFirst = parseCard(firstCard);
    gameState.currentColor = parsedFirst.color === 'none' ? 'red' : parsedFirst.color; // Si Joker, Rouge par defaut au start
    gameState.currentValue = parsedFirst.value;

    broadcastState();
    showGameScreen();
}

function handleDataFromClient(clientId, payload) {
    if (payload.type === 'JOIN') {
        addPlayerToState(clientId, payload.data.pseudo, payload.data.avatar);
    }
    if(gameState.status !== 'PLAYING') return;

    if (payload.type === 'PLAY_CARD') {
        processPlayCard(clientId, payload.data.card, payload.data.chosenColor);
    }
    if (payload.type === 'DRAW_CARD') {
        processDrawCard(clientId);
    }
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
            broadcastState();
        }
    }
}

function processPlayCard(playerId, cardPlayed, chosenColor) {
    const expectedPlayerId = gameState.playerOrder[gameState.currentTurnIndex];
    if(playerId !== expectedPlayerId) return; // Pas son tour

    if(!isCardPlayable(cardPlayed, gameState)) return; // Triche/Erreur

    gameState.discardPile.push(cardPlayed);
    gameState.players[playerId].handCount--;
    
    const parsed = parseCard(cardPlayed);
    gameState.currentColor = parsed.color === 'none' ? chosenColor : parsed.color;
    gameState.currentValue = parsed.value;

    // Levée de vulnérabilité UNO de l'ancien tour
    clearVulnerabilities();

    // Règle UNO: si le joueur passe à 1 carte, il est vulnérable sauf s'il a cliqué
    if(gameState.players[playerId].handCount === 1) {
        gameState.players[playerId].unoVulnerable = true; 
        // Le client enverra SAY_UNO s'il a cliqué.
    }

    // Effets Spéciaux
    let skipNext = false;
    if(parsed.value === 'reverse') {
        gameState.direction *= -1;
        if(gameState.playerOrder.length === 2) skipNext = true; // Reverse = Skip à 2 joueurs
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
}

function processDrawCard(playerId) {
    const expectedPlayerId = gameState.playerOrder[gameState.currentTurnIndex];
    if(playerId !== expectedPlayerId) return;
    
    clearVulnerabilities();
    const card = drawCardsFromDeck(1);
    gameState.players[playerId].handCount += 1;
    sendCards(playerId, card);
    
    advanceTurn(1);
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
        // Remélanger la défausse (sauf la première)
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
    broadcastState();
}

function clearVulnerabilities() {
    Object.keys(gameState.players).forEach(p => gameState.players[p].unoVulnerable = false);
}

function checkWinCondition(playerId) {
    if(gameState.players[playerId].handCount === 0) {
        gameState.status = 'FINISHED';
        broadcastState();
        alert(gameState.players[playerId].pseudo + " a gagné la partie !");
    }
}

function sendCards(targetId, cards) {
    if(targetId === myPeer.id) {
        myHand.push(...cards);
        renderMyHand();
    } else {
        connections[targetId].send({ type: 'RECEIVE_CARDS', data: { cards } });
    }
}

function broadcastState() {
    clients.forEach(id => {
        connections[id].send({ type: 'STATE_UPDATE', data: { state: gameState } });
    });
    updateUI();
}

// --- LOGIQUE CLIENT & UI ---
function handleDataFromHost(payload) {
    if (payload.type === 'STATE_UPDATE') {
        gameState = payload.data.state;
        updateUI();
    }
    if (payload.type === 'RECEIVE_CARDS') {
        myHand.push(...payload.data.cards);
        renderMyHand();
    }
}

function showGameScreen() {
    document.getElementById('menu-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('my-pseudo').innerText = myPseudo;
    document.getElementById('my-avatar').src = `assets/avatars/${myAvatar}`;
}

function updateUI() {
    if(gameState.status !== 'PLAYING') return;

    // Défausse
    if(gameState.discardPile.length > 0) {
        const topCard = gameState.discardPile[gameState.discardPile.length - 1];
        document.getElementById('discard-pile').innerHTML = `<div class="card" style="background-image: url('${ASSETS_PATH}${topCard}')"></div>`;
    }
    
    // Indicateur de couleur active
    const colorInd = document.getElementById('current-color-indicator');
    if(gameState.currentColor) {
        colorInd.style.display = 'block';
        const colorMap = { 'red':'#c1272d', 'blue':'#005a9e', 'green':'#2b7a0b', 'yellow':'#f7b731' };
        colorInd.style.backgroundColor = colorMap[gameState.currentColor];
    }

    const currentTurnId = gameState.playerOrder[gameState.currentTurnIndex];
    const myId = isHost ? myPeer.id : myPeer.id; // Pour le client, myPeer.id est son ID
    const isMyTurn = currentTurnId === myId;

    // Indicateur de tour global
    const turnText = isMyTurn ? "C'est ton tour !" : `Tour de ${gameState.players[currentTurnId].pseudo}`;
    document.getElementById('turn-indicator').innerText = turnText;

    // Moi
    const myInfoBlock = document.getElementById('my-player-info');
    isMyTurn ? myInfoBlock.classList.add('active-turn') : myInfoBlock.classList.remove('active-turn');

    // Adversaires
    const oppContainer = document.getElementById('opponents-container');
    oppContainer.innerHTML = '';
    
    gameState.playerOrder.forEach(id => {
        if (id !== myId) {
            const p = gameState.players[id];
            const isTurn = id === currentTurnId;
            const oppDiv = document.createElement('div');
            oppDiv.className = `opponent ${isTurn ? 'active-turn' : ''}`;
            oppDiv.innerHTML = `
                <img src="assets/avatars/${p.avatar}" alt="${p.pseudo}">
                <div class="opponent-info">
                    <span>${p.pseudo} - ${p.handCount} cartes</span>
                    <button class="btn-uno" onclick="denounceUno('${id}')" ${!p.unoVulnerable ? 'disabled' : ''}>Dénoncer</button>
                </div>
            `;
            oppContainer.appendChild(oppDiv);
        }
    });

    renderMyHand();
}

function renderMyHand() {
    const handDiv = document.getElementById('my-hand');
    handDiv.innerHTML = '';
    
    const currentTurnId = gameState.playerOrder[gameState.currentTurnIndex];
    const isMyTurn = currentTurnId === (isHost ? myPeer.id : myPeer.id);

    myHand.forEach((card, index) => {
        const cardEl = document.createElement('div');
        const playable = isMyTurn && isCardPlayable(card, gameState);
        
        cardEl.className = `card ${playable ? '' : 'unplayable'}`;
        cardEl.style.backgroundImage = `url('${ASSETS_PATH}${card}')`;
        
        cardEl.onclick = () => {
            if(playable) attemptPlayCard(index);
        };
        handDiv.appendChild(cardEl);
    });
}

// --- ACTIONS DU JOUEUR ---
let pendingCardPlayIndex = -1;

function attemptPlayCard(index) {
    const card = myHand[index];
    const parsed = parseCard(card);
    
    if(parsed.type === 'wild') {
        pendingCardPlayIndex = index;
        document.getElementById('color-picker-modal').style.display = 'flex';
    } else {
        finalizePlayCard(index, parsed.color);
    }
}

// Géré par la modale
document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const color = btn.getAttribute('data-color');
        document.getElementById('color-picker-modal').style.display = 'none';
        finalizePlayCard(pendingCardPlayIndex, color);
    });
});

function finalizePlayCard(index, chosenColor) {
    const cardPlayed = myHand[index];
    myHand.splice(index, 1); // Retire localement
    
    // Si on a 1 carte restante après ça et qu'on a protégé son UNO
    if(myHand.length === 1 && amIProtectedUNO) {
        sendAction({ type: 'SAY_UNO' });
        amIProtectedUNO = false;
    }

    sendAction({ type: 'PLAY_CARD', data: { card: cardPlayed, chosenColor } });
    renderMyHand();
}

document.getElementById('draw-pile').addEventListener('click', () => {
    const isMyTurn = gameState.playerOrder[gameState.currentTurnIndex] === (isHost ? myPeer.id : myPeer.id);
    if(isMyTurn) {
        sendAction({ type: 'DRAW_CARD' });
    }
});

document.getElementById('btn-say-uno').addEventListener('click', () => {
    // Si on a 2 cartes et qu'on s'apprête à jouer, ou qu'on a déjà 1 carte
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