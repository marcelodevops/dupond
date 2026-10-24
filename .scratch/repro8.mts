import http from 'http';
import net from 'net';
const server = http.createServer((_req,res)=>{res.writeHead(200);res.end('A');});
await new Promise<void>((r)=>server.listen(8090,'127.0.0.1',r));

function attempt(label: string, opts: any) {
  return new Promise<string>((resolve) => {
    const request = http.request({ path: '/', ...opts }, (response) => {
      let s=''; response.setEncoding('utf8'); response.on('data',(c)=>(s+=c)); response.on('end',()=>resolve(`${s} peer=${request.socket?.remoteAddress}:${request.socket?.remotePort}`));
    });
    request.on('error', (e:any) => resolve(`ERR ${e.code} ${e.message}`));
    request.end();
  });
}
console.log('A host=localhost lookup=>', await attempt('a', {
  agent: false, host: 'localhost', port: 8090, lookup: (_h: string, _o: any, cb: any) => cb(null, '127.0.0.1', 4),
}));
console.log('B hostname only, lookup 2-stage:', await attempt('b', {
  agent: false, hostname: 'localhost', port: 8090, lookup: (_h: string, options: any, cb: any) => { void options; cb(null, '127.0.0.1', 4); },
}));
console.log('C createConnection + host/port set:', await attempt('c', {
  host: '127.0.0.1', port: 8090, agent: false, createConnection: () => net.connect({ host: '127.0.0.1', port: 8090 }),
}));
server.close();
