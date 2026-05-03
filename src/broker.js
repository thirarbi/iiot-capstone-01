const { Aedes } = require('aedes')
const net = require('net')
const http = require('http')
const ws = require('websocket-stream')

const broker_port = 1883
const websocket_port = 8883

async function startBroker () {
  const aedes = new Aedes()

  // aedes v1: must call listen() to initialise persistence and set closed=false
  // Without this, every MQTT CONNECT is silently dropped (no CONNACK sent)
  await aedes.listen()

  const tcpServer = net.createServer(aedes.handle)
  const httpServer = http.createServer()

  ws.createServer({ server: httpServer }, aedes.handle)

  httpServer.listen(websocket_port, () => {
    console.log('Aedes MQTT-WS listening on port: ' + websocket_port)
  })

  tcpServer.listen(broker_port, () => {
    console.log('MQTT broker started and listening on port ' + broker_port)
  })
}

startBroker().catch(err => {
  console.error('Broker failed to start:', err.message)
  process.exit(1)
})