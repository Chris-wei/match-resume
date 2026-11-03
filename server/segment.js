// 步骤②：把纯文本简历切成可寻址的 S1..Sn 片段（移植自 resume-matcher src/segment.ts）。
// 一行一个片段；章节标题不占编号，只给后续片段打 section 标签。

const HEADINGS = {
  summary: 'summary',
  profile: 'summary',
  about: 'summary',
  '个人总结': 'summary',
  '个人简介': 'summary',
  experience: 'experience',
  'work experience': 'experience',
  'professional experience': 'experience',
  employment: 'experience',
  '工作经历': 'experience',
  '工作经验': 'experience',
  education: 'education',
  '教育背景': 'education',
  '教育经历': 'education',
  projects: 'projects',
  '项目经历': 'projects',
  '项目经验': 'projects',
  skills: 'skills',
  'technical skills': 'skills',
  '专业技能': 'skills',
  '技能': 'skills',
  certifications: 'certifications',
  '证书': 'certifications'
}

function headingOf(line) {
  const key = line.replace(/[:：]$/, '').trim().toLowerCase()
  return HEADINGS[key]
}

function segmentResume(text) {
  const spans = []
  let section = 'header'
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•▪◦·]|\d+[.)])\s+/, '').trim()
    if (!line) continue
    const heading = headingOf(line)
    if (heading) {
      section = heading
      continue
    }
    spans.push({ id: 'S' + (spans.length + 1), section, text: line })
  }
  return spans
}

/** 渲染给 LLM 看的片段清单：[S12] (experience) 负责后端服务开发…… */
function renderSpans(spans) {
  return spans.map((s) => `[${s.id}] (${s.section}) ${s.text}`).join('\n')
}

module.exports = { segmentResume, renderSpans }
