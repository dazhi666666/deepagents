/** Human-readable report built only from terminal public metrics, never evaluator targets. */
export function renderV05Report(input: { score: number; maximum: number; components: Record<string, number>;
  tasks: Record<string, { score: number; maximum: number }>; calibrationStatus: string; usage: unknown }) {
  return '# Mars v0.5 运行报告\n\n' +
    `总分：${input.score.toFixed(3)} / ${input.maximum}。配置状态：${input.calibrationStatus}。\n\n` +
    '分数描述此配置下的实际结果；模型试验、跨场景泛化和成本配平结论需独立运行支持。\n\n' +
    '| 分项 | 得分 |\n|---|---:|\n' + Object.entries(input.components).map(([id, score]) => `| ${id} | ${score.toFixed(3)} |`).join('\n') +
    '\n\n| 科研任务 | 得分 | 最高分 |\n|---|---:|---:|\n' + Object.entries(input.tasks).map(([id, task]) => `| ${id} | ${task.score.toFixed(3)} | ${task.maximum.toFixed(3)} |`).join('\n') +
    '\n\n成本统计：\n\n```json\n' + JSON.stringify(input.usage, null, 2) + '\n```\n'
}
