// Tools that let a bot manage its own routines from the chat ("every weekday at 8, brief me").
// Creating and deleting ask first by default: a routine spends model turns while nobody watches.
// A bot only sees and changes its own routines.

import { z } from 'zod'
import { MIN_ROUTINE_INTERVAL_MINUTES, type Routine, type RoutineSchedule } from '@shared/domain'
import { describeSchedule, EVERY_DAY } from '@shared/routines'
import type { RoutineService } from '../contracts'
import { defineTool, errorResult, textResult, type PlatformToolDefinition } from '../tools/define'

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const scheduleSchema = z
  .object({
    every_minutes: z
      .number()
      .int()
      .min(MIN_ROUTINE_INTERVAL_MINUTES)
      .optional()
      .describe(`Run every N minutes (at least ${MIN_ROUTINE_INTERVAL_MINUTES}). 60 = hourly.`),
    at: z.string().optional().describe('Run at this local time, 24-hour HH:MM, e.g. "08:00".'),
    days: z
      .array(z.enum(DAY_NAMES))
      .optional()
      .describe('With "at": the days to run on. Leave out for every day. Weekdays = mon..fri.')
  })
  .describe('Give either every_minutes, or at (with optional days). Leave both out for a routine that only runs when started.')

type ScheduleInput = z.infer<typeof scheduleSchema>

export function toSchedule(input: ScheduleInput): RoutineSchedule {
  if (input.every_minutes !== undefined && input.at !== undefined) throw new Error('Give either every_minutes or at, not both.')
  if (input.every_minutes !== undefined) return { kind: 'interval', everyMinutes: input.every_minutes }
  if (input.at !== undefined) {
    const days = input.days?.length ? input.days.map((d) => DAY_NAMES.indexOf(d)) : EVERY_DAY
    return { kind: 'daily', time: input.at, days }
  }
  return { kind: 'manual' }
}

function line(r: Routine): string {
  const next = r.enabled && r.nextRunAt ? `, next ${new Date(r.nextRunAt).toLocaleString()}` : r.enabled ? '' : ', paused'
  const webhook = r.enabled && r.webhookEnabled && r.hasWebhookToken ? ', webhook configured' : ''
  return `- ${r.name} (id ${r.id}): ${describeSchedule(r.schedule)}${next}${webhook}. Task: ${r.prompt.replace(/\s+/g, ' ').slice(0, 200)}`
}

export function routineTools(routines: Pick<RoutineService, 'list' | 'save' | 'delete'>): PlatformToolDefinition[] {
  const createRoutine = defineTool({
    name: 'create_routine',
    description:
      'Schedule a task you will do on your own later, repeatedly: a morning brief, an hourly check, a weekly report. ' +
      'Each run posts the task in your chat with the user and you answer it with your tools. Write the task so it ' +
      'stands on its own: on a run you only see your chat history, memory and skills. The user approves new routines.',
    schema: z.object({
      name: z.string().min(1).max(80).describe('Short name, e.g. "Morning brief"'),
      task: z.string().min(1).max(8000).describe('What to do on every run, complete and self-contained'),
      schedule: scheduleSchema
    }),
    source: 'faibots',
    defaultPermission: 'ask',
    activityLabel: 'Scheduling a routine',
    summarize: (input) => {
      let when = 'only when started'
      try {
        when = describeSchedule(toSchedule(input.schedule))
      } catch {
        // The execute step reports the problem.
      }
      return `Create the routine “${input.name}” (${when}): ${input.task.slice(0, 300)}`
    },
    async execute(input, ctx) {
      try {
        const routine = routines.save({ botId: ctx.bot.id, name: input.name, prompt: input.task, schedule: toSchedule(input.schedule) }, 'bot')
        const next = routine.nextRunAt ? ` The first run is ${new Date(routine.nextRunAt).toLocaleString()}.` : ''
        return textResult(`Created the routine “${routine.name}”: ${describeSchedule(routine.schedule)}.${next} The user can change or pause it in your Routines tab.`)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err))
      }
    }
  })

  const listRoutines = defineTool({
    name: 'list_routines',
    description: 'List your routines: their schedule, next run and task.',
    schema: z.object({}),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Checking routines',
    async execute(_input, ctx) {
      const mine = routines.list(ctx.bot.id)
      return textResult(mine.length === 0 ? 'You have no routines.' : `Your routines:\n${mine.map(line).join('\n')}`)
    }
  })

  const deleteRoutine = defineTool({
    name: 'delete_routine',
    description: 'Delete one of your routines by its id (see list_routines). Its run history goes with it.',
    schema: z.object({ id: z.string().min(1).describe('The routine id') }),
    source: 'faibots',
    defaultPermission: 'ask',
    activityLabel: 'Deleting a routine',
    summarize: (input, ctx) => {
      const r = routines.list(ctx.bot.id).find((x) => x.id === input.id)
      return r ? `Delete the routine “${r.name}” (${describeSchedule(r.schedule)})` : `Delete routine ${input.id}`
    },
    async execute(input, ctx) {
      const r = routines.list(ctx.bot.id).find((x) => x.id === input.id)
      if (!r) return errorResult('You have no routine with that id. Use list_routines to see them.')
      routines.delete(r.id)
      return textResult(`Deleted the routine “${r.name}”.`)
    }
  })

  return [createRoutine, listRoutines, deleteRoutine]
}
