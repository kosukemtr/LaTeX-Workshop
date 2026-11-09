import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import sinon from 'sinon'

const { Event, EventTarget, MessageEvent, setTimeout, clearTimeout, setInterval, clearInterval } = globalThis

// Run the production browser module with controlled sockets and clocks. No VS Code
// window or real sleep is needed to reproduce network suspension deterministically.
const bundle = await build({
    entryPoints: ['viewer/components/connection.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'connection',
    plugins: [{
        name: 'viewer-dependencies',
        setup(buildApi) {
            buildApi.onResolve({ filter: /^\.\/(refresh|synctex|utils)\.js$/ }, args => ({ path: args.path, namespace: 'stub' }))
            buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
                export const refresh = async () => { __test.refreshes++ }
                export const forwardSynctex = data => { __test.synctex.push(data) }
                export const parseURL = () => ({ pdfFileUri: 'file:///main.pdf', docTitle: 'main.pdf' })
                export const isEmbedded = () => true
                export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
            ` }))
        }
    }]
})

function fixture(t) {
    const sockets = []
    const panelMessages = []
    const state = { refreshes: 0, synctex: [] }
    const windowEvents = new EventTarget()
    const documentEvents = new EventTarget()
    const document = Object.assign(documentEvents, { title: 'main.pdf', visibilityState: 'visible' })
    class Socket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        readyState = 0
        messages = []
        constructor() {
            super()
            sockets.push(this)
        }
        send(message) {
            assert.equal(this.readyState, 1)
            this.messages.push(JSON.parse(message))
        }
        open() {
            this.readyState = 1
            this.dispatchEvent(new Event('open'))
        }
        close() {
            this.readyState = 3
            this.dispatchEvent(new Event('close'))
        }
        error() {
            this.readyState = 3
            this.dispatchEvent(new Event('error'))
        }
        receive(data) {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
        }
    }
    const sandbox = {
        Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
        console: { log() {}, error() {} },
        WebSocket: Socket,
        document,
        window: Object.assign(windowEvents, {
            location: { protocol: 'http:', hostname: '127.0.0.1', port: '1234', pathname: '/viewer.html' },
            parent: { postMessage: msg => panelMessages.push(msg) }
        }),
        PDFViewerApplication: { initializedPromise: Promise.resolve(), pdfDocument: {} },
        __test: state
    }
    const clock = sinon.useFakeTimers({ global: sandbox })
    t.after(() => clock.uninstall())
    vm.runInNewContext(bundle.outputFiles[0].text, sandbox)
    sandbox.connection.initConnect()
    const tick = ms => clock.tickAsync(ms)
    return { sockets, state, panelMessages, document, windowEvents, clock, tick, connection: sandbox.connection }
}

test('registers the viewer on the initial connection without refreshing the initial PDF', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    assert.deepEqual(f.sockets[0].messages[0], { type: 'open', pdfFileUri: 'file:///main.pdf' })
    assert.equal(f.state.refreshes, 0)
})

test('reloads the latest PDF after reconnecting, including updates missed while asleep', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.sockets[0].close()
    await f.tick(3000)
    f.sockets.at(-1).open()
    await f.tick(0)
    assert.equal(f.state.refreshes, 1)
    assert.equal(f.document.title, 'main.pdf')
})

test('retries an initial connection failure instead of leaving the viewer disconnected', async t => {
    const f = fixture(t)
    f.sockets[0].error()
    await f.tick(3000)
    assert.equal(f.sockets.length, 2)
    f.sockets[1].open()
    await f.tick(0)
    assert.equal(f.state.refreshes, 1)
})

test('bounds a stalled WebSocket handshake and retries', async t => {
    const f = fixture(t)
    await f.tick(13000)
    assert.equal(f.sockets[0].readyState, 3)
    assert.equal(f.sockets.length, 2)
})

test('a late open event cannot revive a timed-out handshake', async t => {
    const f = fixture(t)
    await f.tick(10000)
    f.sockets[0].open()
    assert.equal(f.sockets[0].readyState, 3)
    assert.equal(f.sockets[0].messages.length, 0)
    await f.tick(3000)
    f.sockets[1].open()
    await f.tick(0)
    assert.equal(f.state.refreshes, 1)
})

test('wake events during a pending handshake do not create another socket', async t => {
    const f = fixture(t)
    f.windowEvents.dispatchEvent(new Event('focus'))
    f.windowEvents.dispatchEvent(new Event('online'))
    await f.tick(3000)
    assert.equal(f.sockets.length, 1)
    f.sockets[0].open()
    await f.tick(0)
    assert.equal(f.state.refreshes, 0)
})

test('detects a half-open socket after focus returns and reconnects', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.windowEvents.dispatchEvent(new Event('focus'))
    await f.tick(13000)
    assert.equal(f.sockets.length, 2)
    assert.equal(f.sockets[0].readyState, 3)
})

test('a heartbeat response keeps a healthy connection open without reloading', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.windowEvents.dispatchEvent(new Event('focus'))
    assert.equal(f.sockets[0].messages.at(-1).type, 'ping')
    f.sockets[0].receive({ type: 'pong' })
    await f.tick(13000)
    assert.equal(f.sockets.length, 1)
    assert.equal(f.state.refreshes, 0)
})

test('probes the connection when a hidden viewer becomes visible or the network returns', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.document.visibilityState = 'visible'
    f.document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(f.sockets[0].messages.at(-1).type, 'ping')
    f.sockets[0].receive({ type: 'pong' })
    f.windowEvents.dispatchEvent(new Event('online'))
    assert.equal(f.sockets[0].messages.filter(msg => msg.type === 'ping').length, 2)
})

test('repeated wake events do not create parallel reconnect loops', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.sockets[0].close()
    for (let i = 0; i < 5; i++) {
        f.windowEvents.dispatchEvent(new Event('focus'))
        f.windowEvents.dispatchEvent(new Event('online'))
    }
    await f.tick(3000)
    assert.equal(f.sockets.length, 2)
    assert.equal(f.document.title, '[Disconnected] main.pdf')
})

test('a successful reconnect does not accumulate heartbeat intervals', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.sockets[0].close()
    await f.tick(3000)
    f.sockets[1].open()
    await f.tick(0)
    // The only recurring timer is the heartbeat, shared across reconnects.
    assert.equal(f.clock.countTimers(), 1)
})

test('ignores close and message events from a retired socket', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.sockets[0].close()
    await f.tick(3000)
    f.sockets[1].open()
    await f.tick(0)
    f.sockets[0].receive({ type: 'refresh', pdfFileUri: 'file:///main.pdf' })
    f.sockets[0].close()
    await f.tick(3000)
    assert.equal(f.sockets.length, 2)
    assert.equal(f.state.refreshes, 1)
})

test('continues to deliver refresh and SyncTeX messages after recovery', async t => {
    const f = fixture(t)
    f.sockets[0].open()
    await f.tick(0)
    f.sockets[0].close()
    await f.tick(3000)
    f.sockets[1].open()
    await f.tick(0)
    f.sockets[1].receive({ type: 'refresh', pdfFileUri: 'file:///main.pdf' })
    f.sockets[1].receive({ type: 'synctex', data: { page: 2 } })
    await f.tick(0)
    assert.equal(f.state.refreshes, 2)
    assert.equal(f.state.synctex.length, 1)
    assert.equal(f.state.synctex[0].page, 2)
})

test('notifies the hosting panel after bounded retries fail', async t => {
    const f = fixture(t)
    f.sockets[0].error()
    // Each attempt is allowed 10s to connect; all retry delays total < 100s.
    await f.tick(210000)
    assert.ok(f.panelMessages.some(msg => msg.type === 'disconnected'))
})
