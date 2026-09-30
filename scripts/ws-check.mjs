// Provjera WebSocket handshake-a kroz nginx (wss na 443) — bez npm zavisnosti.
// Pokreće se NA Hetzner boxu:  node /root/ws-check.mjs
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? 443);
const sni = process.argv[4] ?? 'live.braincore.pro';
const useTls = process.argv.includes('--tls') || port === 443;
const key = crypto.randomBytes(16).toString('base64');

// Kroz nginx na 443 ide TLS (wss://) — običan TCP bi dobio 400 Bad Request
const socket = useTls
  ? tls.connect({ host, port, servername: sni, rejectUnauthorized: false }, () => {
      socket.write(handshake());
    })
  : net.connect(port, host, () => socket.write(handshake()));

function handshake() {
  return [
    'GET /events HTTP/1.1',
    `Host: ${sni}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n');
}

let buf = '';
socket.on('data', (chunk) => {
  buf += chunk.toString('latin1');
  if (buf.includes('\r\n\r\n')) {
    const status = buf.split('\r\n')[0];
    console.log('status:', status);
    console.log('sec-websocket-accept:', /sec-websocket-accept/i.test(buf) ? 'prisutan' : 'NEMA');
    // prvi frame poslije handshake-a treba biti snapshot
    const rest = buf.split('\r\n\r\n')[1] ?? '';
    console.log('prvi frame bajtova:', rest.length);
    socket.destroy();
    process.exit(status.includes('101') ? 0 : 1);
  }
});
socket.on('error', (err) => {
  console.log('greska:', err.message);
  process.exit(2);
});
setTimeout(() => {
  console.log('timeout — nema odgovora');
  socket.destroy();
  process.exit(3);
}, 5000);
