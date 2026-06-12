import { Constants, ContentTypes, StepTypes, ToolCallTypes } from 'librechat-data-provider';
import {
  createSemaaAdapterState,
  transformSemaaEvent,
  type SemaaRuntimeEvent,
} from './semaaStreamAdapter';

describe('semaaStreamAdapter', () => {
  it('maps tool.started to on_run_step with stable ids', () => {
    const events = transformSemaaEvent(
      {
        type: 'tool.started',
        runId: 'run-1',
        toolName: 'web.search',
        toolIndex: 0,
        args: { query: 'Semaa' },
      },
      createSemaaAdapterState(),
    );

    expect(events).toEqual([
      {
        event: 'on_run_step',
        data: {
          runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
          id: 'semaa_run-1_0',
          index: 0,
          type: StepTypes.TOOL_CALLS,
          stepDetails: {
            type: StepTypes.TOOL_CALLS,
            tool_calls: [
              {
                id: 'call_run-1_0',
                name: 'web.search',
                args: JSON.stringify({ query: 'Semaa' }),
                type: ToolCallTypes.TOOL_CALL,
              },
            ],
          },
        },
      },
    ]);
  });

  it('maps tool.completed to on_run_step_completed', () => {
    const events = transformSemaaEvent(
      {
        type: 'tool.completed',
        runId: 'run-1',
        toolName: 'sandbox.run',
        toolIndex: 1,
        output: '63',
      },
      createSemaaAdapterState(),
    );

    expect(events[0]?.event).toBe('on_run_step_completed');
    expect(events[0]?.data.result).toMatchObject({
      id: 'semaa_run-1_1',
      tool_call: {
        id: 'call_run-1_1',
        name: 'sandbox.run',
        output: '63',
        progress: 1,
      },
    });
  });

  it('maps answer.delta to on_message_delta after creating a message step', () => {
    const state = createSemaaAdapterState();
    const first = transformSemaaEvent(
      { type: 'answer.delta', runId: 'run-1', content: 'Hello' },
      state,
    );
    const second = transformSemaaEvent(
      { type: 'answer.delta', runId: 'run-1', content: ' world' },
      state,
    );

    expect(first).toHaveLength(2);
    expect(first[0]?.event).toBe('on_run_step');
    expect(first[1]).toEqual({
      event: 'on_message_delta',
      data: {
        id: 'semaa_run-1_answer',
        delta: {
          content: [{ type: ContentTypes.TEXT, text: 'Hello' }],
        },
      },
    });
    expect(second).toEqual([
      {
        event: 'on_message_delta',
        data: {
          id: 'semaa_run-1_answer',
          delta: {
            content: [{ type: ContentTypes.TEXT, text: ' world' }],
          },
        },
      },
    ]);
  });

  it('ignores process-only runtime events', () => {
    const events = transformSemaaEvent(
      { type: 'skill.selected', runId: 'run-1', skillName: 'research' } as SemaaRuntimeEvent,
      createSemaaAdapterState(),
    );
    expect(events).toEqual([]);
  });

  it('maps run.started to an immediate thinking step', () => {
    const events = transformSemaaEvent({ type: 'run.started', runId: 'run-1' }, createSemaaAdapterState());
    expect(events[0]?.event).toBe('on_run_step');
    expect(events[1]?.event).toBe('on_reasoning_delta');
    expect(events[1]?.data).toMatchObject({
      id: 'semaa_run-1_reasoning_plan',
      delta: { content: [{ type: ContentTypes.THINK, think: 'Reading your request…' }] },
    });
  });

  it('maps reasoning.delta to on_reasoning_delta and offsets tool steps', () => {
    const state = createSemaaAdapterState();
    const plan = transformSemaaEvent(
      { type: 'reasoning.delta', runId: 'run-1', phase: 'plan', content: 'I will search the web.' },
      state,
    );
    const tool = transformSemaaEvent(
      {
        type: 'tool.started',
        runId: 'run-1',
        toolName: 'web.search',
        toolIndex: 0,
        args: { query: 'Apple' },
      },
      state,
    );

    expect(plan[0]?.event).toBe('on_run_step');
    expect(plan[1]).toEqual({
      event: 'on_reasoning_delta',
      data: {
        id: 'semaa_run-1_reasoning_plan',
        delta: {
          content: [{ type: ContentTypes.THINK, think: 'I will search the web.' }],
        },
      },
    });
    expect(tool[0]?.data).toMatchObject({ index: 1, id: 'semaa_run-1_0' });
  });

  it('places reflection before the final answer step', () => {
    const state = createSemaaAdapterState();
    transformSemaaEvent(
      { type: 'reasoning.delta', runId: 'run-1', phase: 'plan', content: 'Planning.' },
      state,
    );
    transformSemaaEvent(
      { type: 'tool.started', runId: 'run-1', toolName: 'web.search', toolIndex: 0 },
      state,
    );
    transformSemaaEvent(
      { type: 'tool.completed', runId: 'run-1', toolName: 'web.search', toolIndex: 0, output: 'ok' },
      state,
    );
    const reflect = transformSemaaEvent(
      { type: 'reasoning.delta', runId: 'run-1', phase: 'reflect', content: 'Reviewing results.' },
      state,
    );
    const answer = transformSemaaEvent(
      { type: 'answer.delta', runId: 'run-1', content: 'Final answer.' },
      state,
    );

    expect(reflect[0]?.data).toMatchObject({ index: 2, id: 'semaa_run-1_reasoning_reflect' });
    expect(answer[0]?.data).toMatchObject({ index: 3, id: 'semaa_run-1_answer' });
  });
});
