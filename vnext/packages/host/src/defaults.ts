import type { Context, RunContext, RequestHeader, Message } from '@morrow/sdk'
import { text } from '@morrow/sdk'

const parameters = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export function builtin(ctx: Context) {
  for (const [name, description, schema, approval] of [
    ['read_file', 'Read a UTF-8 file in the workspace (up to 1 MB).', parameters({ path: { type: 'string' } }, ['path']), false],
    ['list_files', 'List one workspace directory.', parameters({ path: { type: 'string' } }), false],
    ['write_file', 'Write a workspace file after user approval.', parameters({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']), true],
    ['edit_file', 'Replace exactly one occurrence in a workspace file.', parameters({ path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']), true],
    ['shell', 'Run a shell command after user approval.', parameters({ command: { type: 'string' }, timeout_seconds: { type: 'integer' } }, ['command']), true],
  ] as const) ctx.morrow.tool({ name, description, parameters: schema, approval }, () => { throw new Error('builtin is executed by Rust') })
}

export function agent(ctx: Context) {
  ctx.morrow.driver('default', { async run(run) {
    for (let step = 0; step < 32; step++) {
      run.signal.throwIfAborted()
      await run.beginStep()
      const preparation = await run.prepare({ header: {
        provider: 'openai-chat', model: run.modelName, system: '', parameters: {}, ...run.defaults, tools: run.tools,
      }, temporary: [] })
      let message: Message
      try { message = await run.model(preparation.header, { temporary: preparation.temporary }) }
      catch (error) {
        // A bounded context retry must first replace a real, balanced range.
        if ((error as { code?: string }).code !== 'context_length') throw error
        const retry_of = run.lastRequest!
        const changed = await compact(run, preparation.header, 2)
        if (!changed) throw error
        message = await run.model(preparation.header, { temporary: preparation.temporary, retry_of })
      }
      await Promise.all(message.tool_calls.map(async call => {
        let output: unknown
        try { output = await run.tool(call.name, call.arguments, call.id) }
        catch (error) { run.signal.throwIfAborted(); output = { error: String(error) } }
        await run.settle(call.id, output)
      }))
      await run.endStep()
      if (!message.tool_calls.length) return
    }
    throw new Error('agent step limit reached (32)')
  } })
  ctx.morrow.policy('10-prompt', async (_run, preparation, next) => {
    preparation.header.system = 'You are Morrow, a coding agent. Use tools to inspect and change the workspace. Preserve user work. You can define session plugins with plugin_define; ask the user to review and trust the exact source version before activation. Tool and model outcomes marked unknown must never be assumed rolled back.'
    await next()
  })
  ctx.morrow.policy('90-compaction', async (run, preparation, next) => {
    await next()
    const state = await run.snapshot()
    const size = state.surface.reduce((size, id) => size + JSON.stringify(state.nodes[id].message).length, 0)
    if (size > 60_000) await compact(run, preparation.header, 4)
  })
  ctx.morrow.tool({ name: 'plugin_define', description: 'Define an immutable session plugin. Returns a version hash for user review/trust; does not execute its source. Host ESM exports default Cordis plugin(ctx) and uses ctx.morrow.tool/model/driver/policy/method. Client exports default(ctx) and uses ctx.ui.panel/page/renderer. No dependencies: set dependency_lock to "{}"; otherwise supply a prebundled artifact and its lock.', parameters: parameters({ name: { type: 'string' }, description: { type: 'string' }, host: { type: 'string' }, client: { type: ['string', 'null'] }, dependency_lock: { type: 'string' } }, ['name', 'description', 'host', 'dependency_lock']), approval: false }, (input, run) => run.define({ ...input, client: input.client ?? null }))
  ctx.morrow.tool({ name: 'plugin_activate', description: 'Activate a trusted session plugin version at the next step boundary.', parameters: parameters({ hash: { type: 'string' } }, ['hash']), approval: false }, (input, run) => run.activate(input.hash))
  ctx.morrow.tool({ name: 'subagent', description: 'Run an isolated child agent with inherited trusted bindings. The child cannot mutate the parent session.', parameters: parameters({ prompt: { type: 'string' } }, ['prompt']), approval: false }, (input, run) => run.subagent(input.prompt))
}

export async function compact(run: RunContext, header: RequestHeader, keep: number): Promise<boolean> {
  const state = await run.snapshot()
  if (state.surface.length <= keep + 1) return false
  // Advance to a balanced boundary; no request may cut an assistant/tool group.
  const pending = new Set<string>()
  let end = 0
  for (let i = 0; i < state.surface.length - keep; i++) {
    const message = state.nodes[state.surface[i]].message
    for (const call of message.tool_calls) pending.add(call.id)
    if (message.tool_call_id) pending.delete(message.tool_call_id)
    if (pending.size === 0) end = i + 1
  }
  if (end < 2) return false
  const surface = state.surface.slice(0, end)
  const summary = await run.model({ ...header, tools: [], system: 'Summarize this conversation for continuation. Preserve user intent, decisions, changed files, tool outcomes, unresolved work and uncertainty. Return a factual summary only.' }, { purpose: 'summary', surface })
  await run.replace(state.revision, surface[0], surface.at(-1)!, text('user', `Earlier conversation summary:\n${summary.content}`), run.lastRequest!)
  return true
}
