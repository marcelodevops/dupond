import http from 'http';
import { safeRequest } from '../src/server/egress.ts';

const server = http.createServer((req, res) => {
  console.log('server got', req.url);
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://127.0.0.1:8080/landed' });
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('secret-payload');
  }
});
await new Promise<void>((r) => server.listen(8080, '127.0.0.1', r));
try {
  const res = await safeRequest('http://127.0.0.1:8080/redirect', { allowedHosts: ['*'], allowPrivateAddressing: true });
  console.log('RESULT', res);
} catch (e) {
  console.log('ERROR', (e as Error).name, (e as Error).message);
}
server.close();
