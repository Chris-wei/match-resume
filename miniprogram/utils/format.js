// 小工具：时间格式化等。

function formatDate(d) {
  const date = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const VERDICT_TEXT = {
  hit: '满足',
  partial: '部分满足',
  miss: '缺失',
  unclear: '无法确认'
}

const CATEGORY_TEXT = {
  skills: '技能',
  experience: '经验',
  projects: '项目',
  education: '学历',
  keywords: '加分项'
}

/** 分数档位：与报告页配色一致（≥75 高 / ≥55 中 / 其余低） */
function scoreLevel(score) {
  if (score >= 75) return 'high'
  if (score >= 55) return 'mid'
  return 'low'
}

const LEVEL_COLOR = { high: '#12a150', mid: '#d97706', low: '#e5484d' }

module.exports = { formatDate, scoreLevel, LEVEL_COLOR, VERDICT_TEXT, CATEGORY_TEXT }
