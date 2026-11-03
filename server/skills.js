// 技能别名表（种子版）：规范化技能名 + 检索时按别名扩召回。
// 上线后按实际 JD 高频技能补充。
const { normalize, containsTerm } = require('./text')

const SYNONYMS = {
  javascript: ['js', 'ecmascript'],
  typescript: ['ts'],
  'node.js': ['node', 'nodejs'],
  react: ['react.js', 'reactjs'],
  vue: ['vue.js', 'vuejs'],
  kubernetes: ['k8s', '容器编排'],
  docker: ['容器化'],
  postgresql: ['postgres', 'psql'],
  mysql: ['关系型数据库'],
  redis: ['缓存'],
  'amazon web services': ['aws'],
  'google cloud': ['gcp', 'google cloud platform'],
  'machine learning': ['ml', '机器学习'],
  'deep learning': ['dl', '深度学习'],
  'ci/cd': ['cicd', 'continuous integration', 'continuous delivery', '持续集成'],
  golang: ['go', 'go语言'],
  python: ['py', 'python语言'],
  'spring boot': ['springboot', 'spring'],
  '微服务': ['microservice', 'microservices'],
  '大模型': ['llm', 'large language model'],
  kafka: ['消息队列', 'mq']
}

const ALIAS_TO_CANONICAL = new Map()
for (const canonical of Object.keys(SYNONYMS)) {
  ALIAS_TO_CANONICAL.set(canonical, canonical)
  for (const a of SYNONYMS[canonical]) ALIAS_TO_CANONICAL.set(a, canonical)
}

function canonicalSkill(name) {
  const n = normalize(name)
  return ALIAS_TO_CANONICAL.get(n) || n
}

function aliasesOf(name) {
  const canonical = canonicalSkill(name)
  return [canonical, ...(SYNONYMS[canonical] || [])]
}

module.exports = { canonicalSkill, aliasesOf, SYNONYMS }
