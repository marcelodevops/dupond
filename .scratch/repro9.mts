import http from 'http';
import net from 'net';
const lands: string[] = [];
const server = http.createServer((req,res)=>{
  if (req.url === '/redirect') { res.writeHead(302,{location:'http://127.0.0.1:8080/landed'}); res.end(); return; }
  lands.push(req.url || ''); res.writeHead(200); res.end('SECRET');
});
await new Promise<void>((r)=>server.listen(8080,'127.0.0.1',r));

const pinned = '127.0.0.1', port = 8080;
const socket = net.connect({ host: pinned, port });
await new Promise<void>((res, rej) => { socket.once('connect', () => res()); socket.once('error', (e)=>rej(e)); });
const out = await new Promise<string>((resolve) => {
  const request = http.request({
    agent: false, host: pinned, port,
    createConnection: () => socket,
    method: 'GET', path: '/redirect',
    headers: { host: pinned, accept: '*/*' },
    timeout: 8000,
  }, (response) => {
    let s=''; response.setEncoding('utf8'); response.on('data',(c)=>(s+=c));
    response.on('end',()=>resolve(`status=${response.statusCode} body=${JSON.stringify(s)}`));
  });
  request.on('error', (e:any) => resolve(`ERR ${e.code}`));
  request.end();
});
console.log(out, 'lands=', lands);
socket.destroy(); server.close();
