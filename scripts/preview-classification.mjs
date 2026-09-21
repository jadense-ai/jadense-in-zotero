/** 仅浏览器合成分类 fixture；通过 ?classification=1 注入独立分类页，不访问 TypeSafe。 */
/* global window, document */
export function installClassificationPreview() {
  if (window.location.pathname !== '/classification.xhtml' && !new URLSearchParams(window.location.search).has('classification')) return
  const host = window.Zotero, originalGet = host.Items.get, originalFetch = window.fetch.bind(window)
  const folders = [
    { id: 101, key: 'AEROSOL', libraryID: 1, name: 'Aerosol' },
    { id: 102, key: 'INVERSE', libraryID: 1, name: '反演', parentID: 101 },
    { id: 103, key: 'AERONET', libraryID: 1, name: 'AERONET', parentID: 102 },
    { id: 104, key: 'GPT', libraryID: 1, name: 'GPT' },
    { id: 105, key: 'READING', libraryID: 1, name: '待读 / 待核对' },
  ]
  const titles = ['Accuracy assessment of aerosol optical properties retrieved from Aerosol Robotic Network (AERONET) Sun and sky radiance measurements', 'On the general theory of control systems', 'Detecting hallucinations in large language models using semantic entropy']
  const papers = titles.map((title, i) => {
    let memberships = [105]
    return { id: 201 + i, key: `PAPER${i}`, libraryID: 1, isRegularItem: () => true, isEditable: () => true,
      getField: field => field === 'title' ? title : 'Synthetic abstract', getTags: () => [],
      getCollections: () => [...memberships], setCollections: ids => { memberships = [...ids] }, saveTx: async () => {}, reload: async () => {} }
  })
  host.Items.get = id => papers.find(paper => paper.id === Number(id)) || originalGet(id)
  host.Collections.getByLibrary = () => folders
  host.Prefs.set('extensions.jadenseInZotero.typesafeApiKey', 'synthetic-classification-key-not-a-credential', true)
  window.JadenseClassification = { zotero: host, itemIDs: papers.map(paper => paper.id), openSettings: () => window.open('/manager.xhtml?section=settings-features', '_blank') }
  let mode = 'success'
  window.fetch = async (url, init) => {
    if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, init)
    if (mode === 'error') return new Response('synthetic error', { status: 401 })
    if (mode === 'slow') await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000)
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
    const body = JSON.parse(init.body), criteria = body.questions.classification.criteria
    const preferred = body.state.title.includes('aerosol') ? 'collection_103' : body.state.title.includes('hallucinations') ? 'collection_104' : 'none'
    const choice = criteria.research ? 'research' : Object.hasOwn(criteria, preferred) ? preferred : 'none'
    return new Response(JSON.stringify({ answers: { classification: { type: 'choice', choice, confidence: choice === 'none' ? .96 : choice === 'collection_103' ? .70 : .47 } }, future: true }))
  }
  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.getElementById('fixture-counters')?.parentElement || document.body
    for (const value of ['success', 'error', 'slow']) {
      const button = document.createElement('button'); button.textContent = `分类 ${value}`
      button.onclick = () => { mode = value; window.receiveClassificationItems?.(papers.map(paper => paper.id)) }
      bar.append(button)
    }
  }, { once: true })
}
