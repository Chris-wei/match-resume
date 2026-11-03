// 一句话结论（截图第一版清单：总分大数字 + 一句话结论）。
// 纯模板、确定性生成，不调模型——与确定性打分同一哲学。

const LABELS = {
  skills: '技能',
  experience: '经验',
  projects: '项目',
  education: '学历',
  keywords: '加分项'
}

function conclude(score, requirements, judgments) {
  const { overall, capped, radar } = score
  const misses = judgments.filter((j) => j.verdict === 'miss')
  const weakest = radar
    .filter((r) => r.count > 0)
    .sort((a, b) => a.value - b.value)[0]
  const topMissReq = misses.length
    ? requirements
        .filter((r) => misses.some((m) => m.reqId === r.id))
        .sort((a, b) => b.weight - a.weight)[0]
    : null

  let text
  if (overall >= 75) {
    text = topMissReq
      ? `匹配度较高，但还缺「${topMissReq.text}」，补上会更稳。`
      : '匹配度较高，简历与这份职位要求吻合良好，可以放心投递。'
  } else if (overall >= 55) {
    text =
      `匹配度中等${weakest ? `，短板在${LABELS[weakest.category] || weakest.category}` : ''}` +
      `${topMissReq ? `；优先补上「${topMissReq.text}」` : ''}，参考下方改写建议调整后再投。`
  } else {
    text = topMissReq
      ? `与该职位差距较大，缺少「${topMissReq.text}」等 ${misses.length} 项要求，建议按改写建议逐条补强。`
      : '匹配度偏低，建议对照逐条判定调整简历后再投。'
  }
  if (capped) text += '注意：存在硬性年限要求缺失，通过初筛的概率会受影响。'
  return text
}

module.exports = { conclude, LABELS }
