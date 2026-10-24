import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Total budget for connect + response. */
  timeoutMs?: number;
  /**
   * Hosts this request may target. An array is matched case-insensitively, with
   * a leading dot meaning the host itself or any subdomain ('.atlassian.net').
   * Omit it to forbid every destination; pass '*' to allow any host that also
   * survives the address filter below (used by the custom-provider endpoints,
   * whose entire purpose is reaching user-supplied addresses).
   */
  allowedHosts?: string[];
  /**
   * Skip the public-address filter. Only for deployments that intentionally
   * target local/LAN services (Ollama on loopback, vLLM on a private network).
   * The host allowlist still applies, and redirects are still never followed.
   */
  allowPrivateAddressing?: boolean;
}

export interface SafeResponse {
  status: number;
  /** True when no hop redirected (this client never follows redirects). */
  ok: boolean;
  body: string;
  location?: string;
}

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/**
 * Only globally routable unicast addresses may be contacted from the server.
 * This is what blocks SSRF into loopback (localhost dev services), RFC1918
 * (internal networks), link-local incl. 169.254.169.254 (cloud metadata),
 * carrier-grade NAT, and IPv6 loopback/link-local/multicast/unique-local.
 *
 * Hand-rolled rather than pulled from a dependency, and deliberately written so
 * that IPv6 forms which *embed* an IPv4 address (::ffff:a.b.c.d, 6to4) are
 * unwrapped and re-checked instead of being waved through a v6-only filter.
 */
function assertPublicIpv4(address: string, label: string): void {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new EgressBlockedError(`malformed IPv4 ${label} '${address}'`);
  }
  const [a, b] = octets;

  if (a === 0) throw new EgressBlockedError(`refused this-network/loopback destination ${label} ${address}`);
  if (a === 10) throw new EgressBlockedError(`refused RFC1918 destination ${label} ${address}`);
  if (a === 127) throw new EgressBlockedError(`refused loopback destination ${label} ${address}`);
  if (a === 169 && b === 254) throw new EgressBlockedError(`refused link-local destination ${label} ${address} (cloud metadata)`);
  if (a === 172 && b >= 16 && b <= 31) throw new EgressBlockedError(`refused RFC1918 destination ${label} ${address}`);
  if (a === 192 && b === 168) throw new EgressBlockedError(`refused RFC1918 destination ${label} ${address}`);
  if (a === 192 && b === 0 && octets[2] === 0) throw new EgressBlockedError(`refused IETF protocol assignments destination ${label} ${address}`);
  if (a === 192 && b === 0 && octets[2] === 2) throw new EgressBlockedError(`refused TEST-NET-1 destination ${label} ${address}`);
  if (a === 198 && (b === 18 || b === 19)) throw new EgressBlockedError(`refused benchmark destination ${label} ${address}`);
  if (a === 198 && b === 51) throw new EgressBlockedError(`refused TEST-NET-2 destination ${label} ${address}`);
  if (a === 203 && b === 0 && octets[2] === 113) throw new EgressBlockedError(`refused TEST-NET-3 destination ${label} ${address}`);
  if (a >= 224) throw new EgressBlockedError(`refused multicast/reserved destination ${label} ${address}`);
}

function parseIpv6Groups(value: string): number[] | null {
  let text = value.toLowerCase();
  let embeddedV4: number[] | null = null;

  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    embeddedV4 = octets;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const split = text.split('::');
  if (split.length > 2) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const parts = segment.split(':');
    const groups: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const head = toGroups(split[0]);
  if (!head) return null;
  const tailGroups = toGroups(split[1] ?? '');
  if (!tailGroups) return null;

  let groups: number[];
  if (split.length === 2) {
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tailGroups];
  } else {
    if (head.length + tailGroups.length !== 8) return null;
    groups = [...head, ...tailGroups];
  }

  if (embeddedV4) {
    groups[6] = (embeddedV4[0] << 8) | embeddedV4[1];
    groups[7] = (embeddedV4[2] << 8) | embeddedV4[3];
  }
  return groups;
}

function assertPublicIpv6(address: string, label: string): void {
  const groups = parseIpv6Groups(address);
  if (!groups) throw new EgressBlockedError(`malformed IPv6 ${label} '${address}'`);

  // :: and ::1
  if (groups.every((g) => g === 0)) throw new EgressBlockedError(`refused unspecified destination ${label}`);
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    throw new EgressBlockedError(`refused IPv6 loopback destination ${label}`);
  }

  const first = groups[0];

  // ::ffff:a.b.c.d and the deprecated ::a.b.c.d both carry a v4 address in the
  // trailing 32 bits, so run them through the v4 rules rather than trusting
  // that a v6-shaped literal is public.
  const leadingZeros = groups.slice(0, 5).every((g) => g === 0);
  if (leadingZeros && (groups[4] === 0x0000 || groups[4] === 0xffff)) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    assertPublicIpv4(v4, `${label} (IPv4-embedded ${v4})`);
    return;
  }
  // 6to4: 2002::/16 hides a v4 address in groups 1 and 2.
  if (first === 0x2002) {
    const v4 = `${groups[1] >> 8}.${groups[1] & 255}.${groups[2] >> 8}.${groups[2] & 255}`;
    assertPublicIpv4(v4, `${label} (6to4 ${v4})`);
    return;
  }
  if ((first & 0xfe00) === 0xfc00) throw new EgressBlockedError(`refused IPv6 unique-local destination ${label}`);
  if ((first & 0xffc0) === 0xfe80) throw new EgressBlockedError(`refused IPv6 link-local destination ${label}`);
  if (first >= 0xff00) throw new EgressBlockedError(`refused IPv6 multicast/reserved destination ${label}`);
}

function assertPublicAddress(address: string, label = 'address'): void {
  const family = net.isIP(address);
  if (family === 4) assertPublicIpv4(address, label);
  else if (family === 6) assertPublicIpv6(address, label);
  else throw new EgressBlockedError(`unresolvable address '${address}'`);
}

function hostMatches(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (pattern === '*') return true;
    if (pattern.startsWith('.')) {
      return host === pattern.slice(1) || host.endsWith(pattern);
    }
    return host === pattern;
  });
}

function lookupAll(host: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(new EgressBlockedError(`DNS lookup for '${host}' failed: ${(err as Error).message}`));
      else resolve(addresses);
    });
  });
}

/**
 * Server-initiated HTTP with SSRF defences that `fetch` cannot provide.
 *
 * Why not fetch: it follows redirects by default (a public host can 302 to
 * 169.254.169.254), cannot be given a per-request resolver, and offers no way
 * to pin a checked address. The http/https modules never follow redirects and
 * do allow both.
 *
 * The address filter runs on the *resolved* records and the validated address
 * is then reused for the actual connection, closing the window where a short
 * DNS TTL would otherwise let an attacker swap the record between check and
 * connect (classic rebinding).
 */
export async function safeRequest(rawUrl: string, options: SafeRequestOptions = {}): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError(`invalid URL '${rawUrl}'`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError(`refused URL protocol '${url.protocol}'`);
  }
  if (url.username || url.password) {
    throw new EgressBlockedError('refused credentials embedded in the URL');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostMatches(hostname, options.allowedHosts ?? [])) {
    throw new EgressBlockedError(`host '${hostname}' is not in the allowlist for this endpoint`);
  }

  // A literal IP needs no lookup, but still needs filtering.
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookupAll(hostname);

  if (addresses.length === 0) {
    throw new EgressBlockedError(`host '${hostname}' resolved to no addresses`);
  }
  if (!options.allowPrivateAddressing) {
    for (const record of addresses) assertPublicAddress(record.address, `for '${hostname}'`);
  }

  const pinned = addresses.map((record) => record.address);
  const transport = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { accept: '*/*', ...options.headers };
  if (options.body !== undefined && !hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(options.body, 'utf8'));
  }

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (response: SafeResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const connect = (index: number): void => {
      if (index >= pinned.length) {
        fail(new EgressBlockedError('connection to every resolved address failed'));
        return;
      }

      const isTls = transport === https;
      const port = Number(url.port) || (isTls ? 443 : 80);
      const socket = net.connect({
        host: pinned[index],
        port,
        keepAlive: false,
      });
      socket.setTimeout(timeoutMs);

      const onError = (err: Error) => {
        socket.destroy();
        connect(index + 1);
      };
      socket.once('error', onError);
      socket.once('timeout', () => {
        socket.destroy();
        fail(new EgressBlockedError(`connection to '${hostname}' timed out`));
      });

      socket.once(isTls ? 'secureConnect' : 'connect', () => {
        socket.removeListener('error', onError);

        const transportRequest = isTls ? https.request : http.request;
        const request = transportRequest(
          {
            agent: false,
            createConnection: () => socket,
            servername: isTls ? hostname : undefined,
            method: options.method ?? 'GET',
            path: `${url.pathname}${url.search}`,
            // host/port must name the *validated* address even though the
            // socket is supplied. With agent:false, Node ignores createConnection
            // and falls back to its default destination (localhost:80) when these
            // are absent — silently connecting somewhere that was never checked.
            host: pinned[index],
            port,
            headers: { host: net.isIP(hostname) === 6 ? `[${hostname}]` : hostname, ...headers },
            timeout: timeoutMs,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let received = 0;

            response.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (received > MAX_BODY_BYTES) {
                response.destroy();
                fail(new EgressBlockedError(`response exceeded the ${MAX_BODY_BYTES}-byte limit`));
                return;
              }
              chunks.push(chunk);
            });

            response.on('error', (err) => fail(err));
            response.on('end', () => {
              const status = response.statusCode ?? 0;
              const isRedirect = status >= 300 && status < 400;
              if (isRedirect) {
                // Refusing to follow is the point: a public host must not be
                // able to bounce this request into an internal address.
                socket.destroy();
                succeed({
                  status,
                  ok: false,
                  body: '',
                  location: (response.headers.location as string) || undefined,
                });
                return;
              }
              socket.destroy();
              succeed({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString('utf8') });
            });
          },
        );

        request.on('error', (err) => {
          socket.destroy();
          fail(err);
        });
        request.on('timeout', () => {
          socket.destroy();
          fail(new EgressBlockedError(`request to '${hostname}' timed out`));
        });

        if (options.body !== undefined) request.write(options.body);
        request.end();
      });
    };

    connect(0);
  });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
