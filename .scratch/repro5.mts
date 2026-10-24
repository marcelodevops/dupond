import net from 'net';
import http from 'http';

const server = http.createServer((_req,res)=>{res.writeHead(200);res.end('ok');});
await new Promise<void>((r)=>server.listen(8080,'127.0.0.1',r));

async function attempt(label: string, opts: any) {
  const socket = net.connect({ host: '127.0.0.1', port: 8080 });
  await new Promise<void>((res, rej) => { socket.once('connect', () => res()); socket.once('error', rej); });
  const body = await new Promise<string>((resolve) => {
    const request = http.request({ path: '/', headers: { host: '127.0.0.1' }, createConnection: () => socket, ...opts },
      (response) => { let s = ''; response.setEncoding('utf8'); response.on('data', (c) => (s += c)); response.on('end', () => resolve(s)); });
    request.on('error', (e: any) => { socket.destroy(); resolve(`ERR ${e.code}`); });
    request.end();
  });
  console.log(label, '=>', body);
}
await attempt('baseline', {});
await attempt('agent:false', { agent: false });
await attempt('port:undefined', { port: undefined });
await attempt('timeout:8000', { timeout: 8000 });
await attempt('method:GET', { method: 'GET' });
await attempt('agent:false+port:undefined', { agent: false, port: undefined });
server.close();
