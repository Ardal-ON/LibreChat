import { Constants, ContentTypes, StepTypes, ToolCallTypes } from 'librechat-data-provider';

export interface SemaaRuntimeEvent {
  type: string;
  runId?: string;
  toolName?: string;
  toolIndex?: number;
  phase?: 'plan' | 'reflect';
  args?: Record<string, unknown>;
  output?: string;
  error?: string;
  content?: string;
  skillName?: string;
  specialistName?: string;
}

export interface LibreChatStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface SemaaAdapterState {
  planReasoningStarted: boolean;
  reflectReasoningStarted: boolean;
  answerStepStarted: boolean;
  toolCount: number;
}

export function createSemaaAdapterState(): SemaaAdapterState {
  return {
    planReasoningStarted: false,
    reflectReasoningStarted: false,
    answerStepStarted: false,
    toolCount: 0,
  };
}

export function transformSemaaEvent(
  event: SemaaRuntimeEvent,
  state: SemaaAdapterState,
): LibreChatStreamEvent[] {
  const semaaRunId = event.runId ?? 'run';
  const runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;

  switch (event.type) {
    case 'run.started': {
      const stepId = `semaa_${semaaRunId}_reasoning_plan`;
      state.planReasoningStarted = true;
      return [
        {
          event: 'on_run_step',
          data: {
            runId,
            id: stepId,
            index: 0,
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: { message_id: stepId },
            },
          },
        },
        {
          event: 'on_reasoning_delta',
          data: {
            id: stepId,
            delta: {
              content: [{ type: ContentTypes.THINK, think: 'Reading your request…' }],
            },
          },
        },
      ];
    }
    case 'reasoning.delta': {
      const phase = event.phase ?? 'plan';
      const stepId = `semaa_${semaaRunId}_reasoning_${phase}`;
      const events: LibreChatStreamEvent[] = [];
      const startedKey = phase === 'plan' ? 'planReasoningStarted' : 'reflectReasoningStarted';

      if (!state[startedKey]) {
        state[startedKey] = true;
        events.push({
          event: 'on_run_step',
          data: {
            runId,
            id: stepId,
            index: reasoningStepIndex(state, phase),
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: { message_id: stepId },
            },
          },
        });
      }

      if (event.content) {
        events.push({
          event: 'on_reasoning_delta',
          data: {
            id: stepId,
            delta: {
              content: [{ type: ContentTypes.THINK, think: event.content }],
            },
          },
        });
      }

      return events;
    }
    case 'tool.started': {
      const toolIndex = event.toolIndex ?? 0;
      state.toolCount = Math.max(state.toolCount, toolIndex + 1);
      const stepId = `semaa_${semaaRunId}_${toolIndex}`;
      const callId = `call_${semaaRunId}_${toolIndex}`;
      const index = toolStepIndex(state, toolIndex);
      return [
        {
          event: 'on_run_step',
          data: {
            runId,
            id: stepId,
            index,
            type: StepTypes.TOOL_CALLS,
            stepDetails: {
              type: StepTypes.TOOL_CALLS,
              tool_calls: [
                {
                  id: callId,
                  name: event.toolName,
                  args: JSON.stringify(event.args ?? {}),
                  type: ToolCallTypes.TOOL_CALL,
                },
              ],
            },
          },
        },
      ];
    }
    case 'tool.completed': {
      const toolIndex = event.toolIndex ?? 0;
      const stepId = `semaa_${semaaRunId}_${toolIndex}`;
      const callId = `call_${semaaRunId}_${toolIndex}`;
      return [
        {
          event: 'on_run_step_completed',
          data: {
            result: {
              id: stepId,
              index: toolStepIndex(state, toolIndex),
              tool_call: {
                id: callId,
                name: event.toolName,
                args: '',
                type: ToolCallTypes.TOOL_CALL,
                output: event.output ?? '',
                progress: 1,
              },
            },
          },
        },
      ];
    }
    case 'tool.failed': {
      const toolIndex = event.toolIndex ?? 0;
      const stepId = `semaa_${semaaRunId}_${toolIndex}`;
      const callId = `call_${semaaRunId}_${toolIndex}`;
      return [
        {
          event: 'on_run_step_completed',
          data: {
            result: {
              id: stepId,
              index: toolStepIndex(state, toolIndex),
              tool_call: {
                id: callId,
                name: event.toolName,
                args: '',
                type: ToolCallTypes.TOOL_CALL,
                output: event.error ?? 'Tool failed',
                progress: 1,
              },
            },
          },
        },
      ];
    }
    case 'answer.delta': {
      const events: LibreChatStreamEvent[] = [];
      const stepId = `semaa_${semaaRunId}_answer`;
      if (!state.answerStepStarted) {
        state.answerStepStarted = true;
        events.push({
          event: 'on_run_step',
          data: {
            runId,
            id: stepId,
            index: answerStepIndex(state),
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: { message_id: stepId },
            },
          },
        });
      }
      if (event.content) {
        events.push({
          event: 'on_message_delta',
          data: {
            id: stepId,
            delta: {
              content: [{ type: ContentTypes.TEXT, text: event.content }],
            },
          },
        });
      }
      return events;
    }
    default:
      return [];
  }
}

function reasoningStepIndex(state: SemaaAdapterState, phase: 'plan' | 'reflect'): number {
  if (phase === 'plan') {
    return 0;
  }
  return (state.planReasoningStarted ? 1 : 0) + state.toolCount;
}

function toolStepIndex(state: SemaaAdapterState, toolIndex: number): number {
  return (state.planReasoningStarted ? 1 : 0) + toolIndex;
}

function answerStepIndex(state: SemaaAdapterState): number {
  let index = state.planReasoningStarted ? 1 : 0;
  index += state.toolCount;
  if (state.reflectReasoningStarted) {
    index += 1;
  }
  return index;
}
