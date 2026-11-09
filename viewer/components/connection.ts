import type { ClientRequest, PanelRequest, ServerResponse } from '../../types/latex-workshop-protocol-types/index'
import { refresh } from './refresh.js'
import { forwardSynctex } from './synctex.js'
import * as utils from './utils.js'
import type { PDFViewerApplicationType } from './interface.js'

declare const PDFViewerApplication: PDFViewerApplicationType

const CONNECTION_TIMEOUT = 10000
const HEARTBEAT_INTERVAL = 30000

let server: string
let websocket: Promise<WebSocket>
let socket: WebSocket | undefined
let reconnecting = false
let initialized = false
let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined

export function initConnect() {
    if (initialized) {
        return
    }
    initialized = true
    const scheme = 'https:' === window.location.protocol ? 'wss' : 'ws'
    const path = window.location.pathname.substring(0, window.location.pathname.indexOf('viewer.html'))
    server = `${scheme}://${window.location.hostname}:${window.location.port}${path}`
    void connect().catch(() => reconnect())

    // Install these once, rather than adding another interval on every retry.
    setInterval(checkConnection, HEARTBEAT_INTERVAL)
    window.addEventListener('focus', checkConnection)
    window.addEventListener('online', checkConnection)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkConnection()
        }
    })
}

function connect(): Promise<WebSocket> {
    websocket = new Promise((resolve, reject) => {
        const ws = new WebSocket(server)
        socket = ws
        let opened = false
        let failed = false
        const fail = () => {
            failed = true
            clearTimeout(timeout)
            reject(new Error(`Failed to connect to ${server}`))
            ws.close()
        }
        // A suspended network may leave a handshake pending without an error.
        const timeout = setTimeout(fail, CONNECTION_TIMEOUT)
        ws.addEventListener('open', () => {
            if (failed || ws !== socket) {
                ws.close()
                return
            }
            opened = true
            clearTimeout(timeout)
            const openPack: ClientRequest = {
                type: 'open',
                pdfFileUri: utils.parseURL().pdfFileUri
            }
            ws.send(JSON.stringify(openPack))
            resolve(ws)
        })
        ws.addEventListener('message', event => {
            if (ws === socket) {
                handler(event as MessageEvent<string>)
            }
        })
        ws.addEventListener('error', () => {
            if (!opened) {
                fail()
            } else if (ws === socket) {
                void reconnect()
            }
        })
        ws.addEventListener('close', () => {
            clearTimeout(timeout)
            if (!opened) {
                failed = true
                reject(new Error(`Connection to ${server} closed before opening.`))
            } else if (ws === socket) {
                void reconnect()
            }
        })
    })
    return websocket
}

export async function send(message: ClientRequest) {
    try {
        const ws = await websocket
        if (ws === socket && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message))
        }
    } catch (e) {
        console.error('Cannot send to LaTeX Workshop:', e)
    }
}

function checkConnection() {
    if (reconnecting || socket?.readyState === WebSocket.CONNECTING || heartbeatTimeout !== undefined) {
        return
    }
    if (socket?.readyState !== WebSocket.OPEN) {
        void reconnect()
        return
    }
    // readyState can still be OPEN after sleep although the connection is dead.
    // Require a reply, instead of relying only on the browser's close event.
    heartbeatTimeout = setTimeout(() => {
        heartbeatTimeout = undefined
        void reconnect()
    }, CONNECTION_TIMEOUT)
    try {
        socket.send(JSON.stringify({ type: 'ping' } satisfies ClientRequest))
    } catch (_) {
        void reconnect()
    }
}

export function sendLog(message: string) {
    void send({ type: 'add_log', message })
}

export function sendPanel(msg: PanelRequest) {
    if (!utils.isEmbedded()) {
        return
    }
    window.parent?.postMessage(msg, '*')
}

function handler(event: MessageEvent<string>) {
    const data = JSON.parse(event.data) as ServerResponse
    switch (data.type) {
        case 'pong': {
            clearTimeout(heartbeatTimeout)
            heartbeatTimeout = undefined
            break
        }
        case 'synctex': {
            forwardSynctex(data.data)
            break
        }
        case 'refresh': {
            void refresh()
            break
        }
        case 'reload': {
            location.reload()
            break
        }
        default: {
            break
        }
    }
}

async function reconnect() {
    if (reconnecting) {
        return
    }
    reconnecting = true
    clearTimeout(heartbeatTimeout)
    heartbeatTimeout = undefined
    socket?.close()
    const originalTitle = utils.parseURL().docTitle
    document.title = `[Disconnected] ${originalTitle}`
    console.log('Closed: WebSocket to LaTeX Workshop.')

    // Since WebSockets are disconnected when PC resumes from sleep,
    // we have to reconnect. https://github.com/James-Yu/LaTeX-Workshop/pull/1812
    await utils.sleep(3000)

    let tries = 1
    while (tries <= 10) {
        console.log(`Try to reconnect to LaTeX Workshop: (${tries}/10).`)
        try {
            const ws = await connect()
            if (ws.readyState !== WebSocket.OPEN) {
                throw new Error(`Connection to ${server} is not open.`)
            }
            document.title = originalTitle
            console.log('Reconnected: WebSocket to LaTeX Workshop.')
            reconnecting = false
            // Builds may have finished while disconnected; their refresh packets
            // are lost. Catch up without closing the tab or losing its position.
            void PDFViewerApplication.initializedPromise.then(() => {
                if (PDFViewerApplication.pdfDocument) {
                    return refresh()
                }
                return undefined
            }).catch(e => console.error('Refreshing after reconnect failed:', e))
            return
        } catch (e) {
            console.error(e)
        }

        await utils.sleep(1000 * (tries + 2))
        tries++
    }
    console.error('Cannot reconnect to LaTeX Workshop.')
    reconnecting = false
    // Let the hosting webview panel reload the viewer with a freshly resolved server URL.
    sendPanel({ type: 'disconnected' })
}
