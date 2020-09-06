var _self = this;
var DEBUG = false;
var log = function () {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    if (DEBUG)
        args.forEach(console.log);
};
var NAMESPACE_WHITELIST = ['users', 'sys', 'servers'];
var EVENT_WHITELIST = ['users/edit'];
/* Some worker-specific messages for the client */
var socketConnectionSuccessMessage = function () {
    return { namespace: 'worker', name: 'socket_connection_success' };
};
var socketConnectionClosedMessage = function () {
    return { namespace: 'worker', name: 'socket_connection_closed' };
};
var socketErrorMessage = function (err) {
    return { namespace: 'worker', name: 'socket_error', args: { error_message: err } };
};
var tokenExpirationMessage = function () {
    return { namespace: 'worker', name: 'token_expiration_error' };
};
var socketConnectionForbiddenMessage = function () {
    return { namespace: 'worker', name: 'socket_connection_forbidden' };
};
/******* end worker -> client messages **********/
/* The UI sends this value to our script shortly after initialization */
var connectionUrl;
/* The WebSocket connection to the TrueCommand MW */
var connection;
/* Place for the keepalive ping interval Id. Can be used to cancel a setInterval */
var pingIntervalId;
/* Is the UI visible? We shouldn't send messages to the client if it's in the background */
var isUiHidden = false;
/**
 * All incoming communication from the UI client flows through this listener.
 * Perform actions depending on the message type.
 */
onmessage = function (msg) {
    log({ source: 'UI -> WORKER', msg: msg.data.payload });
    switch (msg.data.type) {
        /* The UI is sending the TV address */
        case 'socket_url': {
            connectionUrl = msg.data.payload;
            break;
        }
        /* The UI wants to login with a username/pass or token */
        case 'user_check':
        case 'token':
        case 'login':
            initConnection(connectionUrl);
        /* The UI wants to send a message to MW */
        case 'forward': {
            sendMessageToMiddleware(msg.data.payload);
            break;
        }
        case 'destroy': {
            log('UI initiated a connection termination.', msg);
            initTermination();
            break;
        }
        case 'ui_hidden': {
            isUiHidden = msg.data.payload;
            break;
        }
    }
};
var messageQueue = [];
/* Connect to middleware */
var initConnection = function (url) {
    if (!connection) {
        log("Initializing connection to url address " + url);
        try {
            connection = new WebSocket(connectionUrl);
        }
        catch (e) {
            log("Could not create WebSocket object.", e);
        }
    }
    initSocketListeners();
};
/**
 * Issue keepalive ping every 2 minutes. setInterval returns an
 * Id, which we store for later cancelling the interval in stopPings.
 */
var initPings = function () {
    log('Initializing MW pings.');
    sendMessageToMiddleware({ namespace: 'rpc', name: 'query' });
    pingIntervalId = setInterval(function () {
        log('Pinging MW...');
        sendMessageToMiddleware({ namespace: 'rpc', name: 'query' });
    }, 1000 * 30);
};
/* Create custom event handlers for our socket connection. */
var initSocketListeners = function () {
    if (!connection)
        throw new Error('Problem initializing socket listeners. No connection exists!');
    /**
     * 1.) Initialize keepalive pings when connection opens
     * 2.) Send a message to the client, signaling that the socket connection is live.
     */
    connection.onopen = function () {
        log('New socket connection opened.');
        initPings();
        _self.postMessage(socketConnectionSuccessMessage());
    };
    /**
     * 1.) Cancel the keepalive pings
     * 2.) If we have the TV address, try to reconnect
     */
    connection.onclose = function (event) {
        log('Socket connection closed.', { code: event.code, reason: event.reason, clean: event.wasClean });
        stopPings();
        _self.postMessage(socketConnectionClosedMessage());
        connection = undefined;
        /* Reattempt the socket connection in 10 seconds */
        if (connectionUrl !== null)
            setTimeout(function () { return initConnection(connectionUrl); }, 1000 * 10);
    };
    connection.onerror = function (err) {
        log('Connection error!', err);
        _self.postMessage(socketErrorMessage(err));
    };
    /* Forward messages from the MW -> client */
    connection.onmessage = function (msg) { return sendMessageToClient(msg); };
};
/* Some cleanup when the UI signals to terminate the app/connection */
var initTermination = function () {
    /* Delete connection url and close websocket connection if it exists */
    connectionUrl = null;
    if (connection)
        connection.close(3001, 'The UI has been destroyed.');
    /* The WebWorker close() method can be used to self-terminate the process */
    close();
};
/* Post messages to the client */
var sendMessageToClient = function (message) {
    var msg = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
    if (message.data.indexOf('current_stats') === -1)
        log({ source: 'WORKER -> UI', msg: msg });
    if (msg.args && msg.args.code && msg.args.code === '403') {
        console.log('Received forbidden message...');
        return _self.postMessage(socketConnectionForbiddenMessage());
    }
    if (!isUiHidden || isMessageWhitelisted(message))
        _self.postMessage(msg);
};
/* Forward messages to the middleware */
var sendMessageToMiddleware = function (message) {
    log({ source: 'WORKER -> MW', msg: message });
    if (!connection)
        console.error('Problem sending message to middleware. No connection exists!');
    /* The user is trying to login but there's no middleware connection (probably rebooting) */
    if ((!connection || connection.readyState === 3) && message.id === '1') {
        _self.postMessage(socketErrorMessage('Tried to login but no connection exists.'));
        return;
    }
    /**
     * The UI is sending messages, but the socket connection is still opening.
     * Add messages to a queue.
     */
    if (connection && connection.readyState === 0) {
        messageQueue.push(message);
        return;
    }
    /**
     * The socket connection is good to go. Add this message to the end of the queue,
     * then flush the queue.
     */
    try {
        messageQueue.push(message);
        messageQueue.forEach(function (msg) { return connection.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); });
        messageQueue = [];
    }
    catch (e) {
        console.error('Failed to send message to MW:', { message: message });
        console.error(e);
    }
};
/* Cancel keepalive pings and overwrite the stored interval Id */
var stopPings = function () {
    log('Stopping pings to MW.');
    if (pingIntervalId)
        clearInterval(pingIntervalId);
    pingIntervalId = undefined;
};
var isMessageWhitelisted = function (message) {
    var data = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
    return (NAMESPACE_WHITELIST.some(function (ns) { return data.namespace === ns; }) ||
        (data.namespace === 'event' && data.name !== 'data/current_stats'));
};
