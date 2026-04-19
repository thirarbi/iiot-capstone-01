const aedes = require('aedes')()
const broker = require('net').createServer(aedes.handle)
const broker_port = 1883

const websocket_port = 8883
const httpServer = require('http').createServer()
const ws = require('websocket-stream')

ws.createServer({ server: httpServer }, aedes.handle)

httpServer.listen(websocket_port, function () {
  console.log('Aedes MQTT-WS listening on port: ' + websocket_port)
})

broker.listen(broker_port, function () {
  console.log('MQTT broker started and listening on port ' + broker_port)
})