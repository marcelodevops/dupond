import http from 'http';
http.createServer((req,res)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({echo:req.url, got:b, peer:req.socket.remotePort})); }); }).listen(8099,'127.0.0.1',()=>console.log('echo on 8099'));
