import net from 'net';
import http from 'http';
import https from 'https';

const server = http.createServer((req,res)=>{console.log('server got', req.url);res.writeHead(302,{location:'http://127.0.0.1:8080/landed'});res.end();});
await new Promise<void>((r)=>server.listen(8080,'127.0.0.1',r));

const url = new URL('http://127.0.0.1:8080/redirect');
const socket = net.connect({ host: '127.0.0.1', port: Number(url.port) || 80, keepAlive: false });
socket.setTimeout(8000);
socket.once('error', (e:any) => console.log('sockerr', e.code, e.message));
socket.once('connect', () => {
  console.log('socket connected');
  const request = http.request({
    agent: false,
    createConnection: () => socket,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    port: undefined,
    headers: { host: '127.0.0.1', accept: '*/*' },
    timeout: 8000,
  }, (response) => {
    console.log('got status', response.statusCode, 'location', response.headers.location);
    response.resume();
    response.on('end', () => server.close());
  });
  request.on('error', (e:any) => { console.log('reqerr', e.code, e.message, JSON.stringify(e.errors)); socket.destroy(); server.close(); });
  request.end();
});
