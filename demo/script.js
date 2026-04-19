var hostname = "localhost";
var port = 8883;
var clientId = "WebSocket" + new Date().getUTCMilliseconds();
var topic = "topik";

var mqttClient = new Paho.MQTT.Client(hostname, port, clientId);
mqttClient.onMessageArrived = MessageArrived;
mqttClient.onConnectionLost = ConnectionLost;
Connect();

function Connect(){
  mqttClient.connect({
    onSuccess: Connected,
    onFailure: ConnectionFailed,
    keepAliveInterval: 10,
  });
}

function Connected() {
  console.log("Connected to MQTT-over-WebSocket broker.");
  mqttClient.subscribe(topic);
}

function ConnectionFailed(res) {
  console.log("Connect failed:" + res.errorMessage);
}

function ConnectionLost(res) {
  if (res.errorCode !== 0) {
    console.log("Connection lost:" + res.errorMessage);
    Connect();
  }
}

function MessageArrived(message) {
  console.log(message.destinationName + ": " + message.payloadString);
  var a = parseInt(message.payloadString);
  var ht = 100 - a;
  
  // Modifikasi sedikit agar grafiknya tidak error kalau angkanya di atas 100
  if(ht < 0) ht = 0; 

  document.getElementById("top").style.height = "" + ht + "%";
  document.getElementById("top").innerHTML = message.payloadString + "%";
  document.getElementById("container").style.backgroundColor = "#74add6";
}