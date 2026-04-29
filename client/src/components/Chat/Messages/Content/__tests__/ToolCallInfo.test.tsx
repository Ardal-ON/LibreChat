import React from 'react';
import { Constants, dataService, Tools } from 'librechat-data-provider';
import { UIResourceRenderer } from '@mcp-ui/client';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import UIResourceCarousel from '~/components/Chat/Messages/Content/UIResourceCarousel';
import ToolCallInfo from '~/components/Chat/Messages/Content/ToolCallInfo';
import { getGraphPayloadCacheKey } from '~/components/Chat/Messages/Content/ToolOutput/GraphRAGOutput';

jest.mock('react-cytoscapejs', () => () => <div data-testid="mock-cytoscape" />);

// Mock the dependencies
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_parameters: 'Parameters',
    };
    return translations[key] || key;
  },
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

jest.mock('~/Providers', () => ({
  useMessagesOperations: () => ({
    ask: jest.fn(),
  }),
}));

jest.mock('@mcp-ui/client', () => ({
  UIResourceRenderer: jest.fn(() => null),
}));

jest.mock('../UIResourceCarousel', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

jest.mock('../ToolOutput', () => ({
  OutputRenderer: ({ text }: { text: string }) => <div data-testid="output-renderer">{text}</div>,
}));

jest.mock('~/utils', () => ({
  handleUIAction: jest.fn(),
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
}));

jest.mock('lucide-react', () => ({
  ChevronDown: () => <span>{'ChevronDown'}</span>,
}));

describe('ToolCallInfo', () => {
  const mockProps = {
    input: '{"test": "input"}',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  describe('ui_resources from attachments', () => {
    it('should render single ui_resource from attachments', () => {
      const uiResource = {
        type: 'text',
        data: 'Test resource',
      };

      const attachments: TAttachment[] = [
        {
          type: Tools.ui_resources,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.ui_resources]: [uiResource] as any,
        },
      ];

      render(<ToolCallInfo {...mockProps} output="Some output" attachments={attachments} />);

      // Should render UIResourceRenderer for single resource
      expect(UIResourceRenderer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: uiResource,
          onUIAction: expect.any(Function),
          htmlProps: {
            autoResizeIframe: { width: true, height: true },
          },
        }),
        expect.any(Object),
      );

      // Should not render carousel for single resource
      expect(UIResourceCarousel).not.toHaveBeenCalled();
    });

    it('should render carousel for multiple ui_resources from attachments', () => {
      const attachments: TAttachment[] = [
        {
          type: Tools.ui_resources,
          messageId: 'msg1',
          toolCallId: 'tool1',
          conversationId: 'conv1',
          [Tools.ui_resources]: [
            { type: 'text', data: 'Resource 1' },
            { type: 'text', data: 'Resource 2' },
            { type: 'text', data: 'Resource 3' },
          ] as any,
        },
      ];

      render(<ToolCallInfo {...mockProps} output="Some output" attachments={attachments} />);

      // Should render carousel for multiple resources
      expect(UIResourceCarousel).toHaveBeenCalledWith(
        expect.objectContaining({
          uiResources: [
            { type: 'text', data: 'Resource 1' },
            { type: 'text', data: 'Resource 2' },
            { type: 'text', data: 'Resource 3' },
          ],
        }),
        expect.any(Object),
      );

      // Should not render individual UIResourceRenderer
      expect(UIResourceRenderer).not.toHaveBeenCalled();
    });

    it('should handle no attachments', () => {
      render(<ToolCallInfo {...mockProps} output="Some output" />);

      expect(UIResourceRenderer).not.toHaveBeenCalled();
      expect(UIResourceCarousel).not.toHaveBeenCalled();
    });

    it('should handle empty attachments array', () => {
      render(<ToolCallInfo {...mockProps} attachments={[]} />);

      expect(UIResourceRenderer).not.toHaveBeenCalled();
      expect(UIResourceCarousel).not.toHaveBeenCalled();
    });

    it('should handle attachments with non-ui_resources type', () => {
      const attachments: TAttachment[] = [
        {
          type: Tools.web_search as any,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.web_search]: {
            organic: [],
          },
        },
      ];

      render(<ToolCallInfo {...mockProps} attachments={attachments} />);

      expect(UIResourceRenderer).not.toHaveBeenCalled();
      expect(UIResourceCarousel).not.toHaveBeenCalled();
    });
  });

  describe('rendering logic', () => {
    it('should render output when provided', () => {
      render(<ToolCallInfo {...mockProps} output="Some output" />);

      expect(screen.getByTestId('output-renderer')).toBeInTheDocument();
      expect(screen.getByTestId('output-renderer').textContent).toBe('Some output');
    });

    it('should render parameters toggle when input has JSON content', () => {
      render(<ToolCallInfo {...mockProps} output="Some output" />);

      expect(screen.getByText('Parameters')).toBeInTheDocument();
    });

    it('should not render parameters toggle when input is empty', () => {
      render(<ToolCallInfo input="" output="Some output" />);

      expect(screen.queryByText('Parameters')).not.toBeInTheDocument();
    });

    it('should toggle parameters visibility when clicking', () => {
      render(<ToolCallInfo {...mockProps} output="Some output" />);

      const paramsButton = screen.getByText('Parameters');
      expect(paramsButton.closest('button')).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(paramsButton.closest('button')!);
      expect(paramsButton.closest('button')).toHaveAttribute('aria-expanded', 'true');
    });

    it('should render ui_resources section when attachments have ui_resources', () => {
      const attachments: TAttachment[] = [
        {
          type: Tools.ui_resources,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.ui_resources]: [{ type: 'text', data: 'Test' }] as any,
        },
      ];

      render(<ToolCallInfo {...mockProps} output="Some output" attachments={attachments} />);

      expect(UIResourceRenderer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: { type: 'text', data: 'Test' },
        }),
        expect.any(Object),
      );
    });

    it('should render graph from cache when output is summarized', () => {
      const input = JSON.stringify({
        query: 'summary fallback test',
        top_k: 8,
      });
      const key = getGraphPayloadCacheKey(input, 'graphrag_query_with_graph');
      const payload = {
        graph: {
          subgraph: {
            nodes: [{ id: 'n1', label: 'Node 1', type: 'entity' }],
            edges: [{ id: 'e1', source: 'n1', target: 'n1', relation: 'related_to' }],
          },
        },
      };

      localStorage.setItem(key, JSON.stringify(payload));

      render(
        <ToolCallInfo
          input={input}
          output="Conversation summarized"
          toolName="graphrag_query_with_graph"
        />,
      );

      expect(screen.getByText('Knowledge Graph')).toBeInTheDocument();
      expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
    });

    it('should render graph from ui_resources as primary channel', () => {
      const payload = {
        graph: {
          subgraph: {
            nodes: [{ id: 'n1', label: 'Node 1', type: 'entity' }],
            edges: [{ id: 'e1', source: 'n1', target: 'n1', relation: 'related_to' }],
          },
        },
      };

      const attachments: TAttachment[] = [
        {
          type: Tools.ui_resources,
          messageId: 'msg-graph',
          toolCallId: 'tool-graph',
          conversationId: 'conv-graph',
          [Tools.ui_resources]: [
            {
              resourceId: 'gr1',
              uri: 'ui://graphrag/graph/graph_abc123',
              mimeType: 'application/json',
              text: JSON.stringify(payload),
            },
          ] as any,
        },
      ];

      render(
        <ToolCallInfo
          input={mockProps.input}
          output="Graph generated and attached via ui_resources."
          toolName={`graphrag_query_with_graph${Constants.mcp_delimiter}semaa-graphrag-mcp`}
          attachments={attachments}
        />,
      );

      expect(screen.getByText('Knowledge Graph')).toBeInTheDocument();
      expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
    });

    it('should hide contains and mentions relations by default', () => {
      const payload = {
        graph: {
          subgraph: {
            nodes: [
              { id: 'doc1', label: 'Doc', type: 'document' },
              { id: 'chunk1', label: 'Chunk 1', type: 'chunk' },
              { id: 'dorothy', label: 'Dorothy', type: 'entity' },
              { id: 'glinda', label: 'Glinda', type: 'entity' },
            ],
            edges: [
              { id: 'e1', source: 'doc1', target: 'chunk1', relation: 'contains' },
              { id: 'e2', source: 'chunk1', target: 'dorothy', relation: 'mentions' },
              { id: 'e3', source: 'dorothy', target: 'glinda', relation: 'advised_by' },
            ],
          },
        },
      };

      const attachments: TAttachment[] = [
        {
          type: Tools.ui_resources,
          messageId: 'msg-graph-hidden-relations',
          toolCallId: 'tool-graph-hidden-relations',
          conversationId: 'conv-graph-hidden-relations',
          [Tools.ui_resources]: [
            {
              resourceId: 'gr-hidden-relations',
              uri: 'ui://graphrag/graph/graph_hidden_relations',
              mimeType: 'application/json',
              text: JSON.stringify(payload),
            },
          ] as any,
        },
      ];

      render(
        <ToolCallInfo
          input={mockProps.input}
          output="Graph generated and attached via ui_resources."
          toolName={`graphrag_query_with_graph${Constants.mcp_delimiter}semaa-graphrag-mcp`}
          attachments={attachments}
        />,
      );

      expect(screen.getByText('2 nodes | 1 edges')).toBeInTheDocument();
      expect(screen.queryByText('4 nodes | 3 edges')).not.toBeInTheDocument();
    });

    it('should refetch graph by graph_id when attachment is missing', async () => {
      const payload = {
        graph: {
          subgraph: {
            nodes: [{ id: 'n2', label: 'Node 2', type: 'entity' }],
            edges: [{ id: 'e2', source: 'n2', target: 'n2', relation: 'related_to' }],
          },
        },
      };

      jest.spyOn(dataService, 'callMCPTool').mockResolvedValueOnce({
        result: {
          content: [
            {
              type: 'text',
              text: 'Graph payload restored from server cache via graph_id.',
            },
            {
              type: 'resource',
              resource: {
                uri: 'ui://graphrag/graph/graph_refetch_001',
                mimeType: 'application/json',
                text: JSON.stringify(payload),
              },
            },
          ],
        },
      } as any);

      render(
        <ToolCallInfo
          input={mockProps.input}
          output="graph_id: graph_refetch_001"
          toolName={`graphrag_query_with_graph${Constants.mcp_delimiter}semaa-graphrag-mcp`}
        />,
      );

      await waitFor(() => {
        expect(dataService.callMCPTool).toHaveBeenCalledWith(
          'semaa-graphrag-mcp',
          'graphrag_get_graph_by_id',
          expect.objectContaining({ graph_id: 'graph_refetch_001' }),
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Knowledge Graph')).toBeInTheDocument();
      });
    });
  });

  describe('backward compatibility', () => {
    it('should handle output with ui_resources metadata (ignored — uses attachments)', () => {
      const output = JSON.stringify([
        { type: 'text', text: 'Regular output' },
        {
          metadata: {
            type: 'ui_resources',
            data: [{ type: 'text', data: 'UI Resource' }],
          },
        },
      ]);

      render(<ToolCallInfo {...mockProps} output={output} />);

      // Since we now use attachments, ui_resources in output should be ignored
      expect(UIResourceRenderer).not.toHaveBeenCalled();
      expect(UIResourceCarousel).not.toHaveBeenCalled();
    });

    it('should prioritize attachments over output ui_resources', () => {
      const attachments: TAttachment[] = [
        {
          type: Tools.ui_resources,
          messageId: 'msg123',
          toolCallId: 'tool456',
          conversationId: 'conv789',
          [Tools.ui_resources]: [{ type: 'attachment', data: 'From attachments' }] as any,
        },
      ];

      const output = JSON.stringify([
        {
          metadata: {
            type: 'ui_resources',
            data: [{ type: 'output', data: 'From output' }],
          },
        },
      ]);

      render(<ToolCallInfo {...mockProps} output={output} attachments={attachments} />);

      // Should use attachments, not output
      expect(UIResourceRenderer).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: { type: 'attachment', data: 'From attachments' },
        }),
        expect.any(Object),
      );
    });
  });
});
