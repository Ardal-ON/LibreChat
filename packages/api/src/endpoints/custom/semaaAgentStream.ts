import fetch from 'node-fetch';
import { extractEnvVariable } from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import { getCustomEndpointConfig } from '~/app/config';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { sendEvent } from '~/utils/events';
import { createSemaaIdentityHeaders, isSemaaAgentEndpoint } from '~/utils/semaaIdentity';
import {
  createSemaaAdapterState,
  transformSemaaEvent,
  type SemaaRuntimeEvent,
} from './semaaStreamAdapter';

export interface SemaaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SemaaAttachedFile {
  file_id: string;
  filename: string;
  text?: string;
  status?: string;
}

export interface StreamSemaaAgentCompletionParams {
  req: {
    config?: AppConfig;
    user?: { id?: string; _id?: unknown; tenantId?: string; email?: string };
    _resumableStreamId?: string | null;
  };
  res: ServerResponse;
  endpoint: string;
  model: string;
  messages: SemaaChatMessage[];
  attachedFiles?: SemaaAttachedFile[];
  responseMessageId: string;
  conversationId?: string;
  aggregateContent?: (input: { event: string; data: Record<string, unknown> }) => void;
  abortSignal?: AbortSignal;
}

async function emitLibreChatEvent(
  res: ServerResponse,
  streamId: string | null | undefined,
  event: { event: string; data: Record<string, unknown> },
  aggregateContent?: StreamSemaaAgentCompletionParams['aggregateContent'],
): Promise<void> {
  aggregateContent?.({ event: event.event, data: event.data });
  if (streamId) {
    await GenerationJobManager.emitChunk(streamId, event);
  } else {
    sendEvent(res, event);
  }
}

export function resolveSemaaBaseUrl(endpoint: string, appConfig?: AppConfig): string {
  const endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
  const baseURL = extractEnvVariable(endpointConfig?.baseURL ?? '');
  return baseURL.replace(/\/+$/, '');
}

export function resolveSemaaApiKey(endpoint: string, appConfig?: AppConfig): string {
  const endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
  return extractEnvVariable(endpointConfig?.apiKey ?? '');
}

export function resolveSemaaEndpoint(
  endpoint?: string | null,
  agentEndpoint?: string | null,
): string {
  const candidates = [agentEndpoint, endpoint].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) {
    if (isSemaaAgentEndpoint(candidate)) {
      return candidate;
    }
  }
  return agentEndpoint ?? endpoint ?? 'semaa';
}

export function isSemaaAgentRoute(endpoint?: string | null, agentEndpoint?: string | null): boolean {
  return [agentEndpoint, endpoint].some(
    (value) => typeof value === 'string' && isSemaaAgentEndpoint(value),
  );
}

export interface GenerateSemaaAgentTitleParams {
  req: StreamSemaaAgentCompletionParams['req'];
  endpoint: string;
  model: string;
  text: string;
  responseText?: string;
  abortSignal?: AbortSignal;
}

export async function generateSemaaAgentTitle(
  params: GenerateSemaaAgentTitleParams,
): Promise<string> {
  const baseUrl = resolveSemaaBaseUrl(params.endpoint, params.req.config);
  const apiKey = resolveSemaaApiKey(params.endpoint, params.req.config);
  const identityHeaders = createSemaaIdentityHeaders({
    endpoint: params.endpoint,
    baseURL: baseUrl,
    user: params.req.user,
  });
  const conversation = params.responseText
    ? `User: ${params.text}\nAI: ${params.responseText}`
    : `User: ${params.text}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...identityHeaders,
    },
    body: JSON.stringify({
      model: params.model || 'semaa',
      stream: false,
      messages: [
        {
          role: 'user',
          content: `Provide a concise, 5-word-or-less title for the conversation, using title case conventions. Only return the title itself.\n\n${conversation}`,
        },
      ],
      metadata: {
        titleGeneration: true,
      },
    }),
    signal: params.abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Semaa title request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() ?? '';
}

export async function streamSemaaAgentCompletion(
  params: StreamSemaaAgentCompletionParams,
): Promise<void> {
  const {
    req,
    res,
    endpoint,
    model,
    messages,
    attachedFiles = [],
    conversationId,
    aggregateContent,
    abortSignal,
  } = params;
  const streamId = req._resumableStreamId ?? null;
  const baseUrl = resolveSemaaBaseUrl(endpoint, req.config);
  const apiKey = resolveSemaaApiKey(endpoint, req.config);
  const identityHeaders = createSemaaIdentityHeaders({
    endpoint,
    baseURL: baseUrl,
    user: req.user,
  });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Semaa-Stream-Mode': 'events',
      ...identityHeaders,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages,
      metadata: {
        ...(conversationId ? { conversationId } : {}),
        ...(attachedFiles.length ? { attachedFiles } : {}),
      },
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Semaa agent request failed (${response.status}): ${errorText}`);
  }
  if (!response.body) {
    throw new Error('Semaa agent returned an empty stream body');
  }

  const adapterState = createSemaaAdapterState();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      let parsed: { semaa_event?: SemaaRuntimeEvent };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const semaaEvent = parsed.semaa_event;
      if (!semaaEvent?.type) {
        continue;
      }

      const events = transformSemaaEvent(semaaEvent, adapterState);
      for (const event of events) {
        await emitLibreChatEvent(res, streamId, event, aggregateContent);
      }
    }
  }
}
