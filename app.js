const SUPABASE_URL  = 'https://kygpjnsqzhfcndqyuibw.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5Z3BqbnNxemhmY25kcXl1aWJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExOTE1NjQsImV4cCI6MjA5Njc2NzU2NH0.jleHUTbWqeLT-XaKn3975-odx3thNIxDqra7RJ8Mc3A'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT',
             'PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']

let histChart = null
let precosTodos = []
let medidas = []
let marcas = []
let precosRaw = []
let csvRows = []
let cadTimeout = null
let cruzIndex = null
let cruzResultados = []

// ─── AUTH ────────────────────────────────────────────────────────────────────

db.auth.onAuthStateChange((event, session) => {
  if (session) {
    document.getElementById('login-screen').classList.add('hidden')
    document.getElementById('app').classList.remove('hidden')
    document.getElementById('user-email').textContent = session.user.email
    initApp()
  } else {
    document.getElementById('login-screen').classList.remove('hidden')
    document.getElementById('app').classList.add('hidden')
  }
})

// ─── PROTEÇÃO DE LOGIN (rate limiting no cliente) ─────────────────────────────
// Trava o botão após várias falhas, com espera crescente. O Supabase Auth também
// aplica limite no servidor — isto é uma camada extra contra força-bruta casual.
const LOGIN_MAX = 5
const LOGIN_LOCK_BASE = 30000            // 30s; dobra a cada falha extra (teto 10 min)
let loginFails = Number(localStorage.getItem('mira-login-fails') || 0)
let lockTimer = null

function loginLockMs() {
  return Math.max(0, Number(localStorage.getItem('mira-lock-until') || 0) - Date.now())
}

function atualizaTrava() {
  const btn = document.getElementById('login-btn')
  const err = document.getElementById('login-error')
  const ms = loginLockMs()
  if (ms <= 0) {
    if (lockTimer) { clearInterval(lockTimer); lockTimer = null }
    btn.disabled = false
    btn.textContent = 'Entrar'
    return false
  }
  btn.disabled = true
  btn.textContent = `Aguarde ${Math.ceil(ms / 1000)}s`
  err.textContent = 'Muitas tentativas. Aguarde antes de tentar de novo.'
  err.classList.remove('hidden')
  if (!lockTimer) lockTimer = setInterval(atualizaTrava, 1000)
  return true
}
atualizaTrava()  // reaplica a trava se a página recarregar durante o bloqueio

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault()
  if (atualizaTrava()) return            // bloqueado: nem tenta autenticar

  const btn = document.getElementById('login-btn')
  const err = document.getElementById('login-error')
  btn.textContent = 'Entrando...'
  btn.disabled = true
  err.classList.add('hidden')

  const { error } = await db.auth.signInWithPassword({
    email: document.getElementById('login-email').value,
    password: document.getElementById('login-password').value
  })

  if (error) {
    loginFails++
    localStorage.setItem('mira-login-fails', loginFails)
    if (loginFails >= LOGIN_MAX) {
      const dur = Math.min(LOGIN_LOCK_BASE * 2 ** (loginFails - LOGIN_MAX), 600000)
      localStorage.setItem('mira-lock-until', Date.now() + dur)
      atualizaTrava()
    } else {
      err.textContent = `E-mail ou senha incorretos (${LOGIN_MAX - loginFails} tentativa(s) restante(s))`
      err.classList.remove('hidden')
      btn.textContent = 'Entrar'
      btn.disabled = false
    }
  } else {
    loginFails = 0
    localStorage.removeItem('mira-login-fails')
    localStorage.removeItem('mira-lock-until')
  }
})

document.getElementById('logout-btn').addEventListener('click', () => db.auth.signOut())

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'))
    item.classList.add('active')
    document.getElementById('tab-' + tab).classList.add('active')
    if (tab === 'precos')   loadPrecos()
    if (tab === 'historico') loadHistMedidas()
    if (tab === 'catalogo') loadCatalogo()
  })
})

// ─── TEMA ─────────────────────────────────────────────────────────────────────

const themeBtn = document.getElementById('theme-toggle')

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('mira-theme', t)
  if (themeBtn) themeBtn.textContent = t === 'light' ? 'Tema escuro' : 'Tema claro'
}

applyTheme(localStorage.getItem('mira-theme') || 'light')

themeBtn?.addEventListener('click', () => {
  const atual = document.documentElement.getAttribute('data-theme')
  applyTheme(atual === 'light' ? 'dark' : 'light')
})

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function initApp() {
  populateUFSelects()
  await Promise.all([loadComparativo(), loadCatalogo()])
}

function populateUFSelects() {
  const ids = ['comp-uf', 'cruz-uf', 'fp-uf', 'fc-uf']
  ids.forEach(id => {
    const el = document.getElementById(id)
    if (!el) return
    UFS.forEach(uf => {
      const o = document.createElement('option')
      o.value = o.textContent = uf
      el.appendChild(o)
    })
  })
}

// ─── TOAST ────────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = 'toast ' + type
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 3500)
}

// ─── MODAIS ──────────────────────────────────────────────────────────────────

function openModal(id) { document.getElementById(id).classList.remove('hidden') }

document.querySelectorAll('.modal-close, button[data-modal]').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.closest('.modal')?.id || el.dataset.modal
    if (id) document.getElementById(id).classList.add('hidden')
  })
})

document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', () => o.closest('.modal').classList.add('hidden'))
})

// ─── HELPERS DE EXIBIÇÃO (compartilhados Comparativo + Cruzamento) ───────────

const fmtBRL     = v => v != null ? 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '-'
const fmtData    = d => d ? d.split('-').reverse().join('/') : '—'
const fmtDataMut = d => `<span style="color:var(--text-muted);font-size:11px">${fmtData(d)}</span>`
const fmtGap     = g => (g === null || g === undefined) ? '-' : (g > 0 ? '+' : '') + g + '%'
const gapColor   = g => g > 1 ? 'var(--danger)' : 'var(--success)'

// linha-detalhe (preço a preço) usada nas duas abas; espera { detalhes, qtd, medio, gapMedio }
function detalhePrecoAPreco(d, domId) {
  const linhas = d.detalhes.map((c, j) => {
    const tag = j === 0 ? '<span class="badge badge-competitivo" style="margin-left:6px">menor</span>'
              : j === d.detalhes.length - 1 ? '<span class="badge badge-caro" style="margin-left:6px">maior</span>' : ''
    return `<tr>
      <td>${fmtBRL(c.preco)}${tag}</td>
      <td>${c.marca}</td>
      <td>${c.fornecedor}</td>
      <td>${c.uf}</td>
      <td>${fmtDataMut(c.data)}</td>
      <td style="font-weight:600;color:${gapColor(c.gap)}">${fmtGap(c.gap)}</td>
    </tr>`
  }).join('')
  return `<tr class="detail-row" id="${domId}" style="display:none">
    <td colspan="9" class="detail-cell">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
        Comparação preço a preço — ${d.qtd} concorrente(s) · média ${fmtBRL(d.medio)} (${fmtGap(d.gapMedio)})
      </div>
      <table class="data-table" style="margin:0">
        <thead><tr><th>Preço Conc.</th><th>Marca</th><th>Fornecedor</th><th>UF</th><th>Data</th><th>Gap (meu vs esse)</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </td>
  </tr>`
}

function toggleDetail(domId) {
  const row = document.getElementById(domId)
  if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none'
}

// ─── COMPARATIVO ─────────────────────────────────────────────────────────────

async function loadComparativo() {
  const { data } = await db.from('precos').select('*').order('data', { ascending: false })
  precosTodos = data || []
  cruzIndex = null
  renderKPIs()
  renderComparativo()
}

function renderKPIs() {
  const medSet = new Set(precosTodos.map(p => p.medida))
  const meus = precosTodos.filter(p => p.origem === 'Meu').length
  const conc = precosTodos.filter(p => p.origem === 'Concorrente').length

  const kpis = [
    { label: 'Registros',  value: precosTodos.length },
    { label: 'Medidas',    value: medSet.size },
    { label: 'Meus Preços', value: meus },
    { label: 'Concorrência', value: conc },
    { label: 'Comparações', value: buildComparativoData().length },
  ]

  const el = document.getElementById('kpis')
  el.innerHTML = kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value.toLocaleString('pt-BR')}</div>
    </div>
  `).join('')

  db.from('cadastro').select('id', { count: 'exact', head: true }).then(({ count }) => {
    if (count !== null) {
      el.innerHTML += `
        <div class="kpi-card">
          <div class="kpi-label">Cadastros</div>
          <div class="kpi-value">${count.toLocaleString('pt-BR')}</div>
        </div>`
    }
  })
}

function normMedida(m) {
  return (m || '').toUpperCase().replace(/\s+/g, '')
}

// Forma canônica de exibição/gravação: "185/60 R15" (espaço antes do R)
function medidaCanonica(m) {
  return normMedida(m).replace(/R(\d)/g, ' R$1')
}

// Título (primeira maiúscula por palavra) — padrão de marcas/empresas
function tituloCase(s) {
  return (s || '').trim().toLowerCase().replace(/(^|[\s\-/(.])([a-zà-ÿ])/g, (_, p, c) => p + c.toUpperCase())
}

// Mais recente vence; empate de data → prioriza Lista de Preço (RN-01)
function meuMaisRelevante(p, atual) {
  if (!atual) return true
  if (p.data > atual.data) return true
  if (p.data === atual.data && p.fonte === 'Lista de Preço' && atual.fonte !== 'Lista de Preço') return true
  return false
}

// Cruza por medida normalizada + UF; usa preço mais recente de cada lado
function buildComparativoData() {
  const grp = {}
  for (const p of precosTodos) {
    const norm = p.medida_norm || normMedida(p.medida)
    const uf   = p.uf || 'Não Informado'
    const key  = norm + '|' + uf
    if (!grp[key]) grp[key] = { uf, label: null, categoria: null, meu: null, conc: [] }
    const g = grp[key]
    if (!g.categoria && p.categoria) g.categoria = p.categoria

    if (p.origem === 'Meu') {
      if (!g.label) g.label = p.medida
      if (meuMaisRelevante(p, g.meu)) g.meu = p
    } else {
      g.conc.push(p)
      if (!g.label) g.label = p.medida
    }
  }

  const linhas = []
  for (const key in grp) {
    const g = grp[key]
    if (!g.conc.length) continue   // Comparativo só mostra onde há concorrente p/ comparar

    const precos    = g.conc.map(c => Number(c.preco))
    const menorConc = Math.min(...precos)
    const maiorConc = Math.max(...precos)
    const medioConc = precos.reduce((a, b) => a + b, 0) / precos.length
    const dataConc  = g.conc.reduce((d, c) => (c.data && c.data > d ? c.data : d), g.conc[0].data || '')

    const meuPreco = g.meu ? Number(g.meu.preco) : null
    const meuData  = g.meu ? g.meu.data : null
    const posicao  = calcPosicao(meuPreco, menorConc)
    const gap      = meuPreco && menorConc ? ((meuPreco - menorConc) / menorConc * 100).toFixed(1) : null
    const gapMedio = meuPreco && medioConc ? ((meuPreco - medioConc) / medioConc * 100).toFixed(1) : null

    const detalhes = g.conc.map(c => {
      const preco = Number(c.preco)
      return {
        preco, fornecedor: c.fornecedor || '—', marca: c.marca || '—', uf: c.uf || '—', data: c.data,
        gap: meuPreco ? ((meuPreco - preco) / preco * 100).toFixed(1) : null
      }
    }).sort((a, b) => a.preco - b.preco)

    linhas.push({
      medida: g.label, uf: g.uf, categoria: g.categoria,
      meuPreco, meuData, menorConc, medioConc, maiorConc, gapMedio,
      dataConc, qtdConc: g.conc.length, posicao, gap, detalhes
    })
  }
  return linhas
}

// RN-02: até 1% acima do menor (ou abaixo) = Competitivo; passou de 1% pra cima = Acima
function calcPosicao(meu, menor) {
  if (!meu || !menor) return '-'
  const diff = (meu - menor) / menor
  return diff <= 0.01 ? 'Competitivo' : 'Acima'
}

function renderComparativo() {
  const q   = document.getElementById('comp-search').value.toLowerCase()
  const pos = document.getElementById('comp-posicao').value
  const uf  = document.getElementById('comp-uf').value

  let dados = buildComparativoData()
  if (uf)  dados = dados.filter(d => d.uf === uf)
  if (q)   dados = dados.filter(d => d.medida.toLowerCase().includes(q))
  if (pos) dados = dados.filter(d => d.posicao === pos)
  dados.sort((a, b) => a.medida.localeCompare(b.medida) || a.uf.localeCompare(b.uf))

  document.getElementById('comp-tbody').innerHTML = dados.length
    ? dados.map((d, i) => {
        const resumo = `<tr style="cursor:pointer" onclick="toggleDetail('comp-det-${i}')">
          <td><strong>${d.medida}</strong> <span style="color:var(--text-muted);font-size:11px">▸</span></td>
          <td>${d.uf}</td>
          <td>${d.meuPreco ? fmtBRL(d.meuPreco) + '<br>' + fmtDataMut(d.meuData) : '<span style="color:var(--text-muted)">sem preço meu</span>'}</td>
          <td>${fmtBRL(d.menorConc)}</td>
          <td>${fmtBRL(d.medioConc)}</td>
          <td>${fmtBRL(d.maiorConc)}</td>
          <td style="font-weight:600;color:${gapColor(d.gap)}">${fmtGap(d.gap)}</td>
          <td>${badgePosicao(d.posicao)}</td>
          <td>${fmtDataMut(d.dataConc)} <span style="color:var(--text-muted);font-size:11px">(${d.qtdConc})</span></td>
        </tr>`
        const detalhe = detalhePrecoAPreco({ detalhes: d.detalhes, qtd: d.qtdConc, medio: d.medioConc, gapMedio: d.gapMedio }, 'comp-det-' + i)
        return resumo + detalhe
      }).join('')
    : '<tr><td colspan="9" class="empty-state" style="padding:48px">Nenhum dado encontrado</td></tr>'
}

function badgePosicao(p) {
  if (p === 'Competitivo') return '<span class="badge badge-competitivo">Competitivo</span>'
  if (p === 'Atenção')     return '<span class="badge badge-atencao">Atenção</span>'
  if (p === 'Acima')       return '<span class="badge badge-caro">Acima</span>'
  return '<span style="color:var(--text-muted)">—</span>'
}

document.getElementById('comp-search').addEventListener('input', renderComparativo)
document.getElementById('comp-uf').addEventListener('change', renderComparativo)
document.getElementById('comp-posicao').addEventListener('change', renderComparativo)

// ─── CRUZAMENTO ──────────────────────────────────────────────────────────────

// Índice concorrente por medida normalizada (cacheado; invalidado em loadComparativo)
function buildConcIndex() {
  const idx = {}
  for (const p of precosTodos) {
    if (p.origem !== 'Concorrente') continue
    const k = p.medida_norm || normMedida(p.medida)
    ;(idx[k] = idx[k] || []).push(p)
  }
  return idx
}

// uf vazio = cruza com todos os estados
function cruzarLinha(medida, uf, meuPreco) {
  if (!cruzIndex) cruzIndex = buildConcIndex()
  let conc = cruzIndex[normMedida(medida)] || []
  if (uf) conc = conc.filter(c => c.uf === uf)

  // detalhe preço a preço, do mais barato ao mais caro, com gap do meu preço vs cada um
  const detalhes = conc.map(c => {
    const preco = Number(c.preco)
    return {
      preco,
      fornecedor: c.fornecedor || '—',
      marca: c.marca || '—',
      uf: c.uf || '—',
      data: c.data,
      gap: meuPreco ? ((meuPreco - preco) / preco * 100).toFixed(1) : null
    }
  }).sort((a, b) => a.preco - b.preco)

  const precos = detalhes.map(d => d.preco)
  const menor  = precos.length ? precos[0] : null
  const maior  = precos.length ? precos[precos.length - 1] : null
  const medio  = precos.length ? precos.reduce((a, b) => a + b, 0) / precos.length : null
  const dataRef = conc.length ? conc.reduce((d, c) => (c.data && c.data > d ? c.data : d), conc[0].data || '') : null
  const posicao = calcPosicao(meuPreco, menor)
  const gap    = meuPreco && menor ? ((meuPreco - menor) / menor * 100).toFixed(1) : null
  const gapMedio = meuPreco && medio ? ((meuPreco - medio) / medio * 100).toFixed(1) : null
  return { medida, uf: uf || 'Todas', meuPreco, menor, medio, maior, gapMedio, dataRef, qtd: conc.length, posicao, gap, detalhes }
}

function renderCruz() {
  const tb  = document.getElementById('cruz-tbody')
  const kpi = document.getElementById('cruz-kpis')
  if (!cruzResultados.length) {
    tb.innerHTML = '<tr><td colspan="9" class="empty-state" style="padding:48px">Adicione um preço ou importe um CSV para cruzar</td></tr>'
    kpi.innerHTML = ''
    return
  }

  tb.innerHTML = cruzResultados.map((d, i) => {
    if (d.qtd === 0) {
      return `<tr>
        <td><strong>${d.medida}</strong></td><td>${d.uf}</td><td>${fmtBRL(d.meuPreco)}</td>
        <td colspan="6" style="color:var(--text-muted)">Sem concorrente cadastrado nessa medida/UF</td>
      </tr>`
    }

    const resumo = `<tr style="cursor:pointer" onclick="toggleDetail('cruz-det-${i}')">
      <td><strong>${d.medida}</strong> <span style="color:var(--text-muted);font-size:11px">▸</span></td>
      <td>${d.uf}</td>
      <td>${fmtBRL(d.meuPreco)}</td>
      <td>${fmtBRL(d.menor)}</td>
      <td>${fmtBRL(d.medio)}</td>
      <td>${fmtBRL(d.maior)}</td>
      <td style="font-weight:600;color:${gapColor(d.gap)}">${fmtGap(d.gap)}</td>
      <td>${badgePosicao(d.posicao)}</td>
      <td>${fmtDataMut(d.dataRef)} <span style="color:var(--text-muted);font-size:11px">(${d.qtd})</span></td>
    </tr>`
    const detalhe = detalhePrecoAPreco({ detalhes: d.detalhes, qtd: d.qtd, medio: d.medio, gapMedio: d.gapMedio }, 'cruz-det-' + i)
    return resumo + detalhe
  }).join('')

  const comConc = cruzResultados.filter(d => d.qtd > 0)
  const kpis = [
    { label: 'Linhas cruzadas', value: cruzResultados.length },
    { label: 'Competitivo',     value: comConc.filter(d => d.posicao === 'Competitivo').length },
    { label: 'Acima',           value: comConc.filter(d => d.posicao === 'Acima').length },
    { label: 'Sem concorrente', value: cruzResultados.filter(d => d.qtd === 0).length },
  ]
  kpi.innerHTML = kpis.map(k => `
    <div class="kpi-card"><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div></div>
  `).join('')
}

document.getElementById('cruz-add').addEventListener('click', () => {
  const medida = document.getElementById('cruz-medida').value.trim()
  const uf     = document.getElementById('cruz-uf').value
  const preco  = parseFloat(document.getElementById('cruz-preco').value)
  if (!medida || !preco) { toast('Preencha pelo menos medida e preço', 'error'); return }
  cruzResultados.unshift(cruzarLinha(medida, uf, preco))
  renderCruz()
  document.getElementById('cruz-medida').value = ''
  document.getElementById('cruz-preco').value  = ''
  document.getElementById('cruz-medida').focus()
})

document.getElementById('cruz-preco').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cruz-add').click() }
})

document.getElementById('cruz-limpar').addEventListener('click', () => {
  cruzResultados = []
  renderCruz()
})

document.getElementById('cruz-importar').addEventListener('click', () => document.getElementById('cruz-file').click())

document.getElementById('cruz-file').addEventListener('change', e => {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    const lines = ev.target.result.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { toast('CSV sem dados', 'error'); return }
    const headers = lines[0].split(',').map(h => h.trim().replace(/['"]/g, '').toLowerCase())
    const im = headers.indexOf('medida'), iu = headers.indexOf('uf'), ip = headers.indexOf('preco')
    if (im < 0 || ip < 0) { toast('CSV precisa pelo menos das colunas: medida, preco', 'error'); return }
    let n = 0
    lines.slice(1).forEach(line => {
      const v = line.split(',').map(x => x.trim().replace(/^["']|["']$/g, ''))
      const medida = v[im], uf = iu >= 0 ? (v[iu] || '') : '', preco = parseFloat(v[ip])
      if (medida && preco) { cruzResultados.push(cruzarLinha(medida, uf, preco)); n++ }
    })
    renderCruz()
    toast(`${n} preços cruzados`)
    e.target.value = ''
  }
  reader.readAsText(file, 'UTF-8')
})

// ─── PREÇOS ──────────────────────────────────────────────────────────────────

async function loadPrecos() {
  const { data } = await db.from('precos').select('*').order('created_at', { ascending: false }).limit(500)
  precosRaw = data || []
  renderPrecos()
}

function renderPrecos() {
  const q      = document.getElementById('preco-search').value.toLowerCase()
  const origem = document.getElementById('preco-origem').value
  let dados = precosRaw
  if (q)      dados = dados.filter(d => `${d.medida}${d.marca}${d.fornecedor}`.toLowerCase().includes(q))
  if (origem) dados = dados.filter(d => d.origem === origem)

  const brl = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })

  document.getElementById('precos-tbody').innerHTML = dados.length
    ? dados.map(p => `
      <tr>
        <td><span class="badge ${p.origem === 'Meu' ? 'badge-meu' : 'badge-concorrente'}">${p.origem}</span></td>
        <td><strong>${p.medida}</strong></td>
        <td>${p.marca || '-'}</td>
        <td>${p.fornecedor || '-'}</td>
        <td>${p.uf || '-'}</td>
        <td>${brl(p.preco)}</td>
        <td>${p.fonte || '-'}</td>
        <td>${p.data || '-'}</td>
        <td>
          <button class="btn-icon" onclick="editPreco('${p.id}')">✎</button>
          <button class="btn-icon danger" onclick="deletePreco('${p.id}')">✕</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="empty-state" style="padding:48px">Nenhum registro</td></tr>'
}

document.getElementById('preco-search').addEventListener('input', renderPrecos)
document.getElementById('preco-origem').addEventListener('change', renderPrecos)

document.getElementById('btn-novo-preco').addEventListener('click', () => {
  document.getElementById('form-preco').reset()
  document.getElementById('fp-id').value = ''
  document.getElementById('modal-preco-title').textContent = 'Novo Preço'
  document.getElementById('fp-data').value = new Date().toISOString().split('T')[0]
  openModal('modal-preco')
})

async function editPreco(id) {
  const p = precosRaw.find(x => x.id === id)
  if (!p) return
  document.getElementById('fp-id').value        = p.id
  document.getElementById('fp-origem').value    = p.origem
  document.getElementById('fp-medida').value    = p.medida
  document.getElementById('fp-marca').value     = p.marca || ''
  document.getElementById('fp-descricao').value = p.descricao || ''
  document.getElementById('fp-fornecedor').value = p.fornecedor || ''
  document.getElementById('fp-uf').value        = p.uf || ''
  document.getElementById('fp-preco').value     = p.preco
  document.getElementById('fp-data').value      = p.data
  document.getElementById('fp-fonte').value     = p.fonte || ''
  document.getElementById('fp-categoria').value = p.categoria || ''
  document.getElementById('fp-obs').value       = p.obs || ''
  document.getElementById('modal-preco-title').textContent = 'Editar Preço'
  openModal('modal-preco')
}

async function deletePreco(id) {
  if (!confirm('Excluir este preço?')) return
  const { error } = await db.from('precos').delete().eq('id', id)
  if (error) { toast('Erro ao excluir', 'error'); return }
  toast('Preço excluído')
  await loadPrecos()
  await loadComparativo()
}

document.getElementById('form-preco').addEventListener('submit', async e => {
  e.preventDefault()
  const id = document.getElementById('fp-id').value
  const payload = {
    origem:     document.getElementById('fp-origem').value,
    medida:     medidaCanonica(document.getElementById('fp-medida').value),
    marca:      tituloCase(document.getElementById('fp-marca').value) || null,
    descricao:  document.getElementById('fp-descricao').value.trim() || null,
    fornecedor: document.getElementById('fp-fornecedor').value.trim() || null,
    uf:         document.getElementById('fp-uf').value || null,
    preco:      parseFloat(document.getElementById('fp-preco').value),
    data:       document.getElementById('fp-data').value,
    fonte:      document.getElementById('fp-fonte').value || null,
    categoria:  document.getElementById('fp-categoria').value.trim() || null,
    obs:        document.getElementById('fp-obs').value.trim() || null,
  }

  const { error } = id
    ? await db.from('precos').update(payload).eq('id', id)
    : await db.from('precos').insert(payload)

  if (error) { toast('Erro: ' + error.message, 'error'); return }
  toast(id ? 'Preço atualizado' : 'Preço salvo')
  document.getElementById('modal-preco').classList.add('hidden')
  await loadPrecos()
  await loadComparativo()
})

// ─── EXPORTAR CSV ─────────────────────────────────────────────────────────────

document.getElementById('btn-exportar-csv').addEventListener('click', () => {
  if (!precosRaw.length) { toast('Nenhum dado para exportar', 'error'); return }
  const cols = ['origem','medida','marca','descricao','fornecedor','uf','preco','fonte','data','obs','categoria']
  const rows = [cols.join(','), ...precosRaw.map(p => cols.map(c => `"${p[c] ?? ''}"`).join(','))]
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'mira_precos.csv' })
  a.click()
})

// ─── IMPORTAR CSV ─────────────────────────────────────────────────────────────

document.getElementById('btn-importar-csv').addEventListener('click', () => {
  document.getElementById('csv-file').value = ''
  document.getElementById('csv-preview').style.display = 'none'
  document.getElementById('btn-confirmar-csv').disabled = true
  csvRows = []
  openModal('modal-csv')
})

document.getElementById('csv-file').addEventListener('change', e => {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    const lines = ev.target.result.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { toast('CSV sem dados', 'error'); return }
    const headers = lines[0].split(',').map(h => h.trim().replace(/['"]/g, '').toLowerCase())
    csvRows = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''))
      const row = {}
      headers.forEach((h, i) => row[h] = vals[i] || null)
      return {
        origem:     row.origem || 'Concorrente',
        medida:     medidaCanonica(row.medida),
        marca:      row.marca ? tituloCase(row.marca) : null,
        fornecedor: row.fornecedor || null,
        uf:         row.uf || null,
        preco:      parseFloat(row.preco) || null,
        fonte:      row.fonte || null,
        data:       row.data || new Date().toISOString().split('T')[0],
        obs:        row.obs || null,
        categoria:  row.categoria || null,
      }
    }).filter(r => r.medida && r.preco)

    document.getElementById('csv-count').textContent = `✓ ${csvRows.length} registros válidos`
    document.getElementById('csv-preview').style.display = 'block'
    document.getElementById('btn-confirmar-csv').disabled = csvRows.length === 0
  }
  reader.readAsText(file, 'UTF-8')
})

document.getElementById('btn-confirmar-csv').addEventListener('click', async () => {
  if (!csvRows.length) return
  const { error } = await db.from('precos').insert(csvRows)
  if (error) { toast('Erro na importação: ' + error.message, 'error'); return }
  toast(`${csvRows.length} preços importados com sucesso`)
  document.getElementById('modal-csv').classList.add('hidden')
  await loadPrecos()
  await loadComparativo()
})

// ─── CADASTRO ────────────────────────────────────────────────────────────────

document.getElementById('cad-search').addEventListener('input', () => {
  clearTimeout(cadTimeout)
  cadTimeout = setTimeout(searchCadastro, 400)
})

document.getElementById('cad-classificacao').addEventListener('change', searchCadastro)

async function searchCadastro() {
  const q   = document.getElementById('cad-search').value.trim()
  const cls = document.getElementById('cad-classificacao').value

  if (!q && !cls) {
    document.getElementById('cad-empty').style.display = 'block'
    document.getElementById('cad-table-wrapper').style.display = 'none'
    return
  }

  let query = db.from('cadastro').select('*').limit(100).order('razao_social')
  if (q)   query = query.or(`razao_social.ilike.%${q}%,cnpj.ilike.%${q}%,cidade.ilike.%${q}%`)
  if (cls) query = query.eq('classificacao', cls)

  const { data } = await query
  const cadastros = data || []

  document.getElementById('cad-empty').style.display = 'none'
  document.getElementById('cad-table-wrapper').style.display = 'block'

  const brl = v => v != null ? 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '-'

  document.getElementById('cad-tbody').innerHTML = cadastros.length
    ? cadastros.map(c => `
      <tr>
        <td><strong>${c.razao_social}</strong></td>
        <td>${c.cnpj || '-'}</td>
        <td>${c.classificacao ? badgeClassificacao(c.classificacao) : '-'}</td>
        <td>${[c.cidade, c.uf].filter(Boolean).join('/') || '-'}</td>
        <td>${c.telefone || '-'}</td>
        <td><span class="badge ${c.status === 'Ativo' ? 'badge-ativo' : c.status === 'Inativo' ? 'badge-inativo' : 'badge-atencao'}">${c.status || 'Ativo'}</span></td>
        <td>
          <button class="btn-icon" onclick="editCadastro('${c.id}')">✎</button>
          <button class="btn-icon danger" onclick="deleteCadastro('${c.id}')">✕</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty-state" style="padding:32px">Nenhum resultado</td></tr>'
}

function badgeClassificacao(cls) {
  const map = { 'Cliente': 'badge-cliente', 'Lead': 'badge-lead',
    'Fornecedor Importador': 'badge-fornecedor', 'Fornecedor Nacional': 'badge-fornecedor',
    'Concorrente': 'badge-concorrente' }
  return `<span class="badge ${map[cls] || ''}">${cls}</span>`
}

document.getElementById('btn-novo-cadastro').addEventListener('click', () => {
  document.getElementById('form-cadastro').reset()
  document.getElementById('fc-id').value = ''
  document.getElementById('modal-cad-title').textContent = 'Novo Cadastro'
  openModal('modal-cadastro')
})

async function editCadastro(id) {
  const { data } = await db.from('cadastro').select('*').eq('id', id).single()
  if (!data) return
  document.getElementById('fc-id').value            = data.id
  document.getElementById('fc-razao').value         = data.razao_social || ''
  document.getElementById('fc-cnpj').value          = data.cnpj || ''
  document.getElementById('fc-classificacao').value = data.classificacao || ''
  document.getElementById('fc-status').value        = data.status || 'Ativo'
  document.getElementById('fc-cidade').value        = data.cidade || ''
  document.getElementById('fc-uf').value            = data.uf || ''
  document.getElementById('fc-telefone').value      = data.telefone || ''
  document.getElementById('fc-email').value         = data.email || ''
  document.getElementById('fc-cnae').value          = data.cnae || ''
  document.getElementById('fc-limite').value        = data.limite_credito || ''
  document.getElementById('fc-obs').value           = data.obs || ''
  document.getElementById('modal-cad-title').textContent = 'Editar Cadastro'
  openModal('modal-cadastro')
}

async function deleteCadastro(id) {
  if (!confirm('Excluir este cadastro?')) return
  const { error } = await db.from('cadastro').delete().eq('id', id)
  if (error) { toast('Erro ao excluir', 'error'); return }
  toast('Cadastro excluído')
  searchCadastro()
}

document.getElementById('form-cadastro').addEventListener('submit', async e => {
  e.preventDefault()
  const id = document.getElementById('fc-id').value
  const payload = {
    razao_social:   document.getElementById('fc-razao').value.trim(),
    cnpj:           document.getElementById('fc-cnpj').value.trim() || null,
    classificacao:  document.getElementById('fc-classificacao').value || null,
    status:         document.getElementById('fc-status').value,
    cidade:         document.getElementById('fc-cidade').value.trim() || null,
    uf:             document.getElementById('fc-uf').value || null,
    telefone:       document.getElementById('fc-telefone').value.trim() || null,
    email:          document.getElementById('fc-email').value.trim() || null,
    cnae:           document.getElementById('fc-cnae').value.trim() || null,
    limite_credito: parseFloat(document.getElementById('fc-limite').value) || null,
    obs:            document.getElementById('fc-obs').value.trim() || null,
  }

  const { error } = id
    ? await db.from('cadastro').update(payload).eq('id', id)
    : await db.from('cadastro').insert(payload)

  if (error) { toast('Erro: ' + error.message, 'error'); return }
  toast(id ? 'Cadastro atualizado' : 'Cadastro salvo')
  document.getElementById('modal-cadastro').classList.add('hidden')
  searchCadastro()
})

// ─── HISTÓRICO ───────────────────────────────────────────────────────────────

async function loadHistMedidas() {
  const { data } = await db.from('precos').select('medida').order('medida')
  if (!data) return
  const unicas = [...new Set(data.map(d => d.medida))].sort()
  const sel = document.getElementById('hist-medida')
  sel.innerHTML = '<option value="">Selecione uma medida...</option>'
  unicas.forEach(m => {
    const o = document.createElement('option')
    o.value = o.textContent = m
    sel.appendChild(o)
  })
}

document.getElementById('hist-medida').addEventListener('change', async e => {
  const medida = e.target.value
  if (!medida) {
    document.getElementById('hist-empty').style.display = 'block'
    document.getElementById('hist-content').style.display = 'none'
    return
  }

  const { data } = await db.from('precos').select('*').eq('medida', medida).order('data')
  if (!data?.length) return

  document.getElementById('hist-empty').style.display = 'none'
  document.getElementById('hist-content').style.display = 'block'

  // Agrupar por data para o gráfico
  const dateMap = {}
  data.forEach(p => {
    if (!dateMap[p.data]) dateMap[p.data] = { meu: null, menorConc: null }
    const pr = Number(p.preco)
    if (p.origem === 'Meu' && (!dateMap[p.data].meu || pr < dateMap[p.data].meu))
      dateMap[p.data].meu = pr
    if (p.origem === 'Concorrente' && (!dateMap[p.data].menorConc || pr < dateMap[p.data].menorConc))
      dateMap[p.data].menorConc = pr
  })

  const labels  = Object.keys(dateMap).sort()
  const meuData = labels.map(d => dateMap[d].meu)
  const concData = labels.map(d => dateMap[d].menorConc)

  const css    = getComputedStyle(document.documentElement)
  const cText  = css.getPropertyValue('--text').trim()  || '#e2e8f0'
  const cMuted = css.getPropertyValue('--text-muted').trim() || '#64748b'
  const cGrid  = css.getPropertyValue('--border').trim() || '#2d3250'

  if (histChart) histChart.destroy()
  histChart = new Chart(document.getElementById('hist-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Nosso Preço',        data: meuData,  borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)', tension: 0.3, pointRadius: 4, fill: false, spanGaps: true },
        { label: 'Menor Concorrente',  data: concData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.1)',  tension: 0.3, pointRadius: 4, fill: false, spanGaps: true }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { labels: { color: cText } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: R$ ${ctx.parsed.y?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
          }
        }
      },
      scales: {
        x: { ticks: { color: cMuted }, grid: { color: cGrid } },
        y: {
          ticks: { color: cMuted, callback: v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) },
          grid: { color: cGrid }
        }
      }
    }
  })

  // Tabela
  const menorPorData = {}
  data.filter(p => p.origem === 'Concorrente').forEach(p => {
    const pr = Number(p.preco)
    if (!menorPorData[p.data] || pr < menorPorData[p.data]) menorPorData[p.data] = pr
  })

  const brl = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })

  document.getElementById('hist-tbody').innerHTML = [...data].reverse().map(p => {
    const menor = menorPorData[p.data]
    const gap = p.origem === 'Meu' && menor
      ? (((Number(p.preco) - menor) / menor) * 100).toFixed(1) + '%'
      : '-'
    return `<tr>
      <td>${p.data}</td>
      <td><span class="badge ${p.origem === 'Meu' ? 'badge-meu' : 'badge-concorrente'}">${p.origem}</span></td>
      <td>${p.marca || '-'}</td>
      <td>${p.fornecedor || '-'}</td>
      <td>${brl(p.preco)}</td>
      <td>${gap}</td>
    </tr>`
  }).join('')
})

// ─── CATÁLOGO ────────────────────────────────────────────────────────────────

async function loadCatalogo() {
  const [{ data: m }, { data: ma }] = await Promise.all([
    db.from('ref_medidas').select('*').order('medida'),
    db.from('ref_marcas').select('*').order('marca')
  ])
  medidas = m || []
  marcas  = ma || []
  renderMedidas()
  renderMarcas()
  updateDataLists()
}

function updateDataLists() {
  document.getElementById('dl-medidas').innerHTML = medidas.map(m => `<option value="${m.medida}">`).join('')
  document.getElementById('dl-marcas').innerHTML  = marcas.map(m => `<option value="${m.marca}">`).join('')
}

function renderMedidas() {
  const q = document.getElementById('med-search').value.toLowerCase()
  const filtered = medidas.filter(m => m.medida.toLowerCase().includes(q))
  document.getElementById('medidas-tbody').innerHTML = filtered.length
    ? filtered.map(m => `
      <tr>
        <td><strong>${m.medida}</strong></td>
        <td>${m.categoria || '-'}</td>
        <td>${m.aro || '-'}</td>
        <td>
          <button class="btn-icon" onclick="editMedida('${m.id}')">✎</button>
          <button class="btn-icon danger" onclick="deleteMedida('${m.id}')">✕</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-state" style="padding:32px">Nenhuma medida cadastrada</td></tr>'
}

function renderMarcas() {
  const q = document.getElementById('marc-search').value.toLowerCase()
  const filtered = marcas.filter(m => m.marca.toLowerCase().includes(q))
  document.getElementById('marcas-tbody').innerHTML = filtered.length
    ? filtered.map(m => `
      <tr>
        <td><strong>${m.marca}</strong></td>
        <td>${m.segmento || '-'}</td>
        <td>${m.origem_marca || '-'}</td>
        <td>
          <button class="btn-icon" onclick="editMarca('${m.id}')">✎</button>
          <button class="btn-icon danger" onclick="deleteMarca('${m.id}')">✕</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-state" style="padding:32px">Nenhuma marca cadastrada</td></tr>'
}

document.getElementById('med-search').addEventListener('input', renderMedidas)
document.getElementById('marc-search').addEventListener('input', renderMarcas)

document.querySelectorAll('.cat-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const isMedidas = tab.dataset.cat === 'medidas'
    document.getElementById('cat-medidas').style.display = isMedidas ? 'block' : 'none'
    document.getElementById('cat-marcas').style.display  = isMedidas ? 'none'  : 'block'
  })
})

document.getElementById('btn-nova-medida').addEventListener('click', () => {
  document.getElementById('form-medida').reset()
  document.getElementById('fm-id').value = ''
  document.getElementById('modal-med-title').textContent = 'Nova Medida'
  openModal('modal-medida')
})

function editMedida(id) {
  const m = medidas.find(x => x.id === id)
  if (!m) return
  document.getElementById('fm-id').value       = m.id
  document.getElementById('fm-medida').value   = m.medida
  document.getElementById('fm-categoria').value = m.categoria || ''
  document.getElementById('fm-aro').value      = m.aro || ''
  document.getElementById('modal-med-title').textContent = 'Editar Medida'
  openModal('modal-medida')
}

async function deleteMedida(id) {
  if (!confirm('Excluir esta medida?')) return
  const { error } = await db.from('ref_medidas').delete().eq('id', id)
  if (error) { toast('Erro ao excluir', 'error'); return }
  toast('Medida excluída')
  loadCatalogo()
}

document.getElementById('form-medida').addEventListener('submit', async e => {
  e.preventDefault()
  const id = document.getElementById('fm-id').value
  const payload = {
    medida:    medidaCanonica(document.getElementById('fm-medida').value),
    categoria: document.getElementById('fm-categoria').value.trim() || null,
    aro:       document.getElementById('fm-aro').value.trim() || null,
  }
  const { error } = id
    ? await db.from('ref_medidas').update(payload).eq('id', id)
    : await db.from('ref_medidas').insert(payload)
  if (error) { toast('Erro: ' + error.message, 'error'); return }
  toast(id ? 'Medida atualizada' : 'Medida salva')
  document.getElementById('modal-medida').classList.add('hidden')
  loadCatalogo()
})

document.getElementById('btn-nova-marca').addEventListener('click', () => {
  document.getElementById('form-marca').reset()
  document.getElementById('fmrc-id').value = ''
  document.getElementById('modal-marc-title').textContent = 'Nova Marca'
  openModal('modal-marca')
})

function editMarca(id) {
  const m = marcas.find(x => x.id === id)
  if (!m) return
  document.getElementById('fmrc-id').value      = m.id
  document.getElementById('fmrc-marca').value   = m.marca
  document.getElementById('fmrc-segmento').value = m.segmento || ''
  document.getElementById('fmrc-origem').value  = m.origem_marca || ''
  document.getElementById('modal-marc-title').textContent = 'Editar Marca'
  openModal('modal-marca')
}

async function deleteMarca(id) {
  if (!confirm('Excluir esta marca?')) return
  const { error } = await db.from('ref_marcas').delete().eq('id', id)
  if (error) { toast('Erro ao excluir', 'error'); return }
  toast('Marca excluída')
  loadCatalogo()
}

document.getElementById('form-marca').addEventListener('submit', async e => {
  e.preventDefault()
  const id = document.getElementById('fmrc-id').value
  const payload = {
    marca:        tituloCase(document.getElementById('fmrc-marca').value),
    segmento:     document.getElementById('fmrc-segmento').value || null,
    origem_marca: document.getElementById('fmrc-origem').value || null,
  }
  const { error } = id
    ? await db.from('ref_marcas').update(payload).eq('id', id)
    : await db.from('ref_marcas').insert(payload)
  if (error) { toast('Erro: ' + error.message, 'error'); return }
  toast(id ? 'Marca atualizada' : 'Marca salva')
  document.getElementById('modal-marca').classList.add('hidden')
  loadCatalogo()
})
