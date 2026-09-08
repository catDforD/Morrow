export default function projectStatsPanel(ctx) {
  const React = ctx.ui.react
  ctx.ui.panel('项目文件统计', ({ state }) => {
    const stats = state.stats
    return React.createElement('div', { 'data-testid': 'project-stats' }, stats
      ? `${stats.files} files · ${stats.lines} lines · ${stats.runs} runs`
      : '等待运行 project_stats 工具')
  })
}
