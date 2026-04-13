import { useEffect, useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Constants, dataService, Tools } from 'librechat-data-provider';
import { UIResourceRenderer } from '@mcp-ui/client';
import type { TAttachment, UIResource } from 'librechat-data-provider';
import { useLocalize, useExpandCollapse } from '~/hooks';
import UIResourceCarousel from './UIResourceCarousel';
import { useMessagesOperations } from '~/Providers';
import { OutputRenderer } from './ToolOutput';
import GraphRAGOutput, {
  extractGraphIdFromText,
  extractGraphPayloadFromText,
  isSummarizedOutput,
  loadGraphPayloadByGraphId,
  loadGraphPayloadFromCache,
  saveGraphPayloadToCache,
} from './ToolOutput/GraphRAGOutput';
import { handleUIAction, cn } from '~/utils';

function extractGraphPayloadFromGraphUIResource(resource: UIResource) {
  if (typeof resource?.text !== 'string' || resource.text.length === 0) {
    return null;
  }

  const payload = extractGraphPayloadFromText(resource.text);
  if (!payload) {
    return null;
  }

  const graphIdFromUri = resource.uri?.split('/').pop();
  if (graphIdFromUri && !payload.graph_id) {
    return { ...payload, graph_id: graphIdFromUri };
  }

  return payload;
}

function isSimpleObject(obj: unknown): obj is Record<string, string | number | boolean | null> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return false;
  }
  const entries = Object.entries(obj);
  if (entries.length === 0 || entries.length > 8) {
    return false;
  }
  return entries.every(
    ([, v]) =>
      v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

function KeyValueInput({ data }: { data: Record<string, string | number | boolean | null> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-1.5">
          <span className="font-medium text-text-secondary">{key}</span>
          <span className="rounded bg-surface-tertiary px-1.5 py-0.5 text-text-primary">
            {String(value ?? 'null')}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatParamValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.length > 200 ? value.slice(0, 200) + '...' : value;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  const str = JSON.stringify(value);
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

function ComplexInput({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-1.5">
          <span className="font-medium text-text-secondary">{key}</span>
          <span className="max-w-[300px] overflow-hidden truncate rounded bg-surface-tertiary px-1.5 py-0.5 font-mono text-text-primary">
            {formatParamValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function InputRenderer({ input }: { input: string }) {
  if (!input || input.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(input);
    if (isSimpleObject(parsed)) {
      return <KeyValueInput data={parsed} />;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return <ComplexInput data={parsed as Record<string, unknown>} />;
    }
    // Valid JSON but not a plain object (array, string, number, boolean) — render formatted
    return (
      <pre className="whitespace-pre-wrap text-xs text-text-primary">
        {typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    // Not JSON — render as plain text
    return <pre className="whitespace-pre-wrap text-xs text-text-primary">{input}</pre>;
  }
}

export default function ToolCallInfo({
  input,
  output,
  toolName,
  attachments,
}: {
  input: string;
  output?: string | null;
  toolName?: string;
  attachments?: TAttachment[];
}) {
  const localize = useLocalize();
  const { ask } = useMessagesOperations();
  const [showParams, setShowParams] = useState(false);
  const [graphPayloadFromFetch, setGraphPayloadFromFetch] = useState<ReturnType<
    typeof extractGraphPayloadFromText
  > | null>(null);
  const { style: paramsExpandStyle, ref: paramsExpandRef } = useExpandCollapse(showParams);

  const isGraphRAGGraphCall = useMemo(() => {
    if (typeof toolName !== 'string') {
      return false;
    }
    return toolName.includes('graphrag_query_with_graph');
  }, [toolName]);

  const graphPayloadFromOutput = useMemo(() => {
    if (typeof output !== 'string' || !isGraphRAGGraphCall) {
      return null;
    }
    return extractGraphPayloadFromText(output);
  }, [isGraphRAGGraphCall, output]);

  const graphUIResources = useMemo(() => {
    return (
      attachments
        ?.filter((attachment) => attachment.type === Tools.ui_resources)
        .flatMap((attachment) => {
          return attachment[Tools.ui_resources] as UIResource[];
        })
        .filter((resource) => resource?.uri?.startsWith('ui://graphrag/graph/')) ?? []
    );
  }, [attachments]);

  const graphPayloadFromUIResource = useMemo(() => {
    for (const resource of graphUIResources) {
      const payload = extractGraphPayloadFromGraphUIResource(resource);
      if (payload) {
        return payload;
      }
    }
    return null;
  }, [graphUIResources]);

  const graphPayload = useMemo(() => {
    if (graphPayloadFromUIResource) {
      return graphPayloadFromUIResource;
    }
    if (graphPayloadFromOutput) {
      return graphPayloadFromOutput;
    }
    if (graphPayloadFromFetch) {
      return graphPayloadFromFetch;
    }
    if (!isGraphRAGGraphCall || typeof output !== 'string') {
      return null;
    }

    const graphId = extractGraphIdFromText(output);
    if (graphId) {
      const byGraphId = loadGraphPayloadByGraphId(graphId);
      if (byGraphId) {
        return byGraphId;
      }
    }

    return loadGraphPayloadFromCache(input, toolName, {
      allowLatestFallback: isSummarizedOutput(output),
    });
  }, [graphPayloadFromFetch, graphPayloadFromOutput, graphPayloadFromUIResource, input, isGraphRAGGraphCall, output, toolName]);

  useEffect(() => {
    if (!graphPayload || !isGraphRAGGraphCall) {
      return;
    }
    saveGraphPayloadToCache(graphPayload, input, toolName);
  }, [graphPayload, input, isGraphRAGGraphCall, toolName]);

  useEffect(() => {
    if (!isGraphRAGGraphCall || graphPayload || typeof output !== 'string') {
      return;
    }

    const graphId = extractGraphIdFromText(output);
    if (!graphId) {
      return;
    }

    const delimiter = Constants.mcp_delimiter;
    const delimiterIndex = toolName?.indexOf(delimiter) ?? -1;
    if (delimiterIndex < 0 || !toolName) {
      return;
    }

    const serverName = toolName.slice(delimiterIndex + delimiter.length);
    if (!serverName) {
      return;
    }

    let cancelled = false;
    const fetchByGraphId = async () => {
      try {
        const response = await dataService.callMCPTool<unknown>(serverName, 'graphrag_get_graph_by_id', {
          graph_id: graphId,
          conversationId: 'graphrag-chat-fallback',
          messageId: `graphrag-chat-fallback-${Date.now()}`,
        });

        if (cancelled) {
          return;
        }

        const candidate = response?.result;
        const fromString = typeof candidate === 'string' ? extractGraphPayloadFromText(candidate) : null;

        let fromResourceText: ReturnType<typeof extractGraphPayloadFromText> | null = null;
        if (!fromString && candidate && typeof candidate === 'object' && 'content' in candidate) {
          const content = (candidate as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (!item || typeof item !== 'object') {
                continue;
              }
              const resource = (item as { resource?: { text?: unknown; uri?: unknown } }).resource;
              if (
                resource &&
                typeof resource.text === 'string' &&
                typeof resource.uri === 'string' &&
                resource.uri.startsWith('ui://graphrag/graph/')
              ) {
                fromResourceText = extractGraphPayloadFromGraphUIResource(resource as UIResource);
                if (fromResourceText) {
                  break;
                }
              }
            }
          }
        }

        const recovered = fromString ?? fromResourceText;
        if (recovered) {
          setGraphPayloadFromFetch(recovered);
        }
      } catch {
        return;
      }
    };

    fetchByGraphId();

    return () => {
      cancelled = true;
    };
  }, [graphPayload, isGraphRAGGraphCall, output, toolName]);

  const hasParams = useMemo(() => {
    if (!input || input.trim().length === 0) {
      return false;
    }
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) {
        return Object.keys(parsed).length > 0;
      }
    } catch {
      // Not JSON
    }
    return input.trim().length > 0;
  }, [input]);

  const uiResources: UIResource[] =
    attachments
      ?.filter((attachment) => attachment.type === Tools.ui_resources)
      .flatMap((attachment) => {
        return attachment[Tools.ui_resources] as UIResource[];
      })
      .filter((resource) => !resource?.uri?.startsWith('ui://graphrag/graph/')) ?? [];

  return (
    <div className="w-full px-3 py-3.5">
      {graphPayload ? <GraphRAGOutput payload={graphPayload} /> : output && <OutputRenderer text={output} />}
      {output && hasParams && <div className="my-2 border-t border-border-light" />}
      {hasParams && (
        <>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 text-xs text-text-secondary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
            )}
            onClick={() => setShowParams((prev) => !prev)}
            aria-expanded={showParams}
          >
            <span>{localize('com_ui_parameters')}</span>
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform duration-200 ease-out',
                showParams && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
          <div style={paramsExpandStyle}>
            <div className="overflow-hidden pt-1" ref={paramsExpandRef}>
              <InputRenderer input={input} />
            </div>
          </div>
        </>
      )}
      {uiResources.length > 0 && (
        <>
          {(hasParams || output) && <div className="my-2 border-t border-border-light" />}
          {uiResources.length > 1 && <UIResourceCarousel uiResources={uiResources} />}
          {uiResources.length === 1 && (
            <UIResourceRenderer
              resource={uiResources[0]}
              onUIAction={async (result) => handleUIAction(result, ask)}
              htmlProps={{
                autoResizeIframe: { width: true, height: true },
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
