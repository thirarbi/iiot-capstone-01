const http = require("http");
const fs = require("fs");
var url = require("url");
const host = 'localhost';
const port = 8080;

const requestListener = function(request, response){
  var pathname = url.parse(request.url).pathname;
  console.log("Request for " + pathname + " received.");
  
  if(pathname === "/"){
    response.writeHead(200);
    let html = fs.readFileSync("index.html", "utf8");
    response.write(html);
    response.end();
  } else if (pathname === "/script.js") {
    response.writeHead(200);
    let script = fs.readFileSync("script.js", "utf8");
    response.write(script);
    response.end();
  } else {
    response.writeHead(404);
    response.end();
  }
}

const server = http.createServer(requestListener);
server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`);
});