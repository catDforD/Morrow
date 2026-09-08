export default function projectStats(ctx) {
  ctx.morrow.tool({
    name: 'project_stats', description: 'Count top-level workspace files and their UTF-8 text lines.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, approval: false,
  }, async (_input, run) => {
    const { files } = await run.tool('list_files', { path: '.' })
    let lines = 0
    const readable = files.filter(file => !file.directory && /\.(txt|rs|ts|md)$/.test(file.name))
    for (const file of readable) {
      const { content } = await run.tool('read_file', { path: file.name })
      lines += content.split('\n').filter(Boolean).length
    }
    const state = { files: files.filter(file => !file.directory).length, lines, runs: ((await run.state('stats'))?.runs ?? 0) + 1 }
    await run.setState('stats', state)
    return state
  })
  ctx.morrow.method('stats.get', (_input, run) => run.state('stats'))
}
