const { Aedes } = require('aedes')
const aedes = new Aedes()
const broker = require('net').createServer(aedes.handle.bind(aedes))
const broker_port = 1883

const websocket_port = 8883
const httpServer = require('http').createServer()
const ws = require('websocket-stream')

ws.createServer({ server: httpServer }, aedes.handle)

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE')
    console.error(`❌ Port ${websocket_port} already in use. Kill the old process first, then retry.`)
  else
    console.error('❌ WS server error:', err.message)
})

broker.on('error', (err) => {
  if (err.code === 'EADDRINUSE')
    console.error(`❌ Port ${broker_port} already in use. Kill the old process first, then retry.`)
  else
    console.error('❌ MQTT broker error:', err.message)
})

httpServer.listen(websocket_port, function () {
  console.log('✅ Aedes MQTT-WS listening on port: ' + websocket_port)
})

broker.listen(broker_port, function () {
  console.log('✅ MQTT broker started and listening on port ' + broker_port)
})