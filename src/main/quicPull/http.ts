// HTTP 响应工具：统一的 CORS 头、错误响应与请求体读取。
//
// 从 quicPull.ts 提取，消除多处重复的 writeHead 调用。

import http from 'http';

/** 统一的 CORS 响应头（所有响应共享）。 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
};

/** 不缓存的响应头组合。 */
export const NO_CACHE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'Cache-Control': 'no-cache, no-store',
  'Pragma': 'no-cache',
};

/** 向已打开的流写 HTTP 200 头（FLV / HTML 等长连接）。 */
export function writeStreamHeaders(res: http.ServerResponse, contentType: string): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    ...NO_CACHE_HEADERS,
    'Connection': 'close',
  });
}

/** 写纯文本错误响应并关闭连接。 */
export function writeHttpError(res: http.ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
    'Connection': 'close',
  });
  res.end(body);
}

/** 写 JSON 成功响应。 */
export function writeJsonResponse(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(body);
}

/** 写 OPTIONS 预检响应。 */
export function writeCorsPreflight(res: http.ServerResponse): void {
  res.writeHead(204, {
    ...CORS_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': 0,
    'Connection': 'close',
  });
  res.end();
}

/** 安全地读取请求体，超过 maxBytes 时抛出。 */
export function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    req.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += data.length;
      if (totalBytes > maxBytes) {
        req.resume();
        finish(new Error('request body exceeds limit'));
        return;
      }
      chunks.push(data);
    });
    req.once('end', () => finish());
    req.once('error', (error) => finish(error));
    req.once('aborted', () => finish(new Error('request aborted')));
  });
}

/** percent-decode 一个路径段，失败返回 null。 */
export function percentDecodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** 返回当前 Unix 毫秒时间戳。 */
export function epochMs(): number {
  return Date.now();
}
