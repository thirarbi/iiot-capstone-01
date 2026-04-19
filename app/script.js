var hostname = "172.20.10.2";
var port = 8883; 
var topic = "robot/nada";
var clientId = "Web_" + Math.floor(Math.random() * 1000); 

var mqttClient = new Paho.MQTT.Client(hostname, port, clientId);

mqttClient.connect({
    onSuccess: function() {
        console.log("Terhubung ke Broker via WebSocket!");
    }
});

function KirimNada(nada) {
    var message = new Paho.MQTT.Message(nada);
    message.destinationName = topic;
    mqttClient.send(message);
    console.log("Nada dikirim: " + nada);
}