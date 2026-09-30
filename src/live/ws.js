/**
 * Minimalni WebSocket server (RFC 6455) — bez ijedne npm zavisnosti (`net`/`http` + `crypto`).
 *
 * Zašto sopstveni: pravilo projekta je `dependencies: {}`. Za live vizuelizaciju treba nam samo:
 *   • handshake (Sec-WebSocket-Accept = base64(sha1(key + GUID)))
 *   • čitanje frame-ova (FIN/opcode, mask, dužina 7/16/64-bit, unmask)
 *   • slanje tekstualnih frame-ova, ping/pong i close
 *
 * Ograničenja (svjesno): bez per-message deflate, bez fragmentacije velikih poruka (primamo do
 * `maxPayloadBytes`), bez subprotokola. Za live feed (mali JSON snapshoti) to je dovoljno.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export const acceptKey = (key) => crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');

/** Kodira server→klijent frame (bez maskiranja, kako spec traži za server). */
export function encodeFrame(payload, { opcode = OPCODES.TEXT } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

/** Parsira jedan frame iz bafera; vraća `{ frame, offset }` ili `null` ako treba još bajtova. */
export function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { frame: { fin, opcode, payload }, offset: offset + len };
}

/**
 * Priključi WebSocket na postojeći HTTP server (`server.on('upgrade')`).
 * @returns {{ clients: Set, broadcast: Function, close: Function }}
 */
export function attachWebSocket(server, { path = '/events', maxPayloadBytes = 256 * 1024, logger, metrics, onClient = null } = {}) {
  const emitter = new EventEmitter();
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));

    const client = {
      id: crypto.randomBytes(6).toString('hex'),
      socket,
      openedAt: Date.now(),
      send: (data, opts) => {
        if (socket.destroyed) return false;
        try {
          socket.write(encodeFrame(typeof data === 'string' ? data : JSON.stringify(data), opts));
          return true;
        } catch {
          return false;
        }
      },
      close: () => socket.destroy(),
    };
    clients.add(client);
    metrics?.gauge?.('live_ws_clients', {}, clients.size);
    logger?.info?.('live.ws_client_connected', { id: client.id, clients: clients.size, ua: req.headers['user-agent'] ?? null });
    onClient?.(client, req);
    emitter.emit('client', client);

    let buffer = Buffer.from(head);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxPayloadBytes) {
        client.close();
        return;
      }
      for (;;) {
        const parsed = parseFrame(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.offset);
        const { opcode, payload } = parsed.frame;
        if (opcode === OPCODES.CLOSE) {
          client.close();
          break;
        }
        if (opcode === OPCODES.PING) client.send(payload, { opcode: OPCODES.PONG });
        if (opcode === OPCODES.TEXT || opcode === OPCODES.BINARY) {
          let text = payload.toString('utf8');
          try {
            text = JSON.parse(text);
          } catch {
            /* ostavi kao tekst */
          }
          emitter.emit('message', { client, data: text });
        }
      }
    });
    const drop = () => {
      clients.delete(client);
      metrics?.gauge?.('live_ws_clients', {}, clients.size);
      logger?.info?.('live.ws_client_disconnected', { id: client.id, clients: clients.size });
      emitter.emit('close', client);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  return {
    clients,
    on: (...a) => emitter.on(...a),
    clientCount: () => clients.size,
    /** Pošalji svim klijentima; vraća broj uspješnih. */
    broadcast(data) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      let sent = 0;
      for (const client of clients) if (client.send(text)) sent += 1;
      if (sent) metrics?.inc('live_ws_broadcasts_total', {});
      return sent;
    },
    ping() {
      for (const client of clients) client.send(Buffer.alloc(0), { opcode: OPCODES.PING });
    },
    close() {
      for (const client of clients) client.close();
      clients.clear();
      return true;
    },
    OPCODES,
  };
}
