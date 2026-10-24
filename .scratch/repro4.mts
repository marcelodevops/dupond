import net from 'net';
import http from 'http';

const server = http.createServer((req,res)=>{console.log('server got', req.url);res.writeHead(302,{location:'http://127.0.0.1:8080/landed'});res.end();});
await new Promise<void>((r)=>server.listen(8080,'127.0.0.1',r));

const socket = net.connect({ host: '127.0.0.1', port: 8080 });
socket.once('error', (e:any) => console.log('sockerr', e.code));
socket.once('connect', () => {
  console.log('connected, isServer?', socket.server);
  const request = http.request({
    createConnection: () => socket,
    path: '/redirect',
    headers: { host: '127.0.0.1' },
  }, (response) => {
    console.log('status', response.statusCode, 'location', response.headers.location);
    response.resume();
    response.on('end', () => server.close());
  });
  request.on('error', (e:any) => { console.log('reqerr', e.code, e.message); socket.destroy(); server.close(); });
  request.end();
});
