type WebWorkerEventType = 'socket_url' | 'login' | 'token' | 'forward' | 'destroy' | 'ui_hidden' | 'user_check';

interface WebWorkerData<T = any> {
    type: WebWorkerEventType;
    payload: T;
}

interface TrueCommandWorkerMessageEvent<T = any> extends MessageEvent {
    data: WebWorkerData<T>;
}

const _self: Worker = this as any;
const DEBUG = false;

const log = (...args: any[]) => {
    if (DEBUG) args.forEach(console.log);
};

const NAMESPACE_WHITELIST = ['users', 'sys', 'servers'];
const EVENT_WHITELIST = ['users/edit'];

/* Some worker-specific messages for the client */
const socketConnectionSuccessMessage = () => {
    return { namespace: 'worker', name: 'socket_connection_success' };
};

const socketConnectionClosedMessage = () => {
    return { namespace: 'worker', name: 'socket_connection_closed' };
};

const socketErrorMessage = err => {
    return { namespace: 'worker', name: 'socket_error', args: { error_message: err } };
};

const tokenExpirationMessage = () => {
    return { namespace: 'worker', name: 'token_expiration_error' };
};

const socketConnectionForbiddenMessage = () => {
    return { namespace: 'worker', name: 'socket_connection_forbidden' };
};
/******* end worker -> client messages **********/

/* The UI sends this value to our script shortly after initialization */
let connectionUrl: string;

/* The WebSocket connection to the TrueCommand MW */
let connection: WebSocket;

/* Place for the keepalive ping interval Id. Can be used to cancel a setInterval */
let pingIntervalId;

/* Is the UI visible? We shouldn't send messages to the client if it's in the background */
let isUiHidden = false;

/**
 * All incoming communication from the UI client flows through this listener.
 * Perform actions depending on the message type.
 */
onmessage = (msg: TrueCommandWorkerMessageEvent) => {
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

let messageQueue: TrueCommandWorkerMessageEvent[] = [];

/* Connect to middleware */
const initConnection = (url: string): void => {
    if (!connection) {
        log(`Initializing connection to url address ${url}`);
        try {
            connection = new WebSocket(connectionUrl);
        } catch (e) {
            log(`Could not create WebSocket object.`, e);
        }
    }
    initSocketListeners();
};

/**
 * Issue keepalive ping every 2 minutes. setInterval returns an
 * Id, which we store for later cancelling the interval in stopPings.
 */
const initPings = (): void => {
    log('Initializing MW pings.');
    sendMessageToMiddleware({ namespace: 'rpc', name: 'query' });
    pingIntervalId = setInterval(() => {
        log('Pinging MW...');
        sendMessageToMiddleware({ namespace: 'rpc', name: 'query' });
    }, 1000 * 30);
};

/* Create custom event handlers for our socket connection. */
const initSocketListeners = () => {
    if (!connection) throw new Error('Problem initializing socket listeners. No connection exists!');

    /**
     * 1.) Initialize keepalive pings when connection opens
     * 2.) Send a message to the client, signaling that the socket connection is live.
     */
    connection.onopen = () => {
        log('New socket connection opened.');
        initPings();
        _self.postMessage(socketConnectionSuccessMessage());
    };

    /**
     * 1.) Cancel the keepalive pings
     * 2.) If we have the TV address, try to reconnect
     */
    connection.onclose = event => {
        log('Socket connection closed.', { code: event.code, reason: event.reason, clean: event.wasClean });
        stopPings();
        _self.postMessage(socketConnectionClosedMessage());
        connection = undefined;
        /* Reattempt the socket connection in 10 seconds */
        if (connectionUrl !== null) setTimeout(() => initConnection(connectionUrl), 1000 * 10);
    };

    connection.onerror = err => {
        log('Connection error!', err);
        _self.postMessage(socketErrorMessage(err));
    };

    /* Forward messages from the MW -> client */
    connection.onmessage = msg => sendMessageToClient(msg);
};

/* Some cleanup when the UI signals to terminate the app/connection */
const initTermination = () => {
    /* Delete connection url and close websocket connection if it exists */
    connectionUrl = null;
    if (connection) connection.close(3001, 'The UI has been destroyed.');

    /* The WebWorker close() method can be used to self-terminate the process */
    close();
};

/* Post messages to the client */
const sendMessageToClient = (message: MessageEvent): void => {
    const msg = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;

    if (message.data.indexOf('current_stats') === -1) log({ source: 'WORKER -> UI', msg });

    if (msg.args && msg.args.code && msg.args.code === '403') {
        console.log('Received forbidden message...');
        return _self.postMessage(socketConnectionForbiddenMessage());
    }

    if (!isUiHidden || isMessageWhitelisted(message)) _self.postMessage(msg);
};

/* Forward messages to the middleware */
const sendMessageToMiddleware = (message): void => {
    log({ source: 'WORKER -> MW', msg: message });
    if (!connection) console.error('Problem sending message to middleware. No connection exists!');

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
        messageQueue.forEach(msg => connection.send(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        messageQueue = [];
    } catch (e) {
        console.error('Failed to send message to MW:', { message });
        console.error(e);
    }
};

/* Cancel keepalive pings and overwrite the stored interval Id */
const stopPings = (): void => {
    log('Stopping pings to MW.');
    if (pingIntervalId) clearInterval(pingIntervalId);
    pingIntervalId = undefined;
};

const isMessageWhitelisted = (message: MessageEvent): boolean => {
    const data = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
    return (
        NAMESPACE_WHITELIST.some(ns => data.namespace === ns) ||
        (data.namespace === 'event' && data.name !== 'data/current_stats')
    );
};
