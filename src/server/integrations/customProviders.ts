import { safeRequest, EgressBlockedError } from '../egress.js';

/**
 * /custom-providers targets loopback and RFC1918 by design (local Ollama, LAN
 * vLLM), which is exactly the traffic the SSRF filter blocks. Default stays
 * fail-closed; a deployment that genuinely serves local models opts in.
 */
export const ALLOW_PRIVATE_PROVIDER_HOSTS =
  process.env.DUPOND_ALLOW_PRIVATE_PROVIDER_HOSTS === 'true' ||
  process.env.AEGIS_ALLOW_PRIVATE_PROVIDER_HOSTS === 'true';

export function isBlockedError(error: any): boolean {
  return error instanceof EgressBlockedError;
}

const BLOCKED_HINT = 'Local/LAN endpoints (Ollama, vLLM) require DUPOND_ALLOW_PRIVATE_PROVIDER_HOSTS=true.';

export async function executeCustomProvider(body: any) {
  const { endpointUrl, headers = {}, prompt, providerType = 'llm' } = body;

  let bodyData: any = { prompt };
  if (providerType === 'llm') {
    bodyData = {
      model: 'default',
      messages: [{ role: 'user', content: prompt }],
      prompt,
      stream: false,
    };
  }

  const startTime = Date.now();
  try {
    const response = await safeRequest(endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(bodyData),
      allowedHosts: ['*'],
      allowPrivateAddressing: ALLOW_PRIVATE_PROVIDER_HOSTS,
      timeoutMs: 10000,
    });

    const latencyMs = Date.now() - startTime;
    let parsedText = response.body;

    try {
      const jsonRes = JSON.parse(response.body);
      parsedText = jsonRes.choices?.[0]?.message?.content || jsonRes.response || jsonRes.text || response.body;
    } catch {}

    return {
      blocked: false,
      status: 200,
      body: {
        success: response.ok,
        status: response.status,
        latencyMs,
        redirected: Boolean(response.location),
        output: parsedText,
      },
    };
  } catch (error: any) {
    if (isBlockedError(error)) {
      return {
        blocked: true,
        status: 403,
        body: {
          success: false,
          blocked: true,
          error: error.message,
          hint: ALLOW_PRIVATE_PROVIDER_HOSTS ? undefined : BLOCKED_HINT,
        },
      };
    }
    throw error;
  }
}

export async function pingCustomProvider(body: any) {
  const { endpointUrl, headers = {}, payload = {} } = body;

  const startTime = Date.now();
  try {
    const response = await safeRequest(endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      allowedHosts: ['*'],
      allowPrivateAddressing: ALLOW_PRIVATE_PROVIDER_HOSTS,
      timeoutMs: 5000,
    });

    const latencyMs = Date.now() - startTime;
    return {
      blocked: false,
      status: 200,
      body: {
        success: response.ok,
        status: response.status,
        latencyMs,
        redirected: Boolean(response.location),
        responsePreview: response.body.slice(0, 500),
      },
    };
  } catch (fetchErr: any) {
    const latencyMs = Date.now() - startTime;
    if (isBlockedError(fetchErr)) {
      return {
        blocked: true,
        status: 403,
        body: {
          success: false,
          blocked: true,
          error: fetchErr.message,
          latencyMs,
          hint: ALLOW_PRIVATE_PROVIDER_HOSTS ? undefined : BLOCKED_HINT,
        },
      };
    }
    return {
      blocked: false,
      status: 200,
      body: { success: false, error: fetchErr.message || 'Connection failed', latencyMs },
    };
  }
}
