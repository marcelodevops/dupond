import http from 'http';
const hits: string[] = [];
const server = http.createServer((_req,res)=>{hits.push('a');res.writeHead(200);res.end('A');});
const server2 = http.createServer((_req,res)=>{hits.push('b');res.writeHead(200);res.end('B');});
await new Promise<void>((r)=>server.listen(8090,'127.0.0.1',r));
await new Promise<void>((r)=>server2.listen(8091,'127.0.0.1',r));

function attempt(label: string, opts: any) {
  return new Promise<string>((resolve) => {
    const request = http.request({ path: '/', ...opts }, (response) => {
      let s=''; response.setEncoding('utf8'); response.on('data',(c)=>(s+=c)); response.on('end',()=>resolve(`${s} peer=${request.socket?.remoteAddress}:${request.socket?.remotePort}`));
    });
    request.on('error', (e:any) => resolve(`ERR ${e.code}`));
    request.end();
  });
}
// pin 8090 while asking for "evil" which would resolve elsewhere
console.log('lookup+agent:false =>', await attempt('l', {
  agent: false, host: 'evil.invalid', port: 8090,
  lookup: (_h: string, _o: any, cb: any) => cb(null, '127.0.0.1', 4),
}));
console.log('lookup+agent:false peer check =>', await attempt('l2', {
  agent: false, host: 'evil.invalid', port: 8091,
  lookup: (_h: string, _o: any, cb: any) => cb(null, '127.0.0.1', 4),
}));
server.close(); server2.close();
