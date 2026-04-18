const aedes = require('aedes')()
const broker = require('net').createServer(aedes.handle)
const broker_port = 1883

const websocket_port = 8883
const httpServer = require('http').createServer()
const { WebSocketServer, createWebSocketStream } = require('ws')

const wss = new WebSocketServer({ server: httpServer })
wss.on('connection', function (ws) {
  const stream = createWebSocketStream(ws)
  aedes.handle(stream)
})

httpServer.listen(websocket_port, function () {
  console.log('Aedes MQTT-WS listening on port: ' + websocket_port)
})

broker.listen(broker_port, function () {
  console.log('MQTT broker started and listening on port ' + broker_port)
})