import dns from 'dns';
import https from 'https';
import net from 'net';
import tls from 'tls';

const host = 'api.github.com';
const { address: ip } = await new Promise<any>((res, rej) =>
  dns.lookup(host, { family: 4, verbatim: true }, (e, a, f) => (e ? rej(e) : res({ address: a, family: f }))));
console.log('pinned ip', ip);

function run(label: string, opts: any) {
  return new Promise<void>((resolve) => {
    const req = https.request({ method: 'GET', path: '/zen', timeout: 8000, headers: { host, accept: '*/*' }, ...opts }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => (s += c));
      res.on('end', () => { console.log(label, '=> status', res.statusCode, 'tls?', req.socket?.encrypted, JSON.stringify(s.slice(0, 40))); resolve(); });
    });
    req.on('error', (e: any) => { console.log(label, '=> ERR', e.code, e.message); resolve(); });
    req.on('timeout', () => { console.log(label, '=> TIMEOUT'); req.destroy(); resolve(); });
    req.end();
  });
}

// D1: no createConnection, host = validated IP, servername for SNI/verification
await run('D1 host=ip + servername', { agent: false, host: ip, port: 443, servername: host });

// D2: hand it an already-established TLS socket
const plain = net.connect({ host: ip, port: 443 });
await new Promise<void>((res, rej) => { plain.once('connect', () => res()); plain.once('error', rej); });
const secure = tls.connect({ socket: plain, servername: host });
await new Promise<void>((res, rej) => { secure.once('secureConnect', () => res()); secure.once('error', rej); });
await run('D2 pre-established TLSSocket', { agent: false, host: ip, port: 443, servername: host, createConnection: () => secure });
process.exit(0);
