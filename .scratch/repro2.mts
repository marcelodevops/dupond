import net from 'net';
import http from 'http';
const u = new URL('http://127.0.0.1:8080/redirect');
console.log('port=', JSON.stringify(u.port), 'host=', u.hostname);
const server = http.createServer((req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:8080/landed'});res.end();});
await new Promise<void>((r)=>server.listen(8080,'127.0.0.1',r));
const socket = net.connect({ host: '127.0.0.1', port: Number(u.port) || 80, keepAlive: false });
socket.on('connect', () => { console.log('connected'); socket.destroy(); server.close(); });
socket.on('error', (e:any) => { console.log('sockerr', e.code, e.message, JSON.stringify(e.errors)); server.close(); });
